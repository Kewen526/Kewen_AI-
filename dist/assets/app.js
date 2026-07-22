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

const t = {
  login: "登录",
  register: "注册",
  email: "邮箱",
  username: "用户名",
  password: "密码",
  enter: "进入工作台",
  createAccount: "创建账号",
  logout: "退出",
  studio: "创作",
  api: "API 接入",
  points: "积分",
  modelSeries: "模型",
  aspect: "尺寸",
  resolution: "清晰度",
  prompt: "提示词",
  references: "参考图",
  chooseImages: "选择图片",
  generate: "生成",
  generating: "生成中",
  recentTasks: "最近任务",
  noTasks: "暂无任务记录",
  noModel: "当前没有可用模型",
  noPrompt: "请先填写提示词",
  done: "生成完成",
  emptyTitle: "等待第一张图片生成",
  emptyDesc: "选择模型、尺寸、清晰度，填写提示词后开始生成。",
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

const toast = (message) => {
  state.toast = message;
  render();
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
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

const hydrateModelSelection = () => {
  const first = state.models[0];
  if (!first) return;
  if (!state.selectedFamily || !state.models.some((m) => m.family_id === state.selectedFamily)) {
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
  if (!state.token) return;
  state.tasks = await api("/v1/tasks?limit=30");
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
        description: model.description,
      });
    }
  });
  return [...families.values()];
};

const modelsForFamily = () => state.models.filter((model) => model.family_id === state.selectedFamily);
const aspectOptions = () => uniq(modelsForFamily().map((model) => model.aspect_ratio));
const resolutionOptions = () => uniq(modelsForFamily().filter((model) => model.aspect_ratio === state.selectedAspect).map((model) => model.resolution));

const selectedModel = () => {
  const exact = state.models.find((model) =>
    model.family_id === state.selectedFamily &&
    model.aspect_ratio === state.selectedAspect &&
    model.resolution === state.selectedResolution
  );
  return exact || modelsForFamily()[0] || state.models[0];
};

const authSubmit = async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = {
    email: String(form.get("email") || "").trim(),
    password: String(form.get("password") || ""),
  };
  if (state.authMode === "register") {
    body.username = String(form.get("username") || body.email.split("@")[0]).trim();
  }
  try {
    const result = await api(`/auth/${state.authMode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    state.token = result.access_token;
    localStorage.setItem(tokenKey, state.token);
    state.user = result;
    await Promise.all([loadModels(), loadTasks()]);
    render();
  } catch (error) {
    toast(error.message);
  }
};

const generate = async () => {
  if (state.generating) return;
  if (!state.prompt.trim()) {
    toast(t.noPrompt);
    return;
  }
  const model = selectedModel();
  if (!model) {
    toast(t.noModel);
    return;
  }

  state.generating = true;
  render();
  try {
    let task;
    if (state.files.length) {
      const form = new FormData();
      form.append("model", model.id);
      form.append("prompt", state.prompt);
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
          prompt: state.prompt,
          aspect_ratio: model.aspect_ratio,
          resolution: model.resolution,
        }),
      });
    }
    state.tasks = [task, ...state.tasks.filter((item) => item.task_id !== task.task_id)];
    await loadUser();
    toast(t.done);
  } catch (error) {
    toast(error.message);
    await loadTasks().catch(() => {});
  } finally {
    state.generating = false;
    render();
  }
};

const logout = () => {
  localStorage.removeItem(tokenKey);
  state.token = null;
  state.user = null;
  state.tasks = [];
  render();
};

const apiBaseUrl = () => `${window.location.origin}`;
const latestSuccessfulTask = () => state.tasks.find((task) => task.status === "success" && task.result_image_url);

const renderAuth = () => `
  <main class="auth-view">
    <section class="auth-panel">
      <div class="auth-copy">
        <div class="brand"><div class="brand-mark">K</div><span>Kewen AI</span></div>
        <div class="eyebrow" style="margin-top:42px">IMAGE API PLATFORM</div>
        <h1>为商品图生成而设计的 AI 工作台</h1>
        <p>面向 C 端用户的在线创作入口，同时提供可集成的开放 API。模型、尺寸和清晰度都由后端能力目录统一控制。</p>
      </div>
      <form class="auth-form" id="auth-form">
        <div class="auth-tabs">
          <button type="button" class="${state.authMode === "login" ? "active" : ""}" data-auth-mode="login">${t.login}</button>
          <button type="button" class="${state.authMode === "register" ? "active" : ""}" data-auth-mode="register">${t.register}</button>
        </div>
        <div class="field">
          <label>${t.email}</label>
          <input name="email" type="email" autocomplete="email" required />
        </div>
        ${state.authMode === "register" ? `
          <div class="field">
            <label>${t.username}</label>
            <input name="username" autocomplete="username" />
          </div>
        ` : ""}
        <div class="field">
          <label>${t.password}</label>
          <input name="password" type="password" autocomplete="${state.authMode === "login" ? "current-password" : "new-password"}" required minlength="6" />
        </div>
        <button class="primary-btn" type="submit">${state.authMode === "login" ? t.enter : t.createAccount}</button>
      </form>
    </section>
  </main>
`;

const renderFamilyCard = (family) => `
  <button class="model-card ${family.id === state.selectedFamily ? "active" : ""}" data-family-id="${family.id}">
    <div class="model-top">
      <span class="badge ${family.tier === "pro" ? "pro" : ""}">${escapeHtml(family.shortName)}</span>
      <span class="section-note">${family.cost} ${t.points}</span>
    </div>
    <div>
      <div class="model-name">${escapeHtml(family.name)}</div>
      <div class="model-meta">${escapeHtml(family.description || "")}</div>
    </div>
  </button>
`;

const renderTask = (task) => `
  <article class="task-item">
    ${task.result_image_url ? `<img class="task-thumb" src="${escapeHtml(task.result_image_url)}" alt="生成结果" />` : `<div class="task-thumb"></div>`}
    <div>
      <div class="task-prompt">${escapeHtml(task.prompt_text || task.prompt || "未记录提示词")}</div>
      <div class="task-meta-line">${escapeHtml(task.flow_model || task.model || "")} · ${escapeHtml(String(task.created_at || "").slice(0, 16).replace("T", " "))}</div>
      ${task.error_msg ? `<div class="task-meta-line status-failed">${escapeHtml(task.error_msg)}</div>` : ""}
    </div>
    <span class="badge ${task.status === "success" ? "status-ok" : task.status === "failed" ? "status-failed" : ""}">${escapeHtml(task.status)}</span>
  </article>
`;

const renderSelector = (title, note, values, selected, attr) => `
  <section class="section compact-section">
    <div class="section-head">
      <div class="section-title">${title}</div>
      <div class="section-note">${note}</div>
    </div>
    <div class="chips">
      ${values.map((value) => `<button class="chip ${value === selected ? "active" : ""}" data-${attr}="${value}">${escapeHtml(value)}</button>`).join("")}
    </div>
  </section>
`;

const renderStudio = () => {
  const model = selectedModel();
  const latest = latestSuccessfulTask();
  const families = familyOptions();
  const activeTasks = state.tasks.filter((task) => task.status === "pending" || task.status === "processing").length;
  const failedTasks = state.tasks.filter((task) => task.status === "failed").length;

  return `
    <main class="workspace">
      <aside class="control-pane">
        <section class="section">
          <div class="section-head">
            <div>
              <div class="section-title">${t.modelSeries}</div>
              <div class="section-note">由后端模型目录提供</div>
            </div>
            <span class="badge">${families.length} 个系列</span>
          </div>
          <div class="model-list family-list">
            ${families.map(renderFamilyCard).join("") || `<div class="section-note">${t.noModel}</div>`}
          </div>
        </section>

        ${renderSelector(t.aspect, "图片比例", aspectOptions(), state.selectedAspect, "aspect")}
        ${renderSelector(t.resolution, "输出清晰度", resolutionOptions(), state.selectedResolution, "resolution")}

        <section class="section">
          <div class="section-head">
            <div class="section-title">${t.prompt}</div>
            <div class="section-note">${state.prompt.length}/900</div>
          </div>
          <div class="field">
            <textarea id="prompt-input" maxlength="900">${escapeHtml(state.prompt)}</textarea>
          </div>
        </section>

        <section class="section">
          <div class="section-head">
            <div class="section-title">${t.references}</div>
            <div class="section-note">支持多张图片</div>
          </div>
          <div class="upload-zone">
            <div class="upload-row">
              <span class="section-note">${state.files.length ? `${state.files.length} 张已选择` : "不上传也可以生成"}</span>
              <button class="secondary-btn" id="pick-files" type="button">${t.chooseImages}</button>
            </div>
            <input id="file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden />
            <div class="file-list">
              ${state.files.map((file) => `<div>${escapeHtml(file.name)} · ${(file.size / 1024).toFixed(1)}KB</div>`).join("")}
            </div>
          </div>
        </section>

        <div class="compose-footer">
          <div>
            <div class="section-note">当前配置</div>
            <div class="model-name">${model ? `${escapeHtml(model.family)} · ${escapeHtml(model.aspect_ratio)} · ${escapeHtml(model.resolution)}` : t.noModel}</div>
          </div>
          <button class="primary-btn" id="generate-btn" ${state.generating ? "disabled" : ""}>${state.generating ? t.generating : t.generate}</button>
        </div>
      </aside>

      <section class="main-pane">
        <div class="hero-row">
          <div class="studio-title">
            <div class="eyebrow">FOR CREATORS AND API USERS</div>
            <h1>在线生成商品实拍图，也能接入到你的业务系统</h1>
            <p>用户看到的是简单的模型、尺寸、清晰度选择；系统内部会自动匹配后端返回的真实模型 ID，并在 5xx 失败时切换同规格备用模型。</p>
          </div>
          <div class="status-grid">
            <div class="stat"><div class="stat-value">${families.length}</div><div class="stat-label">模型系列</div></div>
            <div class="stat"><div class="stat-value">${activeTasks}</div><div class="stat-label">进行中</div></div>
            <div class="stat"><div class="stat-value">${failedTasks}</div><div class="stat-label">失败任务</div></div>
          </div>
        </div>

        <div class="result-stage">
          ${latest ? `<img class="result-image" src="${escapeHtml(latest.result_image_url)}" alt="最新生成结果" />` : `
            <div class="empty-state">
              <div class="empty-icon">□</div>
              <strong>${t.emptyTitle}</strong>
              <span>${t.emptyDesc}</span>
            </div>
          `}
        </div>

        <section class="task-panel">
          <div class="section-head">
            <div class="section-title">${t.recentTasks}</div>
            <div class="section-note">${state.tasks.length} 条记录</div>
          </div>
          <div class="task-list">
            ${state.tasks.length ? state.tasks.map(renderTask).join("") : `<div class="section-note">${t.noTasks}</div>`}
          </div>
        </section>
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
          <h1>把同一套图片生成能力接入你的系统</h1>
          <p>网站和 API 使用同一个域名。前端通过 <code>/v1/models</code> 获取能力目录，开发者也应先读取模型目录，再提交生成任务。</p>
        </div>
        <div class="api-base">
          <span>Base URL</span>
          <strong>${escapeHtml(base)}</strong>
        </div>
      </section>

      <section class="api-grid">
        <article class="api-card">
          <h2>1. 登录获取 Token</h2>
          <pre><code>curl -X POST ${escapeHtml(base)}/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"user@example.com","password":"123456"}'</code></pre>
        </article>
        <article class="api-card">
          <h2>2. 读取模型目录</h2>
          <pre><code>curl ${escapeHtml(base)}/v1/models</code></pre>
        </article>
        <article class="api-card wide">
          <h2>3. 提交图片生成</h2>
          <pre><code>curl -X POST ${escapeHtml(base)}/v1/generate \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "MODEL_ID_FROM_/v1/models",
    "aspect_ratio": "4:3",
    "resolution": "2K",
    "prompt": "生成一张自然真实的商品货架实拍图"
  }'</code></pre>
        </article>
        <article class="api-card wide">
          <h2>上传参考图</h2>
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
        <button class="${state.view === "studio" ? "active" : ""}" data-view="studio">${t.studio}</button>
        <button class="${state.view === "api" ? "active" : ""}" data-view="api">${t.api}</button>
      </nav>
      <div class="top-actions">
        <span>${escapeHtml(state.user?.email || "")}</span>
        <span class="points">${Number(state.user?.points || 0).toLocaleString("zh-CN")} ${t.points}</span>
        <button class="ghost-btn" id="logout-btn">${t.logout}</button>
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
    const note = event.target.closest(".section")?.querySelector(".section-note");
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
