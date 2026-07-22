const app = document.getElementById("app");
const tokenKey = "kewen_token";

const state = {
  token: localStorage.getItem(tokenKey),
  user: null,
  authMode: "login",
  view: "studio",
  models: [],
  selectedFamily: "",
  selectedAspect: "",
  selectedResolution: "",
  files: [],
  tasks: [],
  generating: false,
  prompt: "",
  toast: "",
};

const copy = {
  login: "登录",
  register: "注册",
  email: "邮箱",
  username: "用户名",
  password: "密码",
  enter: "进入工作台",
  createAccount: "创建账号",
  logout: "退出",
  studio: "创作台",
  api: "API 接入",
  points: "积分",
  generate: "开始生成",
  generating: "生成中...",
  noModel: "暂无可用模型",
  noPrompt: "请先填写提示词",
  noTasks: "暂无任务记录",
};

const api = async (path, options = {}) => {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text };
    }
  }
  if (!response.ok) {
    throw new Error(data?.detail || data?.error || `HTTP ${response.status}`);
  }
  return data;
};

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));

const uniq = (items) => [...new Set(items.filter(Boolean))];

const apiBaseUrl = () => {
  if (location.hostname === "kewenai.shop" || location.hostname === "www.kewenai.shop") {
    return "https://api.kewenai.shop";
  }
  return location.origin;
};

const toast = (message) => {
  state.toast = message;
  render();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    state.toast = "";
    render();
  }, 3200);
};

const loadModels = async () => {
  const payload = await api("/v1/models");
  state.models = payload.data || [];
  if (!state.prompt) state.prompt = payload.defaults?.prompt || "";
  hydrateModelSelection();
};

const loadUser = async () => {
  if (!state.token) return;
  try {
    state.user = await api("/auth/me");
  } catch {
    localStorage.removeItem(tokenKey);
    state.token = null;
    state.user = null;
  }
};

const loadTasks = async () => {
  if (!state.user) return;
  state.tasks = await api("/v1/tasks?limit=24");
};

const familyOptions = () => {
  const families = new Map();
  state.models.forEach((model) => {
    if (!families.has(model.family_id)) {
      families.set(model.family_id, {
        id: model.family_id,
        name: model.family,
        shortName: model.short_name,
        cost: model.points_cost,
        tier: model.tier,
        description: model.family_id === "nano-banana-pro"
          ? "更适合细节、质感和高要求商品图。"
          : "适合日常商品图、批量任务和快速出图。",
      });
    }
  });
  return [...families.values()];
};

const modelsForFamily = () => state.models.filter((model) => model.family_id === state.selectedFamily);
const aspectOptions = () => uniq(modelsForFamily().map((model) => model.aspect_ratio));
const resolutionOptions = () =>
  uniq(modelsForFamily().filter((model) => model.aspect_ratio === state.selectedAspect).map((model) => model.resolution));

const selectedModel = () => {
  const exact = state.models.find((model) =>
    model.family_id === state.selectedFamily &&
    model.aspect_ratio === state.selectedAspect &&
    model.resolution === state.selectedResolution
  );
  return exact || modelsForFamily()[0] || state.models[0];
};

const hydrateModelSelection = () => {
  const first = state.models[0];
  if (!first) return;
  if (!state.selectedFamily || !state.models.some((model) => model.family_id === state.selectedFamily)) {
    state.selectedFamily = first.family_id;
  }
  const aspects = aspectOptions();
  if (!state.selectedAspect || !aspects.includes(state.selectedAspect)) {
    state.selectedAspect = aspects[0] || first.aspect_ratio;
  }
  const resolutions = resolutionOptions();
  if (!state.selectedResolution || !resolutions.includes(state.selectedResolution)) {
    state.selectedResolution = resolutions[0] || first.resolution;
  }
};

const authSubmit = async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = {
    email: String(form.get("email") || "").trim(),
    password: String(form.get("password") || ""),
  };
  if (state.authMode === "register") body.username = String(form.get("username") || "").trim();

  try {
    const payload = await api(state.authMode === "login" ? "/auth/login" : "/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    state.token = payload.access_token;
    localStorage.setItem(tokenKey, state.token);
    state.user = payload;
    await loadTasks();
    render();
  } catch (error) {
    toast(error.message);
  }
};

const logout = () => {
  localStorage.removeItem(tokenKey);
  state.token = null;
  state.user = null;
  state.tasks = [];
  render();
};

const generate = async () => {
  if (state.generating) return;
  const model = selectedModel();
  if (!model) return toast(copy.noModel);
  if (!state.prompt.trim()) return toast(copy.noPrompt);

  state.generating = true;
  render();
  const started = performance.now();
  try {
    let task;
    if (state.files.length) {
      const form = new FormData();
      form.append("model", model.id);
      form.append("prompt", state.prompt.trim());
      form.append("aspect_ratio", model.aspect_ratio);
      form.append("resolution", model.resolution);
      state.files.forEach((file) => form.append("product_images", file));
      task = await api("/v1/generate/upload", { method: "POST", body: form });
    } else {
      task = await api("/v1/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model.id,
          prompt: state.prompt.trim(),
          aspect_ratio: model.aspect_ratio,
          resolution: model.resolution,
        }),
      });
    }
    state.tasks = [task, ...state.tasks.filter((item) => item.task_id !== task.task_id)];
    await loadUser();
    toast(`生成完成，用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒`);
  } catch (error) {
    toast(error.message);
  } finally {
    state.generating = false;
    render();
  }
};

const latestSuccessfulTask = () => state.tasks.find((task) => task.status === "success" && task.result_image_url);
const successfulTasks = () => state.tasks.filter((task) => task.status === "success" && task.result_image_url).slice(0, 6);
const pendingCount = () => state.tasks.filter((task) => ["pending", "processing"].includes(task.status)).length;
const failedCount = () => state.tasks.filter((task) => task.status === "failed").length;

const renderAuth = () => `
  <main class="auth-view">
    <section class="auth-panel">
      <div class="auth-copy">
        <div class="brand"><div class="brand-mark">K</div><span>Kewen AI</span></div>
        <div class="eyebrow">IMAGE STUDIO AND API</div>
        <h1>商品实拍图生成工作台</h1>
        <p>面向在线创作和系统接入的图片生成服务。网页端给用户简单清晰的创作入口，API 端提供同一套模型能力。</p>
      </div>
      <form class="auth-form" id="auth-form">
        <div class="auth-tabs">
          <button type="button" class="${state.authMode === "login" ? "active" : ""}" data-auth-mode="login">${copy.login}</button>
          <button type="button" class="${state.authMode === "register" ? "active" : ""}" data-auth-mode="register">${copy.register}</button>
        </div>
        <label class="field">
          <span>${copy.email}</span>
          <input name="email" type="email" autocomplete="email" required />
        </label>
        ${state.authMode === "register" ? `
          <label class="field">
            <span>${copy.username}</span>
            <input name="username" autocomplete="username" />
          </label>
        ` : ""}
        <label class="field">
          <span>${copy.password}</span>
          <input name="password" type="password" autocomplete="${state.authMode === "login" ? "current-password" : "new-password"}" required minlength="6" />
        </label>
        <button class="primary-btn stretch" type="submit">${state.authMode === "login" ? copy.enter : copy.createAccount}</button>
      </form>
    </section>
  </main>
`;

const renderFamilyCard = (family) => `
  <button class="model-card ${family.id === state.selectedFamily ? "active" : ""}" data-family-id="${family.id}">
    <span class="badge ${family.tier === "pro" ? "pro" : ""}">${escapeHtml(family.shortName)}</span>
    <span class="model-copy">
      <strong>${escapeHtml(family.name)}</strong>
      <small>${escapeHtml(family.description)}</small>
    </span>
    <span class="cost">${family.cost} 积分</span>
  </button>
`;

const renderSelector = (title, values, selected, attr) => `
  <section class="control-section">
    <div class="section-head">
      <strong>${title}</strong>
    </div>
    <div class="chips">
      ${values.map((value) => `<button class="chip ${value === selected ? "active" : ""}" data-${attr}="${value}">${escapeHtml(value)}</button>`).join("")}
    </div>
  </section>
`;

const renderTask = (task) => {
  const statusText = task.status === "success" ? "完成" : task.status === "failed" ? "失败" : "进行中";
  const statusClass = task.status === "success" ? "ok" : task.status === "failed" ? "failed" : "working";
  return `
    <article class="task-item">
      ${task.result_image_url ? `<img class="task-thumb" src="${escapeHtml(task.result_image_url)}" alt="生成结果" />` : `<div class="task-thumb blank"></div>`}
      <div class="task-body">
        <div class="task-prompt">${escapeHtml(task.prompt_text || task.prompt || "未记录提示词")}</div>
        <div class="task-meta">${escapeHtml(String(task.created_at || "").slice(0, 16).replace("T", " "))} · ${Number(task.points_cost || 0)} 积分</div>
        ${task.error_msg ? `<div class="task-error">${escapeHtml(task.error_msg)}</div>` : ""}
      </div>
      <span class="status ${statusClass}">${statusText}</span>
    </article>
  `;
};

const renderGallery = () => {
  const latest = latestSuccessfulTask();
  const results = successfulTasks();
  if (!latest) {
    return `
      <section class="empty-results">
        <div class="empty-visual"></div>
        <strong>还没有生成结果</strong>
        <span>选择模型、比例和清晰度，输入提示词后开始生成。生成完成后结果会出现在这里。</span>
      </section>
    `;
  }
  return `
    <section class="result-layout">
      <article class="latest-result">
        <div class="result-toolbar">
          <span>最新结果</span>
          <a href="${escapeHtml(latest.result_image_url)}" target="_blank" rel="noreferrer">打开原图</a>
        </div>
        <img src="${escapeHtml(latest.result_image_url)}" alt="最新生成结果" />
      </article>
      <div class="result-grid">
        ${results.map((task) => `
          <a class="result-tile" href="${escapeHtml(task.result_image_url)}" target="_blank" rel="noreferrer">
            <img src="${escapeHtml(task.result_image_url)}" alt="历史生成结果" />
          </a>
        `).join("")}
      </div>
    </section>
  `;
};

const renderStudio = () => {
  const model = selectedModel();
  const families = familyOptions();
  return `
    <main class="studio-shell">
      <section class="studio-header">
        <div>
          <div class="eyebrow">PRODUCT IMAGE WORKSPACE</div>
          <h1>生成商品实拍图</h1>
          <p>选择模型系列、图片比例和清晰度。具体模型由后端能力目录匹配，失败时自动切换同规格备用模型。</p>
        </div>
        <div class="metric-row">
          <div class="metric"><strong>${families.length}</strong><span>模型系列</span></div>
          <div class="metric"><strong>${pendingCount()}</strong><span>进行中</span></div>
          <div class="metric"><strong>${failedCount()}</strong><span>失败任务</span></div>
        </div>
      </section>

      <section class="studio-grid">
        <aside class="control-panel">
          <section class="control-section">
            <div class="section-head">
              <strong>模型</strong>
              <span>后端动态提供</span>
            </div>
            <div class="model-list">
              ${families.map(renderFamilyCard).join("") || `<div class="muted">${copy.noModel}</div>`}
            </div>
          </section>

          ${renderSelector("尺寸", aspectOptions(), state.selectedAspect, "aspect")}
          ${renderSelector("清晰度", resolutionOptions(), state.selectedResolution, "resolution")}

          <section class="control-section">
            <div class="section-head">
              <strong>参考图</strong>
              <span>${state.files.length ? `${state.files.length} 张` : "可选"}</span>
            </div>
            <button class="upload-box" id="pick-files" type="button">
              <span>选择图片</span>
              <small>支持多张参考图</small>
            </button>
            <input id="file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden />
            ${state.files.length ? `<div class="file-list">${state.files.map((file) => `<span>${escapeHtml(file.name)}</span>`).join("")}</div>` : ""}
          </section>

          <div class="config-card">
            <span>当前配置</span>
            <strong>${model ? `${escapeHtml(model.family)} · ${escapeHtml(model.aspect_ratio)} · ${escapeHtml(model.resolution)}` : copy.noModel}</strong>
            <small>${model ? `${model.points_cost} 积分 / 次` : ""}</small>
          </div>
        </aside>

        <section class="compose-panel">
          <div class="prompt-card">
            <div class="section-head">
              <strong>提示词</strong>
              <span id="prompt-count">${state.prompt.length}/900</span>
            </div>
            <textarea id="prompt-input" maxlength="900" placeholder="描述你想生成的商品实拍图，例如：把商品放在真实货架上，保持自然光线和普通手机拍摄质感。">${escapeHtml(state.prompt)}</textarea>
            <div class="prompt-actions">
              <span>生成结果会自动保存到最近任务。</span>
              <button class="primary-btn" id="generate-btn" ${state.generating ? "disabled" : ""}>${state.generating ? copy.generating : copy.generate}</button>
            </div>
          </div>

          ${renderGallery()}
        </section>

        <aside class="activity-panel">
          <div class="section-head">
            <strong>最近任务</strong>
            <span>${state.tasks.length} 条</span>
          </div>
          <div class="task-list">
            ${state.tasks.length ? state.tasks.map(renderTask).join("") : `<div class="muted">${copy.noTasks}</div>`}
          </div>
        </aside>
      </section>
    </main>
  `;
};

const renderApiDocs = () => {
  const base = apiBaseUrl();
  return `
    <main class="api-page">
      <section class="api-hero">
        <div>
          <div class="eyebrow">OPEN API</div>
          <h1>把图片生成接入业务系统</h1>
          <p>API 与网页使用同一套能力目录。先读取 <code>/v1/models</code>，再把返回的模型 ID 用于生成请求。</p>
        </div>
        <div class="api-base">
          <span>Base URL</span>
          <strong>${escapeHtml(base)}</strong>
        </div>
      </section>

      <section class="api-grid">
        <article class="api-card">
          <h2>登录</h2>
          <pre><code>curl -X POST ${escapeHtml(base)}/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"user@example.com","password":"123456"}'</code></pre>
        </article>
        <article class="api-card">
          <h2>模型目录</h2>
          <pre><code>curl ${escapeHtml(base)}/v1/models</code></pre>
        </article>
        <article class="api-card wide">
          <h2>文本生成图片</h2>
          <pre><code>curl -X POST ${escapeHtml(base)}/v1/generate \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "MODEL_ID_FROM_/v1/models",
    "aspect_ratio": "4:3",
    "resolution": "2K",
    "prompt": "生成一张真实自然的商品货架实拍图"
  }'</code></pre>
        </article>
        <article class="api-card wide">
          <h2>上传多张参考图</h2>
          <pre><code>curl -X POST ${escapeHtml(base)}/v1/generate/upload \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -F "model=MODEL_ID_FROM_/v1/models" \\
  -F "aspect_ratio=4:3" \\
  -F "resolution=2K" \\
  -F "prompt=按参考图生成真实商品实拍图" \\
  -F "product_images=@scene.png" \\
  -F "product_images=@product.png"</code></pre>
        </article>
      </section>
    </main>
  `;
};

const renderWorkspace = () => `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand"><div class="brand-mark">K</div><span>Kewen AI</span></div>
      <nav class="main-nav">
        <button class="${state.view === "studio" ? "active" : ""}" data-view="studio">${copy.studio}</button>
        <button class="${state.view === "api" ? "active" : ""}" data-view="api">${copy.api}</button>
      </nav>
      <div class="top-actions">
        <span class="user-email">${escapeHtml(state.user?.email || "")}</span>
        <span class="points">${Number(state.user?.points || 0).toLocaleString("zh-CN")} ${copy.points}</span>
        <button class="ghost-btn" id="logout-btn">${copy.logout}</button>
      </div>
    </header>
    ${state.view === "api" ? renderApiDocs() : renderStudio()}
  </div>
`;

const wireEvents = () => {
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.authMode = button.dataset.authMode;
      render();
    });
  });
  document.getElementById("auth-form")?.addEventListener("submit", authSubmit);
  document.getElementById("logout-btn")?.addEventListener("click", logout);

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      render();
    });
  });

  document.querySelectorAll("[data-family-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedFamily = button.dataset.familyId;
      hydrateModelSelection();
      render();
    });
  });

  document.querySelectorAll("[data-aspect]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedAspect = button.dataset.aspect;
      hydrateModelSelection();
      render();
    });
  });

  document.querySelectorAll("[data-resolution]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedResolution = button.dataset.resolution;
      hydrateModelSelection();
      render();
    });
  });

  const promptInput = document.getElementById("prompt-input");
  promptInput?.addEventListener("input", (event) => {
    state.prompt = event.target.value;
    const note = document.getElementById("prompt-count");
    if (note) note.textContent = `${state.prompt.length}/900`;
  });

  document.getElementById("pick-files")?.addEventListener("click", () => {
    document.getElementById("file-input")?.click();
  });
  document.getElementById("file-input")?.addEventListener("change", (event) => {
    state.files = [...event.target.files];
    render();
  });
  document.getElementById("generate-btn")?.addEventListener("click", generate);
};

const render = () => {
  app.innerHTML = `${state.token && state.user ? renderWorkspace() : renderAuth()}${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""}`;
  wireEvents();
};

const boot = async () => {
  render();
  try {
    await loadModels();
    await loadUser();
    if (state.user) await loadTasks();
  } catch (error) {
    toast(error.message);
  }
  render();
};

boot();
