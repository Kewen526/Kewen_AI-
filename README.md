# Kewen AI Flow2API Adapter

This package keeps the original Kewen AI static frontend and replaces the old backend with a small FastAPI adapter.

The image generation endpoints call your Flow2API service:

- `nano-banana-2` -> `gemini-3.1-flash-image-*`
- `nano-banana-pro` -> `gemini-3.0-pro-image-*`

If the selected Nano Banana model returns a 5xx error from Flow2API, the adapter automatically retries the other Nano Banana model once. 4xx errors are returned immediately because they usually mean auth, payload, or validation problems.

Video endpoints are intentionally not connected yet and return HTTP 501.

## Run Locally

```bash
cd /path/to/Kewen_AI--main
python -m venv .venv
.venv/Scripts/activate  # Windows
pip install -r requirements.txt
python -m uvicorn server:app --host 0.0.0.0 --port 8088
```

Open:

```text
http://127.0.0.1:8088
```

## Environment

```bash
FLOW2API_URL=http://43.155.157.57:38000/v1/chat/completions
FLOW2API_KEY=han1234
FLOW2API_TIMEOUT=360
```

If these variables are not set, the adapter uses the values above by default.

## Compatible Endpoints

- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /v1/generate`
- `POST /v1/generate/upload`
- `GET /v1/tasks`
- `GET /v1/tasks/{task_id}`
- `GET /v1/transactions`

Uploaded reference images are converted to data URLs and passed to Flow2API in OpenAI-compatible message format.
