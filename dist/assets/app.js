const app = document.getElementById("app");
const tokenKey = "kewen_token";
const previewUrls = new WeakMap();

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
  rechargeOrders: [],
  rechargeOptions: null,
  imageRetentionDays: 7,
  selectedTaskId: "",
  generating: false,
  recharging: false,
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
  studio: "创作",
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
  if (["nanobanan.vip", "www.nanobanan.vip"].includes(location.hostname)) {
    return "https://api.nanobanan.vip";
  }
  if (["kewenai.shop", "www.kewenai.shop"].includes(location.hostname)) {
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

const copyText = async (value, message = "已复制") => {
  try {
    await navigator.clipboard.writeText(value);
    toast(message);
  } catch {
    toast("复制失败，请手动复制");
  }
};

const rotateApiKey = async () => {
  try {
    const payload = await api("/auth/api-key", { method: "POST" });
    state.user = { ...state.user, api_key: payload.api_key };
    render();
    toast("API Key 已重置");
  } catch (error) {
    toast(error.message);
  }
};

const loadModels = async () => {
  const payload = await api("/v1/models");
  state.models = payload.data || [];
  state.imageRetentionDays = payload.image_retention_days || 7;
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

const loadRechargeOptions = async () => {
  state.rechargeOptions = await api("/payment/recharge/options");
};

const loadRechargeOrders = async () => {
  if (!state.user) return;
  state.rechargeOrders = await api("/payment/recharge/orders?limit=20");
};

const familyDescription = (familyId) =>
  familyId === "nano-banana-pro"
    ? "细节更稳，适合质感、纹理、商品卖点要求更高的图。"
    : "速度快，适合日常商品图、批量任务和快速出图。";

const familyOptions = () => {
  const families = new Map();
  state.models.forEach((model) => {
    if (!families.has(model.family_id)) {
      const familyModels = state.models.filter((item) => item.family_id === model.family_id);
      const costs = [...new Set(familyModels.map((item) => Number(item.points_cost || 0)))].sort((a, b) => a - b);
      families.set(model.family_id, {
        id: model.family_id,
        name: model.family,
        shortName: model.short_name,
        cost: model.points_cost,
        costLabel: costs.length > 1 ? `${costs[0]}-${costs[costs.length - 1]} 分` : `${costs[0] || model.points_cost} 分`,
        tier: model.tier,
        description: familyDescription(model.family_id),
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
    await loadRechargeOrders();
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
  state.rechargeOrders = [];
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

const createRecharge = async (amount) => {
  if (state.recharging) return;
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount < 5) {
    return toast("最低充值 5 元");
  }
  state.recharging = true;
  render();
  try {
    const order = await api("/payment/recharge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_yuan: numericAmount }),
    });
    await loadRechargeOrders();
    if (order.payment_url) {
      window.open(order.payment_url, "_blank", "noopener,noreferrer");
      toast("支付页面已打开，到账后积分会自动更新");
    } else {
      toast("订单已创建，请在支付网关继续完成付款");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    state.recharging = false;
    await loadUser();
    await loadRechargeOrders();
    render();
  }
};

const latestSuccessfulTask = () => state.tasks.find((task) => task.status === "success" && task.result_image_url);
const successfulTasks = () => state.tasks.filter((task) => task.status === "success" && task.result_image_url).slice(0, 8);

const formatDateTime = (value) => String(value || "").slice(0, 16).replace("T", " ");

const imageRetentionText = (task) => {
  if (task?.result_image_expires_at) {
    return `图片保留至 ${formatDateTime(task.result_image_expires_at)}`;
  }
  return `图片保留 ${task?.image_retention_days || state.imageRetentionDays || 7} 天`;
};
const selectedTask = () => state.tasks.find((task) => task.task_id === state.selectedTaskId);
const pendingCount = () => state.tasks.filter((task) => ["pending", "processing"].includes(task.status)).length;
const failedCount = () => state.tasks.filter((task) => task.status === "failed").length;
const currentCost = () => Number(selectedModel()?.points_cost || 0);

const fileKey = (file) => `${file.name}-${file.size}-${file.lastModified}`;

const appendFiles = (files) => {
  const existing = new Set(state.files.map(fileKey));
  [...files].forEach((file) => {
    if (!existing.has(fileKey(file))) {
      state.files.push(file);
      existing.add(fileKey(file));
    }
  });
};

const previewUrl = (file) => {
  if (!previewUrls.has(file)) previewUrls.set(file, URL.createObjectURL(file));
  return previewUrls.get(file);
};

const removeFileAt = (index) => {
  const [file] = state.files.splice(index, 1);
  const url = file ? previewUrls.get(file) : null;
  if (url) URL.revokeObjectURL(url);
  render();
};

const renderFilePreview = (file, index) => `
  <article class="file-preview">
    <img src="${escapeHtml(previewUrl(file))}" alt="${escapeHtml(file.name)}" />
    <div>
      <strong>${escapeHtml(file.name)}</strong>
      <span>${(file.size / 1024).toFixed(1)}KB</span>
    </div>
    <button type="button" aria-label="移除 ${escapeHtml(file.name)}" data-remove-file="${index}">×</button>
  </article>
`;

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
    <span class="cost">${escapeHtml(family.costLabel)}</span>
  </button>
`;

const renderSelector = (title, helper, values, selected, attr) => `
  <section class="field-group">
    <div class="group-title">
      <strong>${title}</strong>
      <span>${helper}</span>
    </div>
    <div class="chips">
      ${values.map((value) => `<button class="chip ${value === selected ? "active" : ""}" data-${attr}="${value}">${escapeHtml(value)}</button>`).join("")}
    </div>
  </section>
`;

const renderTask = (task) => {
  const statusText = task.status === "success" ? "完成" : task.status === "failed" ? "失败" : "进行中";
  const statusClass = task.status === "success" ? "ok" : task.status === "failed" ? "failed" : "working";
  const canPreview = task.result_image_url || task.prompt || task.prompt_text;
  return `
    <button class="task-item ${canPreview ? "clickable" : ""}" type="button" data-task-id="${escapeHtml(task.task_id)}">
      ${task.result_image_url ? `<img class="task-thumb" src="${escapeHtml(task.result_image_url)}" alt="生成结果" />` : `<div class="task-thumb blank"></div>`}
      <div class="task-body">
        <div class="task-prompt">${escapeHtml(task.prompt_text || task.prompt || "未记录提示词")}</div>
        <div class="task-meta">${escapeHtml(formatDateTime(task.created_at))} · ${Number(task.points_cost || 0)} 分</div>
        ${task.result_image_url ? `<div class="task-retention">${escapeHtml(imageRetentionText(task))}</div>` : ""}
        ${task.error_msg ? `<div class="task-error">${escapeHtml(task.error_msg)}</div>` : ""}
      </div>
      <span class="status ${statusClass}">${statusText}</span>
    </button>
  `;
};

const renderResultPanel = () => {
  const latest = latestSuccessfulTask();
  if (!latest) {
    return `
      <section class="result-panel empty">
        <div class="empty-visual"></div>
        <strong>结果会显示在这里</strong>
        <span>上传参考图、填写提示词后点击生成。完成后可以直接打开原图，历史结果会保留在右侧任务里。</span>
      </section>
    `;
  }
  return `
    <section class="result-panel">
      <div class="result-toolbar">
        <div>
          <strong>最新结果</strong>
          <span>${escapeHtml(formatDateTime(latest.created_at))}</span>
          <span>${escapeHtml(imageRetentionText(latest))}</span>
        </div>
        <a href="${escapeHtml(latest.result_image_url)}" target="_blank" rel="noreferrer">打开原图</a>
      </div>
      <div class="result-stage">
        <img src="${escapeHtml(latest.result_image_url)}" alt="最新生成结果" />
      </div>
    </section>
  `;
};

const renderCreatePanel = () => {
  const model = selectedModel();
  const families = familyOptions();
  return `
    <aside class="create-panel">
      <section class="field-group">
        <div class="group-title">
          <strong>模型</strong>
        </div>
        <div class="model-list">
          ${families.map(renderFamilyCard).join("") || `<div class="muted">${copy.noModel}</div>`}
        </div>
      </section>

      <div class="split-controls">
        ${renderSelector("尺寸", "图片比例", aspectOptions(), state.selectedAspect, "aspect")}
        ${renderSelector("清晰度", "输出清晰度", resolutionOptions(), state.selectedResolution, "resolution")}
      </div>

      <section class="field-group">
        <div class="group-title">
          <strong>参考图</strong>
          <span>${state.files.length ? `${state.files.length} 张` : "可选"}</span>
        </div>
        <button class="upload-box" id="pick-files" type="button">
          <strong>选择图片</strong>
          <span>支持多张，重复选择会继续追加</span>
        </button>
        <input id="file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden />
        ${state.files.length ? `<div class="file-list">${state.files.map(renderFilePreview).join("")}</div>` : ""}
      </section>

      <section class="field-group prompt-group">
        <div class="group-title">
          <strong>提示词</strong>
          <span id="prompt-count">${state.prompt.length}/900</span>
        </div>
        <textarea id="prompt-input" maxlength="900" placeholder="描述你想生成的商品实拍图，例如：把商品放在真实货架上，保持自然光线和普通手机拍摄质感。">${escapeHtml(state.prompt)}</textarea>
      </section>

      <div class="generate-bar">
        <div>
          <span>当前配置</span>
          <strong>${model ? `${escapeHtml(model.family)} · ${escapeHtml(model.aspect_ratio)} · ${escapeHtml(model.resolution)}` : copy.noModel}</strong>
          <small>${currentCost()} 分 / 次</small>
        </div>
        <button class="primary-btn" id="generate-btn" ${state.generating ? "disabled" : ""}>${state.generating ? copy.generating : copy.generate}</button>
      </div>
    </aside>
  `;
};

const renderSidePanel = () => `
  <aside class="side-panel">
    <section class="api-shortcut">
      <div>
        <strong>需要接入业务系统？</strong>
        <span>查看模型列表、上传多张参考图、返回图片 URL。</span>
      </div>
      <button class="ghost-btn" data-view="api">查看 API</button>
    </section>

    <section class="task-panel">
      <div class="group-title">
        <strong>最近任务</strong>
        <span>${state.tasks.length} 条</span>
      </div>
      <div class="task-list">
        ${state.tasks.length ? state.tasks.map(renderTask).join("") : `<div class="muted">${copy.noTasks}</div>`}
      </div>
    </section>
  </aside>
`;

const renderStudio = () => `
  <main class="studio-shell">
    ${renderCreatePanel()}
    ${renderResultPanel()}
    ${renderSidePanel()}
  </main>
`;

const rechargePackages = () => state.rechargeOptions?.packages || [
  { amount_yuan: 5, base_points: 500, bonus_points: 0, total_points: 500 },
  { amount_yuan: 10, base_points: 1000, bonus_points: 30, total_points: 1030 },
  { amount_yuan: 100, base_points: 10000, bonus_points: 500, total_points: 10500 },
  { amount_yuan: 1000, base_points: 100000, bonus_points: 6000, total_points: 106000 },
];

const renderRechargePackage = (item) => `
  <button class="recharge-card" type="button" data-recharge-amount="${Number(item.amount_yuan)}">
    <span>¥${Number(item.amount_yuan).toLocaleString("zh-CN")}</span>
    <strong>${Number(item.total_points).toLocaleString("zh-CN")} 积分</strong>
    <small>${Number(item.bonus_points || 0) ? `赠送 ${Number(item.bonus_points).toLocaleString("zh-CN")} 积分` : "基础充值"}</small>
  </button>
`;

const renderRechargeOrder = (order) => {
  const statusText = order.status === "paid" ? "已到账" : order.status === "failed" ? "失败" : "待支付";
  const statusClass = order.status === "paid" ? "ok" : order.status === "failed" ? "failed" : "working";
  return `
    <article class="recharge-order">
      <div>
        <strong>¥${Number(order.amount_yuan || 0).toFixed(2)} · ${Number(order.total_points || 0).toLocaleString("zh-CN")} 积分</strong>
        <span>${escapeHtml(formatDateTime(order.created_at))} · ${escapeHtml(order.trade_order_id)}</span>
      </div>
      <span class="status ${statusClass}">${statusText}</span>
    </article>
  `;
};

const renderBilling = () => `
  <main class="billing-page">
    <section class="billing-hero">
      <div>
        <span class="eyebrow">Balance</span>
        <h1>账户充值</h1>
        <p>支付完成并收到虎皮椒到账通知后，系统会自动把积分充入当前账户。最低充值 5 元，1 元 = 100 积分。</p>
      </div>
      <div class="billing-balance">
        <span>当前积分</span>
        <strong>${Number(state.user?.points || 0).toLocaleString("zh-CN")}</strong>
      </div>
    </section>

    <section class="billing-grid">
      <article class="billing-card wide">
        <div class="billing-card-head">
          <div>
            <h2>选择充值金额</h2>
            <p>10-99 元送 30 积分，100-999 元送 500 积分，1000 元及以上送 6000 积分。</p>
          </div>
        </div>
        <div class="recharge-packages">
          ${rechargePackages().map(renderRechargePackage).join("")}
        </div>
        <div class="custom-recharge">
          <label class="field">
            <span>自定义金额</span>
            <input id="custom-recharge-amount" type="number" min="5" step="0.01" placeholder="最低 5 元" />
          </label>
          <button class="primary-btn" id="custom-recharge-btn" ${state.recharging ? "disabled" : ""}>${state.recharging ? "创建订单中..." : "立即充值"}</button>
        </div>
      </article>

      <article class="billing-card">
        <h2>充值说明</h2>
        <div class="billing-notes">
          <p>付款成功后请等待页面自动到账；如果支付窗口已关闭，可回到本页刷新查看订单状态。</p>
          <p>系统只在服务端确认支付通知验签通过后加积分，未到账订单不会发放积分。</p>
          <p>新注册用户自动赠送 15 积分。</p>
        </div>
      </article>

      <article class="billing-card wide">
        <div class="billing-card-head">
          <div>
            <h2>充值记录</h2>
            <p>最近 20 条充值订单。</p>
          </div>
          <button class="ghost-btn" data-refresh-recharge>刷新</button>
        </div>
        <div class="recharge-order-list">
          ${state.rechargeOrders.length ? state.rechargeOrders.map(renderRechargeOrder).join("") : `<div class="muted">暂无充值记录</div>`}
        </div>
      </article>
    </section>
  </main>
`;

const renderApiModelRow = (model) => `
  <tr>
    <td><code>${escapeHtml(model.id)}</code></td>
    <td>${escapeHtml(model.family)}</td>
    <td>${escapeHtml(model.aspect_ratio)}</td>
    <td>${escapeHtml(model.resolution)}</td>
    <td>${Number(model.points_cost || 0)} 分</td>
  </tr>
`;

const renderApiDocs = () => {
  const base = apiBaseUrl();
  const apiKey = state.user?.api_key || "";
  const exampleModel = state.models[0]?.id || "kewen-nano-banana-2-4x3-1k";
  return `
    <main class="api-page">
      <section class="api-hero">
        <div>
          <span class="eyebrow">Open API</span>
          <h1>把图片生成接入你的业务系统</h1>
          <p>API 与网页端使用同一套后端模型。这里展示的是 Kewen AI 公开模型 ID，真实上游模型由服务端自动映射。生成图片文件默认保留 ${state.imageRetentionDays || 7} 天。</p>
        </div>
        <div class="api-base">
          <span>Base URL</span>
          <strong>${escapeHtml(base)}</strong>
        </div>
      </section>

      <section class="api-grid">
        <article class="api-card api-key-card">
          <div class="api-card-title">
            <h2>1. 你的 API Key</h2>
            <button class="ghost-btn" data-copy-value="${escapeHtml(apiKey)}">复制</button>
          </div>
          <div class="key-box">${escapeHtml(apiKey || "登录后自动生成")}</div>
          <p>外部系统调用接口时，把这个 Key 放到 <code>Authorization: Bearer</code> 里。</p>
          <button class="danger-btn" data-rotate-api-key>重置 API Key</button>
        </article>
        <article class="api-card">
          <h2>2. 获取模型列表</h2>
          <pre><code>curl ${escapeHtml(base)}/v1/models \\
  -H "Authorization: Bearer YOUR_API_KEY"</code></pre>
        </article>
        <article class="api-card wide">
          <h2>3. 可用模型</h2>
          <div class="model-table-wrap">
            <table class="model-table">
              <thead>
                <tr>
                  <th>模型 ID</th>
                  <th>模型</th>
                  <th>尺寸</th>
                  <th>清晰度</th>
                  <th>积分</th>
                </tr>
              </thead>
              <tbody>
                ${state.models.map(renderApiModelRow).join("")}
              </tbody>
            </table>
          </div>
        </article>
        <article class="api-card wide">
          <h2>4. 上传多张参考图并生成</h2>
          <pre><code>curl -X POST ${escapeHtml(base)}/v1/generate/upload \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -F "model=${escapeHtml(exampleModel)}" \\
  -F "aspect_ratio=4:3" \\
  -F "resolution=1K" \\
  -F "prompt=按参考图生成真实商品实拍图" \\
  -F "product_images=@scene.png" \\
  -F "product_images=@product.png"</code></pre>
        </article>
      </section>
    </main>
  `;
};

const renderTaskModal = () => {
  const task = selectedTask();
  if (!task) return "";
  const prompt = task.prompt_text || task.prompt || "未记录提示词";
  return `
    <section class="task-modal" data-close-task-modal>
      <article class="task-dialog" role="dialog" aria-modal="true" aria-label="任务详情">
        <div class="task-dialog-head">
          <div>
            <strong>任务详情</strong>
            <span>${escapeHtml(formatDateTime(task.created_at))} · ${Number(task.points_cost || 0)} 分</span>
            ${task.result_image_url ? `<span>${escapeHtml(imageRetentionText(task))}</span>` : ""}
          </div>
          <button class="ghost-btn" type="button" data-close-task-modal>关闭</button>
        </div>
        ${task.result_image_url ? `
          <div class="task-dialog-image">
            <img src="${escapeHtml(task.result_image_url)}" alt="生成结果大图" />
          </div>
        ` : `
          <div class="task-dialog-empty">这个任务没有返回图片。</div>
        `}
        <div class="task-dialog-prompt">
          <span>提示词</span>
          <p>${escapeHtml(prompt)}</p>
        </div>
        ${task.error_msg ? `
          <div class="task-dialog-error">
            <span>错误信息</span>
            <p>${escapeHtml(task.error_msg)}</p>
          </div>
        ` : ""}
      </article>
    </section>
  `;
};

const renderWorkspace = () => `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand"><div class="brand-mark">K</div><span>Kewen AI</span></div>
      <nav class="main-nav">
        <button class="${state.view === "studio" ? "active" : ""}" data-view="studio">${copy.studio}</button>
        <button class="${state.view === "billing" ? "active" : ""}" data-view="billing">充值</button>
        <button class="${state.view === "api" ? "active" : ""}" data-view="api">${copy.api}</button>
      </nav>
      <div class="top-actions">
        <span class="user-email">${escapeHtml(state.user?.email || "")}</span>
        <span class="points">${Number(state.user?.points || 0).toLocaleString("zh-CN")} ${copy.points}</span>
        <button class="ghost-btn" id="logout-btn">${copy.logout}</button>
      </div>
    </header>
    ${state.view === "api" ? renderApiDocs() : state.view === "billing" ? renderBilling() : renderStudio()}
    ${renderTaskModal()}
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
    button.addEventListener("click", async () => {
      state.view = button.dataset.view;
      if (state.view === "billing") {
        try {
          if (!state.rechargeOptions) await loadRechargeOptions();
          await loadRechargeOrders();
          await loadUser();
        } catch (error) {
          toast(error.message);
          return;
        }
      }
      render();
    });
  });

  document.querySelectorAll("[data-copy-value]").forEach((button) => {
    button.addEventListener("click", () => copyText(button.dataset.copyValue || "", "API Key 已复制"));
  });

  document.querySelector("[data-rotate-api-key]")?.addEventListener("click", rotateApiKey);

  document.querySelectorAll("[data-task-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedTaskId = button.dataset.taskId || "";
      render();
    });
  });

  document.querySelectorAll("[data-close-task-modal]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target === element || element.tagName === "BUTTON") {
        state.selectedTaskId = "";
        render();
      }
    });
  });

  document.querySelectorAll("[data-recharge-amount]").forEach((button) => {
    button.addEventListener("click", () => createRecharge(button.dataset.rechargeAmount));
  });

  document.getElementById("custom-recharge-btn")?.addEventListener("click", () => {
    createRecharge(document.getElementById("custom-recharge-amount")?.value);
  });

  document.querySelector("[data-refresh-recharge]")?.addEventListener("click", async () => {
    try {
      await loadUser();
      await loadRechargeOrders();
      toast("充值记录已刷新");
    } catch (error) {
      toast(error.message);
    }
    render();
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
    appendFiles(event.target.files);
    event.target.value = "";
    render();
  });
  document.querySelectorAll("[data-remove-file]").forEach((button) => {
    button.addEventListener("click", () => removeFileAt(Number(button.dataset.removeFile)));
  });
  document.getElementById("generate-btn")?.addEventListener("click", generate);
};

const render = () => {
  app.innerHTML = `${state.token && state.user ? renderWorkspace() : renderAuth()}${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""}`;
  wireEvents();
};

const paymentReturnOrderId = () => {
  const params = new URLSearchParams(location.search);
  return params.get("payment") === "return" ? params.get("trade_order_id") || "" : "";
};

const clearPaymentReturnUrl = () => {
  if (!paymentReturnOrderId()) return;
  history.replaceState({}, "", `${location.pathname || "/"}${location.hash || ""}`);
};

const boot = async () => {
  const returnedOrderId = paymentReturnOrderId();
  if (returnedOrderId) state.view = "billing";
  render();
  try {
    await loadModels();
    await loadRechargeOptions();
    await loadUser();
    if (state.user) {
      await loadTasks();
      await loadRechargeOrders();
      if (returnedOrderId) {
        await loadUser();
        toast("支付已返回，余额和充值记录已刷新");
      }
    }
    clearPaymentReturnUrl();
  } catch (error) {
    toast(error.message);
  }
  render();
};

boot();
