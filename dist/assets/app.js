const app = document.getElementById("app");
const tokenKey = "kewen_token";

const state = {
  token: localStorage.getItem(tokenKey),
  user: null,
  authMode: "login",
  models: [],
  selectedModelId: "",
  familyFilter: "all",
  files: [],
  tasks: [],
  generating: false,
  prompt: "",
  toast: "",
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
  if (!state.selectedModelId && state.models.length) {
    state.selectedModelId = state.models[0].id;
  }
  if (!state.prompt) {
    state.prompt = payload.defaults?.prompt || "";
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

const selectedModel = () => state.models.find((model) => model.id === state.selectedModelId) || state.models[0];

const filteredModels = () => state.models.filter((model) => (
  state.familyFilter === "all" || model.family_id === state.familyFilter
));

const familyOptions = () => {
  const families = new Map();
  state.models.forEach((model) => families.set(model.family_id, model.family));
  return [...families.entries()].map(([id, name]) => ({ id, name }));
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
    toast("请先填写提示词");
    return;
  }
  const model = selectedModel();
  if (!model) {
    toast("后端没有返回可用模型");
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
    toast("生成完成");
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

const renderAuth = () => `
  <main class="auth-view">
    <section class="auth-panel">
      <div class="auth-copy">
        <div class="brand"><div class="brand-mark">K</div><span>Kewen AI</span></div>
        <div class="eyebrow" style="margin-top:42px">Flow2API Image Studio</div>
        <h1>把商品图生成流程收进一个干净的工作台</h1>
        <p>模型目录由后端统一提供，页面只透出当前可用的图片模型。参考图、提示词、任务记录和结果预览都在同一屏完成。</p>
      </div>
      <form class="auth-form" id="auth-form">
        <div class="auth-tabs">
          <button type="button" class="${state.authMode === "login" ? "active" : ""}" data-auth-mode="login">登录</button>
          <button type="button" class="${state.authMode === "register" ? "active" : ""}" data-auth-mode="register">注册</button>
        </div>
        <div class="field">
          <label>邮箱</label>
          <input name="email" type="email" autocomplete="email" required />
        </div>
        ${state.authMode === "register" ? `
          <div class="field">
            <label>用户名</label>
            <input name="username" autocomplete="username" />
          </div>
        ` : ""}
        <div class="field">
          <label>密码</label>
          <input name="password" type="password" autocomplete="${state.authMode === "login" ? "current-password" : "new-password"}" required minlength="6" />
        </div>
        <button class="primary-btn" type="submit">${state.authMode === "login" ? "进入工作台" : "创建账号"}</button>
      </form>
    </section>
  </main>
`;

const renderModelCard = (model) => `
  <button class="model-card ${model.id === state.selectedModelId ? "active" : ""}" data-model-id="${model.id}">
    <div class="model-top">
      <span class="badge ${model.tier === "pro" ? "pro" : ""}">${escapeHtml(model.short_name)}</span>
      <span class="section-note">${model.points_cost} 积分</span>
    </div>
    <div>
      <div class="model-name">${escapeHtml(model.name)}</div>
      <div class="model-meta">
        <span>${escapeHtml(model.aspect_ratio)}</span>
        <span>${escapeHtml(model.resolution)}</span>
        <span>${escapeHtml(model.family)}</span>
      </div>
    </div>
  </button>
`;

const latestSuccessfulTask = () => state.tasks.find((task) => task.status === "success" && task.result_image_url);

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

const renderWorkspace = () => {
  const model = selectedModel();
  const latest = latestSuccessfulTask();
  const families = familyOptions();
  const activeTasks = state.tasks.filter((task) => task.status === "pending" || task.status === "processing").length;
  const failedTasks = state.tasks.filter((task) => task.status === "failed").length;

  return `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand"><div class="brand-mark">K</div><span>Kewen AI Image Studio</span></div>
        <div class="top-actions">
          <span>${escapeHtml(state.user?.email || "")}</span>
          <span class="points">${Number(state.user?.points || 0).toLocaleString("zh-CN")} 积分</span>
          <button class="ghost-btn" id="logout-btn">退出</button>
        </div>
      </header>

      <main class="workspace">
        <aside class="control-pane">
          <section class="section">
            <div class="section-head">
              <div>
                <div class="section-title">模型目录</div>
                <div class="section-note">来自后端 /v1/models</div>
              </div>
              <span class="badge">${state.models.length} 个</span>
            </div>
            <div class="chips">
              <button class="chip ${state.familyFilter === "all" ? "active" : ""}" data-family-filter="all">全部</button>
              ${families.map((family) => `
                <button class="chip ${state.familyFilter === family.id ? "active" : ""}" data-family-filter="${family.id}">${escapeHtml(family.name)}</button>
              `).join("")}
            </div>
            <div class="model-list">
              ${filteredModels().map(renderModelCard).join("") || `<div class="section-note">后端未返回模型</div>`}
            </div>
          </section>

          <section class="section">
            <div class="section-head">
              <div class="section-title">提示词</div>
              <div class="section-note">${state.prompt.length}/900</div>
            </div>
            <div class="field">
              <textarea id="prompt-input" maxlength="900">${escapeHtml(state.prompt)}</textarea>
            </div>
          </section>

          <section class="section">
            <div class="section-head">
              <div class="section-title">参考图</div>
              <div class="section-note">支持多张图片</div>
            </div>
            <div class="upload-zone">
              <div class="upload-row">
                <span class="section-note">${state.files.length ? `${state.files.length} 张已选择` : "不上传也可以生成"}</span>
                <button class="secondary-btn" id="pick-files" type="button">选择图片</button>
              </div>
              <input id="file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden />
              <div class="file-list">
                ${state.files.map((file) => `<div>${escapeHtml(file.name)} · ${(file.size / 1024).toFixed(1)}KB</div>`).join("")}
              </div>
            </div>
          </section>

          <div class="compose-footer">
            <div>
              <div class="section-note">当前模型</div>
              <div class="model-name">${model ? escapeHtml(model.name) : "无可用模型"}</div>
            </div>
            <button class="primary-btn" id="generate-btn" ${state.generating ? "disabled" : ""}>${state.generating ? "生成中" : "生成"}</button>
          </div>
        </aside>

        <section class="main-pane">
          <div class="hero-row">
            <div class="studio-title">
              <div class="eyebrow">Image generation only</div>
              <h1>按后端模型目录动态生成商品图</h1>
              <p>模型、比例、分辨率、积分消耗均来自后端模型接口，后端发生变化时前端会自动跟随。</p>
            </div>
            <div class="status-grid">
              <div class="stat"><div class="stat-value">${state.models.length}</div><div class="stat-label">可用模型</div></div>
              <div class="stat"><div class="stat-value">${activeTasks}</div><div class="stat-label">进行中</div></div>
              <div class="stat"><div class="stat-value">${failedTasks}</div><div class="stat-label">失败任务</div></div>
            </div>
          </div>

          <div class="result-stage">
            ${latest ? `<img class="result-image" src="${escapeHtml(latest.result_image_url)}" alt="最新生成结果" />` : `
              <div class="empty-state">
                <div class="empty-icon">□</div>
                <strong>等待第一张图片生成</strong>
                <span>选择模型，补充提示词和参考图，然后提交生成。</span>
              </div>
            `}
          </div>

          <section class="task-panel">
            <div class="section-head">
              <div class="section-title">最近任务</div>
              <div class="section-note">${state.tasks.length} 条记录</div>
            </div>
            <div class="task-list">
              ${state.tasks.length ? state.tasks.map(renderTask).join("") : `<div class="section-note">暂无任务记录</div>`}
            </div>
          </section>
        </section>
      </main>
    </div>
  `;
};

const wireEvents = () => {
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.authMode = button.dataset.authMode;
      render();
    });
  });

  document.getElementById("auth-form")?.addEventListener("submit", authSubmit);
  document.getElementById("logout-btn")?.addEventListener("click", logout);

  document.querySelectorAll("[data-family-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.familyFilter = button.dataset.familyFilter;
      const first = filteredModels()[0];
      if (first && !filteredModels().some((model) => model.id === state.selectedModelId)) {
        state.selectedModelId = first.id;
      }
      render();
    });
  });

  document.querySelectorAll("[data-model-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedModelId = button.dataset.modelId;
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
