from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import time
import urllib.parse
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from email.parser import BytesParser
from email.policy import default as email_policy
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.responses import JSONResponse
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


ROOT = Path(__file__).resolve().parent
DIST_DIR = ROOT / "dist"
GENERATED_DIR = ROOT / "generated"
DB_PATH = ROOT / "kewen_ai.db"
GENERATED_DIR.mkdir(parents=True, exist_ok=True)
GENERATED_RETENTION_DAYS = int(os.getenv("GENERATED_RETENTION_DAYS", "7"))
GENERATED_RETENTION_SECONDS = GENERATED_RETENTION_DAYS * 24 * 60 * 60
GENERATED_CLEANUP_INTERVAL_SECONDS = int(os.getenv("GENERATED_CLEANUP_INTERVAL_SECONDS", "21600"))

FLOW2API_URL = os.getenv("FLOW2API_URL", "http://43.155.157.57:38000/v1/chat/completions")
FLOW2API_KEY = os.getenv("FLOW2API_KEY", "han1234")
FLOW2API_TIMEOUT = float(os.getenv("FLOW2API_TIMEOUT", "360"))

SITE_BASE_URL = os.getenv("SITE_BASE_URL", "https://nanobanan.vip").rstrip("/")
API_BASE_URL = os.getenv("API_BASE_URL", "https://api.nanobanan.vip").rstrip("/")
ALLOWED_SITE_HOSTS = {"nanobanan.vip", "www.nanobanan.vip", "api.nanobanan.vip", "kewenai.shop", "www.kewenai.shop", "api.kewenai.shop"}

XUNHUPAY_APPID = os.getenv("XUNHUPAY_APPID", os.getenv("HUPIJAO_APPID", ""))
XUNHUPAY_APP_SECRET = os.getenv("XUNHUPAY_APP_SECRET", os.getenv("HUPIJAO_APP_SECRET", ""))
XUNHUPAY_GATEWAY = os.getenv("XUNHUPAY_GATEWAY", "https://api.xunhupay.com/payment/do.html")
XUNHUPAY_PAYMENT = os.getenv("XUNHUPAY_PAYMENT", "")

REGISTER_BONUS_POINTS = 15
MIN_RECHARGE_YUAN = Decimal("5.00")

IMAGE_COSTS = {
    "nano-banana-2": {
        "1K": 5,
        "2K": 6,
        "4K": 7,
    },
    "nano-banana-pro": {
        "1K": 6,
        "2K": 7,
        "4K": 9,
    },
}

API_KEY_PREFIX = "kwapi_"
PUBLIC_MODEL_PREFIX = "kewen"

MODEL_FAMILIES = {
    "nano-banana-2": {
        "name": "Nano Banana 2",
        "short_name": "N2",
        "description": "Fast image generation for product scenes and daily batch work.",
        "tier": "balanced",
        "cost": 5,
    },
    "nano-banana-pro": {
        "name": "Nano Banana Pro",
        "short_name": "NP",
        "description": "Higher fidelity image generation for stricter detail and texture.",
        "tier": "pro",
        "cost": 6,
    },
}

MODEL_PREFIX = {
    "nano-banana-2": "gemini-3.1-flash-image",
    "nano-banana-pro": "gemini-3.0-pro-image",
}

ASPECT_SUFFIX = {
    "1:1": "square",
    "16:9": "landscape",
    "9:16": "portrait",
    "4:3": "four-three",
    "3:4": "three-four",
}

ASPECT_LABELS = {
    "1:1": "Square",
    "16:9": "Landscape",
    "9:16": "Portrait",
    "4:3": "Four Thirds",
    "3:4": "Three Fourths",
}

RESOLUTIONS = ["1K", "2K", "4K"]


def new_api_key() -> str:
    return API_KEY_PREFIX + secrets.token_urlsafe(32)


class Flow2APIError(RuntimeError):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def init_db() -> None:
    with sqlite3.connect(DB_PATH) as con:
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                username TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                api_key TEXT,
                points INTEGER NOT NULL DEFAULT 1000,
                created_at TEXT NOT NULL
            )
            """
        )
        columns = {row[1] for row in con.execute("PRAGMA table_info(users)").fetchall()}
        if "api_key" not in columns:
            con.execute("ALTER TABLE users ADD COLUMN api_key TEXT")
        for row in con.execute("SELECT id FROM users WHERE api_key IS NULL OR api_key = ''").fetchall():
            con.execute("UPDATE users SET api_key = ? WHERE id = ?", (new_api_key(), row[0]))
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                task_type TEXT NOT NULL,
                model TEXT NOT NULL,
                flow_model TEXT,
                prompt TEXT NOT NULL,
                status TEXT NOT NULL,
                result_image_url TEXT,
                error_msg TEXT,
                points_cost INTEGER NOT NULL DEFAULT 0,
                duration_seconds REAL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                amount REAL NOT NULL,
                balance_after REAL NOT NULL,
                note TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS recharge_orders (
                trade_order_id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                amount_yuan REAL NOT NULL,
                base_points INTEGER NOT NULL,
                bonus_points INTEGER NOT NULL,
                total_points INTEGER NOT NULL,
                status TEXT NOT NULL,
                provider TEXT NOT NULL DEFAULT 'xunhupay',
                provider_transaction_id TEXT,
                pay_url TEXT,
                raw_notify TEXT,
                created_at TEXT NOT NULL,
                paid_at TEXT,
                updated_at TEXT NOT NULL
            )
            """
        )


def db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def password_hash(password: str) -> str:
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def user_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "user_id": row["id"],
        "email": row["email"],
        "username": row["username"],
        "api_key": row["api_key"],
        "points": row["points"],
        "balance": row["points"] / 100,
    }


def issue_session(user_id: int) -> str:
    token = "kw_" + secrets.token_urlsafe(32)
    with db() as con:
        con.execute(
            "INSERT INTO sessions(token, user_id, created_at) VALUES (?, ?, ?)",
            (token, user_id, now_iso()),
        )
    return token


def current_user(authorization: Optional[str] = Header(default=None)) -> dict[str, Any]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    with db() as con:
        if token.startswith(API_KEY_PREFIX):
            row = con.execute("SELECT * FROM users WHERE api_key = ?", (token,)).fetchone()
        else:
            row = con.execute(
                """
                SELECT users.*
                FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.token = ?
                """,
                (token,),
            ).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Invalid bearer token")
    return dict(row)


def normalize_resolution(resolution: str) -> str:
    value = (resolution or "1K").strip().upper()
    return value if value in RESOLUTIONS else "1K"


def public_aspect_token(aspect_ratio: str) -> str:
    return (aspect_ratio or "1:1").replace(":", "x")


def public_model_id(family_id: str, aspect_ratio: str, resolution: str) -> str:
    return f"{PUBLIC_MODEL_PREFIX}-{family_id}-{public_aspect_token(aspect_ratio)}-{normalize_resolution(resolution).lower()}"


def upstream_model_id(family_id: str, aspect_ratio: str, resolution: str) -> str:
    prefix = MODEL_PREFIX[family_id]
    aspect = ASPECT_SUFFIX.get(aspect_ratio or "1:1", "square")
    suffix = "" if normalize_resolution(resolution) == "1K" else f"-{normalize_resolution(resolution).lower()}"
    return f"{prefix}-{aspect}{suffix}"


def public_model_catalog_lookup() -> dict[str, dict[str, Any]]:
    return {model["id"]: model for model in image_model_catalog()}


def model_family_id(model: str) -> Optional[str]:
    if model in MODEL_FAMILIES:
        return model
    public = public_model_catalog_lookup().get(model)
    if public:
        return str(public["family_id"])
    for family_id, prefix in MODEL_PREFIX.items():
        if model.startswith(prefix):
            return family_id
    return None


def map_image_model(model: str, aspect_ratio: str, resolution: str) -> str:
    public = public_model_catalog_lookup().get(model)
    if public:
        return upstream_model_id(str(public["family_id"]), str(public["aspect_ratio"]), str(public["resolution"]))

    if model.startswith("gemini-"):
        return model

    family_id = model_family_id(model)
    if not family_id:
        raise HTTPException(status_code=400, detail=f"Unsupported image model: {model}")

    return upstream_model_id(family_id, aspect_ratio, resolution)


def image_model_catalog() -> list[dict[str, Any]]:
    models: list[dict[str, Any]] = []
    for family_id in MODEL_PREFIX:
        family = MODEL_FAMILIES[family_id]
        for aspect_ratio in ASPECT_SUFFIX:
            for resolution in RESOLUTIONS:
                model_id = public_model_id(family_id, aspect_ratio, resolution)
                models.append(
                    {
                        "id": model_id,
                        "object": "model",
                        "type": "image",
                        "provider": "kewen-ai",
                        "family_id": family_id,
                        "family": family["name"],
                        "short_name": family["short_name"],
                        "name": f"{family['name']} - {aspect_ratio} - {resolution}",
                        "description": family["description"],
                        "tier": family["tier"],
                        "aspect_ratio": aspect_ratio,
                        "aspect_label": ASPECT_LABELS[aspect_ratio],
                        "resolution": resolution,
                        "points_cost": IMAGE_COSTS[family_id][resolution],
                    }
                )
    return models


def model_cost(model: str, resolution: str = "1K") -> int:
    public = public_model_catalog_lookup().get(model)
    if public:
        return int(public["points_cost"])

    family_id = model_family_id(model)
    if family_id:
        return IMAGE_COSTS[family_id][normalize_resolution(resolution)]
    return 5


def equivalent_image_model(model: str) -> Optional[str]:
    public = public_model_catalog_lookup().get(model)
    if public:
        source_family = str(public["family_id"])
        target_family = "nano-banana-2" if source_family == "nano-banana-pro" else "nano-banana-pro"
        return public_model_id(target_family, str(public["aspect_ratio"]), str(public["resolution"]))

    if model in MODEL_FAMILIES:
        return "nano-banana-2" if model == "nano-banana-pro" else "nano-banana-pro"

    for source_family, source_prefix in MODEL_PREFIX.items():
        if not model.startswith(source_prefix):
            continue
        remainder = model[len(source_prefix):]
        target_family = "nano-banana-2" if source_family == "nano-banana-pro" else "nano-banana-pro"
        return f"{MODEL_PREFIX[target_family]}{remainder}"
    return None


def model_attempt_order(model: str) -> list[str]:
    fallback = equivalent_image_model(model)
    return [model, fallback] if fallback and fallback != model else [model]


def upload_to_image_part(filename: str, content: bytes, content_type: Optional[str]) -> dict[str, Any]:
    if not content:
        raise HTTPException(status_code=400, detail=f"Empty upload: {filename}")
    mime = content_type or mimetypes.guess_type(filename or "")[0] or "image/png"
    encoded = base64.b64encode(content).decode("utf-8")
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{mime};base64,{encoded}"},
    }


async def parse_multipart_request(request: Request) -> tuple[dict[str, str], list[dict[str, Any]]]:
    content_type = request.headers.get("content-type", "")
    if "multipart/form-data" not in content_type.lower():
        raise HTTPException(status_code=400, detail="Expected multipart/form-data")

    body = await request.body()
    header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
    message = BytesParser(policy=email_policy).parsebytes(header + body)
    form: dict[str, str] = {}
    files: list[dict[str, Any]] = []

    for part in message.iter_parts():
        disposition_params = {}
        for key, value in part.get_params(header="content-disposition", unquote=True) or []:
            disposition_params[key] = value
        name = disposition_params.get("name")
        filename = disposition_params.get("filename")
        payload = part.get_payload(decode=True) or b""
        if filename:
            files.append(
                upload_to_image_part(
                    filename=filename,
                    content=payload,
                    content_type=part.get_content_type(),
                )
            )
        elif name:
            form[name] = payload.decode("utf-8", errors="replace")

    return form, files


def image_url_part(url: str) -> dict[str, Any]:
    value = (url or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="Image URL cannot be empty")
    return {
        "type": "image_url",
        "image_url": {"url": value},
    }


def default_prompt() -> str:
    return ""


def extension_from_content_type(content_type: str) -> str:
    value = (content_type or "").split(";", 1)[0].strip().lower()
    return {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }.get(value, ".png")


def extract_flow_image_url(payload: dict[str, Any]) -> str:
    generated_assets = payload.get("generated_assets")
    if isinstance(generated_assets, dict):
        for key in ("final_image_url", "origin_image_url"):
            value = generated_assets.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

    value = payload.get("url")
    if isinstance(value, str) and value.strip():
        return value.strip()

    content: Any = None
    try:
        content = payload["choices"][0]["message"]["content"]
    except Exception:
        pass

    if isinstance(content, str):
        match = re.search(r"!\[[^\]]*\]\((https?://[^)]+)\)", content)
        if match:
            return match.group(1).strip()
        match = re.search(r"(https?://\S+)", content)
        if match:
            return match.group(1).strip()

    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            image_url = item.get("image_url")
            if isinstance(image_url, dict) and isinstance(image_url.get("url"), str):
                return image_url["url"].strip()
            if isinstance(item.get("url"), str):
                return item["url"].strip()

    raise RuntimeError(f"No image URL in Flow2API response: {str(payload)[:1000]}")


async def call_flow2api(flow_model: str, prompt: str, image_parts: list[dict[str, Any]]) -> str:
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    content.extend(image_parts)
    payload = {
        "model": flow_model,
        "messages": [{"role": "user", "content": content}],
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {FLOW2API_KEY}",
    }

    async with httpx.AsyncClient(timeout=FLOW2API_TIMEOUT, trust_env=False) as client:
        response = await client.post(FLOW2API_URL, headers=headers, json=payload)

    try:
        data = response.json()
    except Exception:
        data = None

    if response.status_code >= 400:
        message = response.text[:1500]
        if isinstance(data, dict):
            err = data.get("error")
            if isinstance(err, dict):
                message = str(err.get("message") or err)
            elif err:
                message = str(err)
        raise Flow2APIError(response.status_code, message)

    if not isinstance(data, dict):
        raise RuntimeError(f"Flow2API returned non-JSON response: {response.text[:1000]}")
    return extract_flow_image_url(data)


async def cache_generated_image(task_id: str, image_url: str) -> str:
    value = (image_url or "").strip()
    if not value or value.startswith("/generated/") or value.startswith("data:"):
        return value

    try:
        async with httpx.AsyncClient(timeout=60, trust_env=False, follow_redirects=True) as client:
            response = await client.get(value)
        response.raise_for_status()
        if not response.content:
            return value
        ext = extension_from_content_type(response.headers.get("content-type", ""))
        filename = f"{task_id}{ext}"
        (GENERATED_DIR / filename).write_bytes(response.content)
        return f"/generated/{filename}"
    except Exception:
        return value


def generated_image_path(image_url: Optional[str]) -> Optional[Path]:
    value = (image_url or "").strip()
    if not value.startswith("/generated/"):
        return None
    filename = Path(value).name
    if not filename or filename != value.rsplit("/", 1)[-1]:
        return None
    return GENERATED_DIR / filename


def visible_generated_image_url(image_url: Optional[str]) -> Optional[str]:
    path = generated_image_path(image_url)
    if path and not path.is_file():
        return None
    return image_url


def generated_image_expires_at(image_url: Optional[str]) -> Optional[str]:
    path = generated_image_path(image_url)
    if not path or not path.is_file():
        return None
    expires_at = path.stat().st_mtime + GENERATED_RETENTION_SECONDS
    return datetime.fromtimestamp(expires_at, timezone.utc).replace(microsecond=0).isoformat()


def cleanup_generated_images() -> int:
    cutoff = time.time() - GENERATED_RETENTION_SECONDS
    deleted = 0
    for path in GENERATED_DIR.iterdir():
        if not path.is_file():
            continue
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                deleted += 1
        except OSError:
            continue
    return deleted


async def generated_image_cleanup_loop() -> None:
    while True:
        await asyncio.sleep(GENERATED_CLEANUP_INTERVAL_SECONDS)
        cleanup_generated_images()


def task_row_to_payload(row: sqlite3.Row) -> dict[str, Any]:
    result_image_url = visible_generated_image_url(row["result_image_url"])
    return {
        "task_id": row["task_id"],
        "task_type": row["task_type"],
        "model": row["model"],
        "prompt": row["prompt"],
        "prompt_text": row["prompt"],
        "status": row["status"],
        "result_image_url": result_image_url,
        "result_image_expires_at": generated_image_expires_at(result_image_url),
        "image_retention_days": GENERATED_RETENTION_DAYS,
        "error_msg": row["error_msg"],
        "points_cost": row["points_cost"],
        "cost": row["points_cost"] / 100,
        "duration_seconds": row["duration_seconds"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def task_row_to_image_generation(row: sqlite3.Row) -> dict[str, Any]:
    task = task_row_to_payload(row)
    status = "completed" if task["status"] == "success" else "failed" if task["status"] == "failed" else "processing"
    payload: dict[str, Any] = {
        "id": task["task_id"],
        "object": "image.generation",
        "model": task["model"],
        "status": status,
        "created": int(datetime.fromisoformat(task["created_at"]).timestamp()) if task.get("created_at") else int(time.time()),
        "results": [],
        "failure_reason": "",
        "error": "",
    }
    if status == "completed" and task.get("result_image_url"):
        payload["results"] = [
            {
                "url": task["result_image_url"],
                "content": task["prompt"],
                "expires_at": task.get("result_image_expires_at"),
            }
        ]
    if status == "failed":
        payload["failure_reason"] = "provider_error"
        payload["error"] = task.get("error_msg") or "Generation failed"
    return payload


def save_task(user_id: int, payload: dict[str, Any]) -> None:
    with db() as con:
        con.execute(
            """
            INSERT INTO tasks (
                task_id, user_id, task_type, model, flow_model, prompt, status,
                result_image_url, error_msg, points_cost,
                duration_seconds, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["task_id"],
                user_id,
                payload["task_type"],
                payload["model"],
                payload.get("flow_model"),
                payload["prompt"],
                payload["status"],
                payload.get("result_image_url"),
                payload.get("error_msg"),
                payload.get("points_cost", 0),
                payload.get("duration_seconds"),
                payload["created_at"],
                payload["updated_at"],
            ),
        )


def charge_points(user_id: int, points: int, note: str) -> None:
    with db() as con:
        user = con.execute("SELECT points FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            return
        new_points = max(0, int(user["points"]) - points)
        con.execute("UPDATE users SET points = ? WHERE id = ?", (new_points, user_id))
        con.execute(
            """
            INSERT INTO transactions(user_id, type, amount, balance_after, note, created_at)
            VALUES (?, 'deduct', ?, ?, ?, ?)
            """,
            (user_id, -points / 100, new_points / 100, note, now_iso()),
        )


def parse_money(value: Any) -> Decimal:
    try:
        amount = Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        raise HTTPException(status_code=400, detail="Invalid recharge amount")
    if amount < MIN_RECHARGE_YUAN:
        raise HTTPException(status_code=400, detail="Minimum recharge amount is 5 yuan")
    if amount > Decimal("100000.00"):
        raise HTTPException(status_code=400, detail="Recharge amount is too large")
    return amount


def recharge_bonus_points(amount: Decimal) -> int:
    if amount >= Decimal("1000.00"):
        return 6000
    if amount >= Decimal("100.00"):
        return 500
    if amount >= Decimal("10.00"):
        return 30
    return 0


def recharge_points(amount: Decimal) -> tuple[int, int, int]:
    base_points = int((amount * Decimal("100")).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    bonus_points = recharge_bonus_points(amount)
    return base_points, bonus_points, base_points + bonus_points


def xunhupay_hash(params: dict[str, Any]) -> str:
    if not XUNHUPAY_APP_SECRET:
        raise HTTPException(status_code=500, detail="XunHuPay secret is not configured")
    filtered = {
        str(key): str(value)
        for key, value in params.items()
        if key not in {"hash", "sign"} and value is not None and str(value) != ""
    }
    payload = "&".join(f"{key}={filtered[key]}" for key in sorted(filtered))
    return hashlib.md5((payload + XUNHUPAY_APP_SECRET).encode("utf-8")).hexdigest()


def verify_xunhupay_hash(params: dict[str, Any]) -> bool:
    received = str(params.get("hash") or params.get("sign") or "").lower()
    if not received:
        return False
    expected = xunhupay_hash(params)
    return secrets.compare_digest(received, expected)


def recharge_order_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "trade_order_id": row["trade_order_id"],
        "amount_yuan": row["amount_yuan"],
        "base_points": row["base_points"],
        "bonus_points": row["bonus_points"],
        "total_points": row["total_points"],
        "status": row["status"],
        "pay_url": row["pay_url"],
        "created_at": row["created_at"],
        "paid_at": row["paid_at"],
        "updated_at": row["updated_at"],
    }


async def parse_payment_callback(request: Request) -> dict[str, str]:
    body = await request.body()
    content_type = request.headers.get("content-type", "").lower()
    if "application/json" in content_type:
        try:
            data = json.loads(body.decode("utf-8"))
        except Exception:
            data = {}
        return {str(key): str(value) for key, value in data.items()}
    parsed = urllib.parse.parse_qsl(body.decode("utf-8", errors="replace"), keep_blank_values=True)
    return {str(key): str(value) for key, value in parsed}


def payment_return_base_url(request: Request) -> str:
    for header_name in ("origin", "referer"):
        raw_value = request.headers.get(header_name, "")
        if not raw_value:
            continue
        parsed = urllib.parse.urlparse(raw_value)
        if parsed.scheme in {"http", "https"} and parsed.netloc in ALLOWED_SITE_HOSTS:
            return f"{parsed.scheme}://{parsed.netloc}"

    host = request.headers.get("host", "")
    if host in ALLOWED_SITE_HOSTS:
        scheme = request.headers.get("x-forwarded-proto") or request.url.scheme or "https"
        return f"{scheme}://{host}"

    return SITE_BASE_URL


class AuthRequest(BaseModel):
    email: str
    password: str
    username: Optional[str] = None


class GenerateRequest(BaseModel):
    model: str = "nano-banana-2"
    prompt: Optional[str] = None
    aspect_ratio: str = "1:1"
    resolution: str = "1K"
    output_format: str = "PNG"
    product_image_url: Optional[str] = None
    scene_image_url: Optional[str] = None
    image_urls: Optional[list[str]] = None


class ImageGenerationRequest(BaseModel):
    model: str = "nano-banana-2"
    prompt: str
    aspect_ratio: str = "1:1"
    image_size: str = "1K"
    image_urls: Optional[list[str]] = None
    webhook_url: Optional[str] = None


class RechargeRequest(BaseModel):
    amount_yuan: float


app = FastAPI(title="Kewen AI Flow2API Adapter")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup() -> None:
    init_db()
    cleanup_generated_images()
    asyncio.create_task(generated_image_cleanup_loop())


@app.post("/auth/register")
def register(body: AuthRequest) -> dict[str, Any]:
    email = body.email.strip().lower()
    username = (body.username or email.split("@")[0]).strip()
    if not email or not body.password:
        raise HTTPException(status_code=400, detail="Email and password are required")
    try:
        with db() as con:
            cur = con.execute(
                """
                INSERT INTO users(email, username, password_hash, api_key, points, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (email, username, password_hash(body.password), new_api_key(), REGISTER_BONUS_POINTS, now_iso()),
            )
            user_id = cur.lastrowid
            con.execute(
                """
                INSERT INTO transactions(user_id, type, amount, balance_after, note, created_at)
                VALUES (?, 'register_bonus', ?, ?, ?, ?)
                """,
                (
                    user_id,
                    REGISTER_BONUS_POINTS / 100,
                    REGISTER_BONUS_POINTS / 100,
                    "New user bonus",
                    now_iso(),
                ),
            )
            row = con.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="Email already registered")
    token = issue_session(int(user_id))
    payload = user_payload(row)
    payload["access_token"] = token
    payload["token_type"] = "bearer"
    return payload


@app.post("/auth/login")
def login(body: AuthRequest) -> dict[str, Any]:
    email = body.email.strip().lower()
    with db() as con:
        row = con.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row or row["password_hash"] != password_hash(body.password):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = issue_session(int(row["id"]))
    payload = user_payload(row)
    payload["access_token"] = token
    payload["token_type"] = "bearer"
    return payload


@app.get("/auth/me")
def me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {
        "id": user["id"],
        "email": user["email"],
        "username": user["username"],
        "api_key": user["api_key"],
        "points": user["points"],
        "balance": user["points"] / 100,
    }


@app.post("/auth/api-key")
def rotate_api_key(user: dict[str, Any] = Depends(current_user)) -> dict[str, str]:
    api_key = new_api_key()
    with db() as con:
        con.execute("UPDATE users SET api_key = ? WHERE id = ?", (api_key, user["id"]))
    return {"api_key": api_key}


@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    models = image_model_catalog()
    return {
        "object": "list",
        "type": "image",
        "image_retention_days": GENERATED_RETENTION_DAYS,
        "data": models,
        "defaults": {
            "model": models[0]["id"] if models else None,
            "prompt": default_prompt(),
        },
    }


@app.get("/v1/tasks")
def list_tasks(
    limit: int = 50,
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    with db() as con:
        rows = con.execute(
            "SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user["id"], max(1, min(limit, 200))),
        ).fetchall()
    return [task_row_to_payload(row) for row in rows]


@app.get("/v1/tasks/{task_id}")
def get_task(task_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    with db() as con:
        row = con.execute(
            "SELECT * FROM tasks WHERE task_id = ? AND user_id = ?",
            (task_id, user["id"]),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    return task_row_to_payload(row)


@app.get("/v1/transactions")
def list_transactions(
    limit: int = 50,
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    with db() as con:
        rows = con.execute(
            """
            SELECT type, amount, balance_after, note, created_at
            FROM transactions
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (user["id"], max(1, min(limit, 200))),
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/payment/recharge/options")
def recharge_options() -> dict[str, Any]:
    packages = []
    for amount in (Decimal("5.00"), Decimal("10.00"), Decimal("100.00"), Decimal("1000.00")):
        base_points, bonus_points, total_points = recharge_points(amount)
        packages.append(
            {
                "amount_yuan": float(amount),
                "base_points": base_points,
                "bonus_points": bonus_points,
                "total_points": total_points,
            }
        )
    return {
        "provider": "payment",
        "minimum_amount_yuan": float(MIN_RECHARGE_YUAN),
        "points_per_yuan": 100,
        "bonus_rules": [
            {"min_yuan": 10, "max_yuan": 99.99, "bonus_points": 30},
            {"min_yuan": 100, "max_yuan": 999.99, "bonus_points": 500},
            {"min_yuan": 1000, "max_yuan": None, "bonus_points": 6000},
        ],
        "packages": packages,
    }


@app.get("/payment/recharge/orders")
def list_recharge_orders(
    limit: int = 20,
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    with db() as con:
        rows = con.execute(
            """
            SELECT *
            FROM recharge_orders
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (user["id"], max(1, min(limit, 100))),
        ).fetchall()
    return [recharge_order_payload(row) for row in rows]


@app.get("/payment/recharge/orders/{trade_order_id}")
def get_recharge_order(
    trade_order_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    with db() as con:
        row = con.execute(
            "SELECT * FROM recharge_orders WHERE trade_order_id = ? AND user_id = ?",
            (trade_order_id, user["id"]),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Recharge order not found")
    return recharge_order_payload(row)


@app.post("/payment/recharge")
async def create_recharge(
    body: RechargeRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    if not XUNHUPAY_APPID or not XUNHUPAY_APP_SECRET:
        raise HTTPException(status_code=500, detail="XunHuPay is not configured")

    amount = parse_money(body.amount_yuan)
    base_points, bonus_points, total_points = recharge_points(amount)
    trade_order_id = f"NB{int(time.time())}{user['id']}{secrets.token_hex(4)}"
    created_at = now_iso()

    params: dict[str, Any] = {
        "version": "1.1",
        "appid": XUNHUPAY_APPID,
        "trade_order_id": trade_order_id,
        "total_fee": f"{amount:.2f}",
        "title": f"NanoBanan {total_points} points",
        "time": str(int(time.time())),
        "notify_url": f"{API_BASE_URL}/payment/hupijiao/notify",
        "return_url": f"{payment_return_base_url(request)}/?payment=return&trade_order_id={trade_order_id}",
        "nonce_str": secrets.token_hex(16),
        "plugins": "kewen-ai",
    }
    if XUNHUPAY_PAYMENT:
        params["payment"] = XUNHUPAY_PAYMENT
    params["hash"] = xunhupay_hash(params)

    with db() as con:
        con.execute(
            """
            INSERT INTO recharge_orders(
                trade_order_id, user_id, amount_yuan, base_points, bonus_points,
                total_points, status, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
            """,
            (
                trade_order_id,
                user["id"],
                float(amount),
                base_points,
                bonus_points,
                total_points,
                created_at,
                created_at,
            ),
        )

    try:
        async with httpx.AsyncClient(timeout=30, trust_env=False, follow_redirects=True) as client:
            response = await client.post(XUNHUPAY_GATEWAY, json=params)
        data = response.json()
    except Exception as exc:
        with db() as con:
            con.execute(
                "UPDATE recharge_orders SET status = 'failed', updated_at = ? WHERE trade_order_id = ?",
                (now_iso(), trade_order_id),
            )
        raise HTTPException(status_code=502, detail=f"Payment gateway request failed: {exc}")

    errcode = data.get("errcode", data.get("code", 0)) if isinstance(data, dict) else 0
    success_code = str(errcode) in {"0", "200", "success", "SUCCESS"}
    if response.status_code >= 400 or not isinstance(data, dict) or not success_code:
        message = data.get("errmsg") or data.get("message") or response.text[:500] if isinstance(data, dict) else response.text[:500]
        with db() as con:
            con.execute(
                "UPDATE recharge_orders SET status = 'failed', updated_at = ? WHERE trade_order_id = ?",
                (now_iso(), trade_order_id),
            )
        raise HTTPException(status_code=502, detail=f"Payment gateway rejected order: {message}")

    pay_url = (
        data.get("url")
        or data.get("pay_url")
        or data.get("payment_url")
        or data.get("code_url")
        or data.get("qrcode")
        or data.get("qr_code")
        or data.get("url_qrcode")
    )
    with db() as con:
        con.execute(
            "UPDATE recharge_orders SET pay_url = ?, updated_at = ? WHERE trade_order_id = ?",
            (str(pay_url or ""), now_iso(), trade_order_id),
        )

    return {
        "trade_order_id": trade_order_id,
        "amount_yuan": float(amount),
        "base_points": base_points,
        "bonus_points": bonus_points,
        "total_points": total_points,
        "status": "pending",
        "payment_url": pay_url,
        "gateway_response": data,
    }


def update_task(task_id: str, payload: dict[str, Any]) -> None:
    assignments = []
    values: list[Any] = []
    for key in ("status", "flow_model", "result_image_url", "error_msg", "points_cost", "duration_seconds", "updated_at"):
        if key in payload:
            assignments.append(f"{key} = ?")
            values.append(payload[key])
    if not assignments:
        return
    values.append(task_id)
    with db() as con:
        con.execute(f"UPDATE tasks SET {', '.join(assignments)} WHERE task_id = ?", values)


def get_task_for_user(task_id: str, user_id: int) -> Optional[sqlite3.Row]:
    with db() as con:
        return con.execute(
            "SELECT * FROM tasks WHERE task_id = ? AND user_id = ?",
            (task_id, user_id),
        ).fetchone()


@app.post("/payment/hupijiao/notify")
async def hupijiao_notify(request: Request) -> PlainTextResponse:
    data = await parse_payment_callback(request)
    if not data or not verify_xunhupay_hash(data):
        return PlainTextResponse("fail", status_code=400)
    if data.get("appid") and data.get("appid") != XUNHUPAY_APPID:
        return PlainTextResponse("fail", status_code=400)

    trade_order_id = data.get("trade_order_id") or data.get("out_trade_no") or ""
    status = (data.get("status") or data.get("trade_status") or "").upper()
    if not trade_order_id:
        return PlainTextResponse("fail", status_code=400)

    with db() as con:
        order = con.execute(
            "SELECT * FROM recharge_orders WHERE trade_order_id = ?",
            (trade_order_id,),
        ).fetchone()
        if not order:
            return PlainTextResponse("fail", status_code=404)
        if order["status"] == "paid":
            return PlainTextResponse("success")
        if status != "OD":
            con.execute(
                "UPDATE recharge_orders SET raw_notify = ?, updated_at = ? WHERE trade_order_id = ?",
                (json.dumps(data, ensure_ascii=False), now_iso(), trade_order_id),
            )
            return PlainTextResponse("success")

        notified_amount = parse_money(data.get("total_fee") or data.get("money") or order["amount_yuan"])
        expected_amount = Decimal(str(order["amount_yuan"])).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        if notified_amount != expected_amount:
            con.execute(
                "UPDATE recharge_orders SET raw_notify = ?, updated_at = ? WHERE trade_order_id = ?",
                (json.dumps(data, ensure_ascii=False), now_iso(), trade_order_id),
            )
            return PlainTextResponse("fail", status_code=400)

        user_row = con.execute("SELECT points FROM users WHERE id = ?", (order["user_id"],)).fetchone()
        if not user_row:
            return PlainTextResponse("fail", status_code=404)

        paid_at = now_iso()
        new_points = int(user_row["points"]) + int(order["total_points"])
        con.execute("UPDATE users SET points = ? WHERE id = ?", (new_points, order["user_id"]))
        con.execute(
            """
            UPDATE recharge_orders
            SET status = 'paid',
                provider_transaction_id = ?,
                raw_notify = ?,
                paid_at = ?,
                updated_at = ?
            WHERE trade_order_id = ?
            """,
            (
                data.get("transaction_id") or data.get("open_order_id") or data.get("order_id"),
                json.dumps(data, ensure_ascii=False),
                paid_at,
                paid_at,
                trade_order_id,
            ),
        )
        con.execute(
            """
            INSERT INTO transactions(user_id, type, amount, balance_after, note, created_at)
            VALUES (?, 'recharge', ?, ?, ?, ?)
            """,
            (
                order["user_id"],
                float(expected_amount),
                new_points / 100,
                f"Recharge {trade_order_id}: +{order['total_points']} points",
                paid_at,
            ),
        )

    return PlainTextResponse("success")


async def create_image_task(
    user: dict[str, Any],
    model: str,
    prompt: str,
    aspect_ratio: str,
    resolution: str,
    image_parts: list[dict[str, Any]],
) -> dict[str, Any]:
    started = time.monotonic()
    created_at = now_iso()
    task_id = "task_" + secrets.token_urlsafe(12)
    cost = model_cost(model, resolution)
    attempted_errors: list[str] = []

    try:
        image_url = ""
        actual_model = model
        actual_flow_model = ""
        for candidate_model in model_attempt_order(model):
            flow_model = map_image_model(candidate_model, aspect_ratio, resolution)
            try:
                image_url = await call_flow2api(flow_model, prompt, image_parts)
                image_url = await cache_generated_image(task_id, image_url)
                actual_model = candidate_model
                actual_flow_model = flow_model
                break
            except Flow2APIError as exc:
                attempted_errors.append(f"{candidate_model}: HTTP {exc.status_code} {exc.message}")
                if exc.status_code < 500:
                    raise
                continue

        if not image_url:
            raise RuntimeError("All model attempts failed: " + " | ".join(attempted_errors))

        cost = model_cost(actual_model, resolution)
        duration = time.monotonic() - started
        task = {
            "task_id": task_id,
            "task_type": "image",
            "model": actual_model,
            "flow_model": actual_flow_model,
            "prompt": prompt,
            "status": "success",
            "result_image_url": image_url,
            "result_image_expires_at": generated_image_expires_at(image_url),
            "image_retention_days": GENERATED_RETENTION_DAYS,
            "points_cost": cost,
            "duration_seconds": duration,
            "created_at": created_at,
            "updated_at": now_iso(),
        }
        save_task(user["id"], task)
        charge_points(user["id"], cost, f"Image generation: {model}")
        return task
    except Exception as exc:
        duration = time.monotonic() - started
        task = {
            "task_id": task_id,
            "task_type": "image",
            "model": model,
            "flow_model": attempted_errors[-1].split(":", 1)[0] if attempted_errors else None,
            "prompt": prompt,
            "status": "failed",
            "error_msg": (" | ".join(attempted_errors) or str(exc))[:1000],
            "points_cost": 0,
            "duration_seconds": duration,
            "created_at": created_at,
            "updated_at": now_iso(),
        }
        save_task(user["id"], task)
        raise HTTPException(status_code=500, detail=task["error_msg"])


@app.post("/v1/images/generations")
async def submit_image_generation(
    body: ImageGenerationRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    prompt = (body.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")
    aspect_ratio = "1:1" if body.aspect_ratio == "auto" else body.aspect_ratio
    if aspect_ratio not in ASPECT_SUFFIX:
        raise HTTPException(status_code=400, detail=f"Unsupported aspect_ratio: {body.aspect_ratio}")
    resolution = normalize_resolution(body.image_size)
    model = body.model or "nano-banana-2"
    if not model_family_id(model) and model not in public_model_catalog_lookup():
        raise HTTPException(status_code=400, detail=f"Unsupported image model: {model}")

    created_at = now_iso()
    task_id = "img_" + secrets.token_urlsafe(16)
    image_parts = [image_url_part(url) for url in (body.image_urls or []) if url]
    task = {
        "task_id": task_id,
        "task_type": "image",
        "model": model,
        "flow_model": None,
        "prompt": prompt,
        "status": "processing",
        "result_image_url": None,
        "error_msg": None,
        "points_cost": model_cost(model, resolution),
        "duration_seconds": None,
        "created_at": created_at,
        "updated_at": created_at,
    }
    save_task(user["id"], task)
    asyncio.create_task(
        run_async_image_generation(
            user_id=user["id"],
            task_id=task_id,
            model=model,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            resolution=resolution,
            image_parts=image_parts,
            webhook_url=body.webhook_url,
        )
    )
    return {
        "id": task_id,
        "object": "image.generation",
        "model": model,
        "status": "processing",
        "created": int(datetime.fromisoformat(created_at).timestamp()),
    }


@app.get("/v1/images/{image_id}")
async def get_image_generation(image_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    row = get_task_for_user(image_id, user["id"])
    if not row:
        raise HTTPException(status_code=404, detail="Image generation not found")
    return task_row_to_image_generation(row)


async def deliver_image_webhook(webhook_url: Optional[str], payload: dict[str, Any]) -> None:
    if not webhook_url:
        return
    parsed = urllib.parse.urlparse(webhook_url)
    if parsed.scheme != "https" or not parsed.netloc:
        return
    headers = {
        "Content-Type": "application/json",
        "X-Kewen-Event": f"image.generation.{payload.get('status', 'unknown')}",
        "X-Kewen-Invocation-Id": str(payload.get("id", "")),
        "X-Kewen-Attempt": "1",
    }
    try:
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            await client.post(webhook_url, headers=headers, json=payload)
    except Exception:
        return


async def run_async_image_generation(
    user_id: int,
    task_id: str,
    model: str,
    prompt: str,
    aspect_ratio: str,
    resolution: str,
    image_parts: list[dict[str, Any]],
    webhook_url: Optional[str],
) -> None:
    started = time.monotonic()
    attempted_errors: list[str] = []
    try:
        image_url = ""
        actual_model = model
        actual_flow_model = ""
        for candidate_model in model_attempt_order(model):
            flow_model = map_image_model(candidate_model, aspect_ratio, resolution)
            try:
                image_url = await call_flow2api(flow_model, prompt, image_parts)
                image_url = await cache_generated_image(task_id, image_url)
                actual_model = candidate_model
                actual_flow_model = flow_model
                break
            except Flow2APIError as exc:
                attempted_errors.append(f"{candidate_model}: HTTP {exc.status_code} {exc.message}")
                if exc.status_code < 500:
                    raise
                continue

        if not image_url:
            raise RuntimeError("All model attempts failed: " + " | ".join(attempted_errors))

        cost = model_cost(actual_model, resolution)
        update_task(
            task_id,
            {
                "status": "success",
                "flow_model": actual_flow_model,
                "result_image_url": image_url,
                "error_msg": None,
                "points_cost": cost,
                "duration_seconds": time.monotonic() - started,
                "updated_at": now_iso(),
            },
        )
        charge_points(user_id, cost, f"Image generation: {actual_model}")
    except Exception as exc:
        update_task(
            task_id,
            {
                "status": "failed",
                "error_msg": (" | ".join(attempted_errors) or str(exc))[:1000],
                "points_cost": 0,
                "duration_seconds": time.monotonic() - started,
                "updated_at": now_iso(),
            },
        )

    with db() as con:
        row = con.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
    if row:
        await deliver_image_webhook(webhook_url, task_row_to_image_generation(row))


@app.post("/v1/generate")
async def generate_image(
    body: GenerateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    image_parts: list[dict[str, Any]] = []
    if body.scene_image_url:
        image_parts.append(image_url_part(body.scene_image_url))
    if body.product_image_url:
        image_parts.append(image_url_part(body.product_image_url))
    if body.image_urls:
        image_parts.extend(image_url_part(url) for url in body.image_urls if url)

    return await create_image_task(
        user=user,
        model=body.model,
        prompt=body.prompt or default_prompt(),
        aspect_ratio=body.aspect_ratio,
        resolution=body.resolution,
        image_parts=image_parts,
    )


@app.post("/v1/generate/upload")
async def generate_image_upload(
    request: Request,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    form, image_parts = await parse_multipart_request(request)
    return await create_image_task(
        user=user,
        model=form.get("model", "nano-banana-2"),
        prompt=form.get("prompt") or default_prompt(),
        aspect_ratio=form.get("aspect_ratio", "1:1"),
        resolution=form.get("resolution", "1K"),
        image_parts=image_parts,
    )


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.head("/healthz")
def healthz_head() -> JSONResponse:
    return JSONResponse(content=None, status_code=200)


if DIST_DIR.exists():
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")

app.mount("/generated", StaticFiles(directory=GENERATED_DIR), name="generated")


@app.head("/{path:path}")
def spa_head(path: str) -> FileResponse:
    target = DIST_DIR / path
    if path and target.is_file():
        return FileResponse(target)
    return FileResponse(DIST_DIR / "index.html")


@app.get("/{path:path}")
def spa(path: str) -> FileResponse:
    target = DIST_DIR / path
    if path and target.is_file():
        return FileResponse(target)
    return FileResponse(DIST_DIR / "index.html")
