"use strict";

/**
 * main.js
 * AI百团大战海报生成器 · Electron 主进程
 *
 * 职责：
 *   - 创建应用主窗口
 *   - 本地 JSON 持久化（userData/config.json）
 *   - API Key 使用 safeStorage（Windows 下为 DPAPI）加密保存
 *   - 角色参考图复制到 userData/references/
 *   - 串联 apiService（出背景图）→ imageUtils（合成文字）→ outputs 落盘
 */

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, clipboard, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const apiService = require("./apiService");
const { addTextToPoster, createOfflineBackground } = require("./imageUtils");
const sharp = require("sharp");

/* ------------------------------------------------------------------ */
/* 常量与默认值                                                          */
/* ------------------------------------------------------------------ */

/* 厂商预设：选择后自动填 Base URL（结尾不带 /v1，由 apiService 统一拼接） */
const VENDOR_PRESETS = [
  { id: "zhipu", name: "智谱 AI（GLM / CogView）", baseUrl: "https://open.bigmodel.cn/api/paas" },
  { id: "ali", name: "阿里 DashScope（通义万相）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com" },
  { id: "siliconflow", name: "硅基流动 SiliconFlow", baseUrl: "https://api.siliconflow.cn" },
  { id: "custom", name: "自定义 / 其他中转站", baseUrl: "" },
];

const DEFAULT_CONFIG = {
  vendor: "custom",
  baseUrl: "",
  encryptedApiKey: "",
  model: "",
  assistantModel: "",
  size: "1024x1024",
  count: 1,
  clubName: "",
  slogan: "",
  activityTime: "",
  activityLocation: "",
  style: "扁平插画",
  characterPrompt: "",
  extraNegative: "",
  referenceImage: "",
  onboarded: false,
};

/* ------------------------------------------------------------------ */
/* 路径与目录                                                            */
/* ------------------------------------------------------------------ */

let mainWindow = null;

function configFile() {
  return path.join(app.getPath("userData"), "config.json");
}

function referencesDir() {
  return path.join(app.getPath("userData"), "references");
}

function outputsDir() {
  return path.join(app.getPath("userData"), "outputs");
}

function rawsDir() {
  return path.join(app.getPath("userData"), "raws");
}

function historyFile() {
  return path.join(app.getPath("userData"), "history.json");
}

function historyThumbsDir() {
  return path.join(app.getPath("userData"), "history");
}

/* 历史记录上限，超出后删除最旧的（连带缩略图） */
const HISTORY_LIMIT = 120;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ------------------------------------------------------------------ */
/* 配置读写 + API Key 加解密                                             */
/* ------------------------------------------------------------------ */

let configCache = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    const raw = fs.readFileSync(configFile(), "utf8");
    const stored = JSON.parse(raw);
    configCache = { ...DEFAULT_CONFIG, ...stored };
  } catch (_) {
    configCache = { ...DEFAULT_CONFIG };
  }
  return configCache;
}

function saveConfig() {
  ensureDir(path.dirname(configFile()));
  fs.writeFileSync(configFile(), JSON.stringify(configCache, null, 2), "utf8");
}

/* 加密串格式前缀：v1 = safeStorage（Windows DPAPI / macOS Keychain / libsecret） */
const SECURE_PREFIX = "secure_v1:";
/* 旧版本 safeStorage 串无前缀，读取时做兼容；旧的明文兜底用此前缀 */
const LEGACY_PLAIN_PREFIX = "plain:";

/* safeStorage 不可用时，Key 只保留在本会话内存中，绝不落盘 */
let sessionApiKey = "";

function encryptionAvailable() {
  return safeStorage.isEncryptionAvailable();
}

function encryptApiKey(plain) {
  if (encryptionAvailable()) {
    return SECURE_PREFIX + safeStorage.encryptString(plain).toString("base64");
  }
  sessionApiKey = plain;
  return "";
}

function decryptApiKey(stored) {
  if (!stored) return "";
  try {
    /* 旧的明文兜底串：仅读取（兼容历史数据），后续保存会重新加密 */
    if (stored.startsWith(LEGACY_PLAIN_PREFIX)) {
      return Buffer.from(stored.slice(LEGACY_PLAIN_PREFIX.length), "base64").toString("utf8");
    }
    if (encryptionAvailable()) {
      const blob = stored.startsWith(SECURE_PREFIX) ? stored.slice(SECURE_PREFIX.length) : stored;
      return safeStorage.decryptString(Buffer.from(blob, "base64"));
    }
  } catch (_) {
    /* 解密失败（如换了系统/用户）按未配置处理 */
  }
  return "";
}

function getApiKey() {
  return decryptApiKey(configCache.encryptedApiKey) || sessionApiKey;
}

/* 给界面展示的密钥存储方式说明 */
function keyStorageInfo() {
  if (encryptionAvailable()) {
    const backend =
      process.platform === "win32"
        ? "Windows DPAPI（系统级加密）"
        : process.platform === "darwin"
          ? "macOS Keychain（钥匙串）"
          : "系统密钥环（libsecret）";
    return { mode: "safeStorage", backend };
  }
  return { mode: "session", backend: "仅本次运行内存（系统加密不可用，不会写入磁盘）" };
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                  */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 980,
    minHeight: 660,
    title: "AI百团大战海报生成器",
    icon: path.join(__dirname, "build", "icon.ico"),
    autoHideMenuBar: true,
    backgroundColor: "#10131f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/* ------------------------------------------------------------------ */
/* IPC：配置                                                             */
/* ------------------------------------------------------------------ */

ipcMain.handle("config:get", () => {
  const cfg = configCache;
  return {
    vendors: VENDOR_PRESETS,
    sceneTemplates: apiService.SCENE_TEMPLATES,
    vendor: cfg.vendor,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    assistantModel: cfg.assistantModel,
    size: cfg.size,
    count: cfg.count,
    clubName: cfg.clubName,
    slogan: cfg.slogan,
    activityTime: cfg.activityTime,
    activityLocation: cfg.activityLocation,
    style: cfg.style,
    characterPrompt: cfg.characterPrompt,
    extraNegative: cfg.extraNegative,
    referenceImage: cfg.referenceImage,
    hasKey: Boolean(getApiKey()),
    keyStorage: keyStorageInfo(),
    onboarded: Boolean(cfg.onboarded),
    outputsDir: outputsDir(),
  };
});

/* 保存界面上的全部设置；apiKey 留空表示不修改 */
ipcMain.handle("config:save", (event, payload = {}) => {
  const cfg = configCache;

  if (typeof payload.vendor === "string") cfg.vendor = payload.vendor;
  if (typeof payload.baseUrl === "string") cfg.baseUrl = payload.baseUrl.trim();
  if (typeof payload.model === "string") cfg.model = payload.model.trim();
  if (typeof payload.assistantModel === "string") cfg.assistantModel = payload.assistantModel.trim();
  if (typeof payload.size === "string") cfg.size = payload.size.trim();
  if (payload.count != null) {
    cfg.count = Math.min(4, Math.max(1, Number.parseInt(payload.count, 10) || 1));
  }
  if (typeof payload.clubName === "string") cfg.clubName = payload.clubName.trim();
  if (typeof payload.slogan === "string") cfg.slogan = payload.slogan.trim();
  if (typeof payload.activityTime === "string") cfg.activityTime = payload.activityTime.trim();
  if (typeof payload.activityLocation === "string") cfg.activityLocation = payload.activityLocation.trim();
  if (typeof payload.style === "string") cfg.style = payload.style.trim();
  if (typeof payload.characterPrompt === "string") cfg.characterPrompt = payload.characterPrompt;
  if (typeof payload.extraNegative === "string") cfg.extraNegative = payload.extraNegative.trim();
  if (typeof payload.referenceImage === "string") cfg.referenceImage = payload.referenceImage.trim();

  if (payload.clearApiKey === true) {
    cfg.encryptedApiKey = "";
  } else if (typeof payload.apiKey === "string" && payload.apiKey.trim()) {
    cfg.encryptedApiKey = encryptApiKey(payload.apiKey.trim());
  }

  try {
    saveConfig();
  } catch (error) {
    return { ok: false, error: `配置保存失败：${error.message}` };
  }
  const info = keyStorageInfo();
  return {
    ok: true,
    hasKey: Boolean(getApiKey()),
    keyStorage: info,
    notice: info.mode === "session" ? "当前系统加密不可用，API Key 仅保存在本次运行内存中，重启后需重新输入。" : "",
  };
});

/* ------------------------------------------------------------------ */
/* IPC：模型                                                             */
/* ------------------------------------------------------------------ */

ipcMain.handle("models:fetch", async () => {
  try {
    const models = await apiService.fetchModels({
      baseUrl: configCache.baseUrl,
      apiKey: getApiKey(),
      signal: undefined,
    });
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

/* ------------------------------------------------------------------ */
/* IPC：AI 提示词辅助                                                     */
/* ------------------------------------------------------------------ */

ipcMain.handle("prompt:assist", async (event, payload = {}) => {
  try {
    const result = await apiService.assistWithPrompt({
      baseUrl: configCache.baseUrl,
      apiKey: getApiKey(),
      /* 界面可临时指定助手模型；否则用已保存的助手模型 */
      model:
        (typeof payload.model === "string" && payload.model.trim()) || configCache.assistantModel,
      mode: payload.mode,
      input: payload.input,
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

/* ------------------------------------------------------------------ */
/* IPC：角色参考图                                                        */
/* ------------------------------------------------------------------ */

ipcMain.handle("reference:pick", async () => {
  const parent = mainWindow || undefined;
  const picked = await dialog.showOpenDialog(parent, {
    title: "选择角色参考图",
    properties: ["openFile"],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });

  if (picked.canceled || !picked.filePaths.length) {
    return { ok: false, canceled: true };
  }

  const source = picked.filePaths[0];
  if (!/\.(png|jpe?g|webp)$/i.test(source)) {
    return { ok: false, error: "请选择 PNG / JPG / WEBP 格式的图片" };
  }

  /* 复制到本地数据目录，使用固定文件名，原图挪走也不影响 */
  const targetDir = ensureDir(referencesDir());
  const target = path.join(targetDir, `character-reference${path.extname(source).toLowerCase()}`);
  try {
    fs.copyFileSync(source, target);
  } catch (error) {
    return { ok: false, error: `复制参考图失败：${error.message}` };
  }

  /* 立刻验证图片能被解码，损坏文件当场提示，而不是等到点生成才报错 */
  try {
    await sharp(target, { failOn: "error" }).stats();
  } catch (error) {
    try { fs.unlinkSync(target); } catch (_) {}
    configCache.referenceImage = "";
    return { ok: false, error: `这张图片无法读取：${error.message}，请换一张图片。` };
  }

  configCache.referenceImage = target;
  saveConfig();
  return { ok: true, path: target };
});

ipcMain.handle("reference:clear", () => {
  configCache.referenceImage = "";
  saveConfig();
  return { ok: true };
});

/* ------------------------------------------------------------------ */
/* IPC：生成海报 · 阶段一（调用 AI 出背景原图，供界面布局编辑）             */
/* ------------------------------------------------------------------ */

/* 当前生成任务的取消控制器（生成阶段可取消；本地合成很快，不需要） */
let generateAbort = null;

/* 从尺寸字符串解析宽高，离线背景沿用该尺寸 */
function sizeToDimensions(sizeStr) {
  const m = /^(\d{3,4})\D+(\d{3,4})$/.exec(String(sizeStr || ""));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1024, h: 1024 };
}

/* 把背景 buffers 落盘到 raws/，返回界面所需结构 */
async function persistRaws(buffers, batch) {
  const rawDir = ensureDir(rawsDir());
  const out = [];

  for (let i = 0; i < buffers.length; i += 1) {
    let pngBuffer;
    try {
      pngBuffer = await sharp(buffers[i]).png().toBuffer();
    } catch (error) {
      throw new Error(`背景图处理失败：${error.message}`);
    }
    const meta = await sharp(pngBuffer).metadata();
    const suffix = buffers.length > 1 ? `-${i + 1}` : "";
    const file = path.join(rawDir, `raw-${batch}${suffix}.png`);
    fs.writeFileSync(file, pngBuffer);

    out.push({
      file,
      dataUrl: `data:image/png;base64,${pngBuffer.toString("base64")}`,
      width: meta.width,
      height: meta.height,
    });
  }
  return out;
}

/* 清空目录内的文件（保留目录本身） */
function emptyDirFiles(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).forEach((name) => {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).isFile()) fs.unlinkSync(file);
    } catch (_) {
      /* 删不掉的文件跳过 */
    }
  });
}

ipcMain.handle("poster:generate", async (event, payload = {}) => {
  /* 已有在途的在线任务时拒绝并发（取消控制器只有一个） */
  if (generateAbort) {
    return { ok: false, error: "已有生成任务进行中，请等待完成或先点「取消生成」。" };
  }

  /* 上一轮的临时背景图统一清掉（合成后不再立即删除，改在新一轮生成开始时清理） */
  emptyDirFiles(rawsDir());

  /* 1. 先把界面设置落盘 */
  const merge = {};
  Object.keys(DEFAULT_CONFIG).forEach((key) => {
    if (payload[key] !== undefined && key !== "encryptedApiKey") merge[key] = payload[key];
  });
  /* 字符串字段统一去掉首尾空白，避免配置与历史记录里混入空格 */
  Object.keys(merge).forEach((key) => {
    if (typeof merge[key] === "string") merge[key] = merge[key].trim();
  });
  Object.assign(configCache, {
    ...merge,
    count: Math.min(4, Math.max(1, Number.parseInt(payload.count, 10) || 1)),
  });
  if (typeof payload.apiKey === "string" && payload.apiKey.trim()) {
    configCache.encryptedApiKey = encryptApiKey(payload.apiKey.trim());
  }
  saveConfig();

  const cfg = configCache;

  /* 2. 社团名是所有模式（含离线）的必填项 */
  if (!cfg.clubName) return { ok: false, error: "请先填写社团名称。" };

  const batch = stamp();

  /* 3. 未配置 API（无地址 / 无 Key / 无模型）→ 直接走离线降级模板 */
  const canCallOnline = Boolean(cfg.baseUrl) && Boolean(getApiKey()) && Boolean(cfg.model);
  if (!canCallOnline) {
    const { w, h } = sizeToDimensions(cfg.size);
    const buffers = [];
    for (let i = 0; i < cfg.count; i += 1) buffers.push(await createOfflineBackground(w, h));
    return {
      ok: true,
      raws: await persistRaws(buffers, batch),
      mode: "离线模板（未配置 API Key 或绘图模型）",
      model: "内置离线背景",
      size: cfg.size,
      offline: true,
    };
  }

  /* 4. 构造提示词，调用 API（本次任务可取消） */
  const prompt = apiService.buildPosterPrompt({
    clubName: cfg.clubName,
    style: cfg.style,
    characterPrompt: cfg.characterPrompt,
  });

  generateAbort = new AbortController();
  let generated;
  try {
    generated = await apiService.generateBackground({
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey: getApiKey(),
      size: cfg.size,
      count: cfg.count,
      prompt,
      referenceFile: cfg.referenceImage,
      negativePrompt: cfg.extraNegative,
      signal: generateAbort.signal,
    });
  } catch (error) {
    const aborted = generateAbort && generateAbort.signal.aborted;
    generateAbort = null;
    if (aborted || /取消/.test(error.message)) {
      return { ok: false, canceled: true, error: "任务已取消。" };
    }

    /* 5. 在线失败（断网/限流/超时）→ 自动降级离线模板，保证永远能出图 */
    const reason = error.message;
    const { w, h } = sizeToDimensions(cfg.size);
    const buffers = [];
    for (let i = 0; i < cfg.count; i += 1) buffers.push(await createOfflineBackground(w, h));
    return {
      ok: true,
      raws: await persistRaws(buffers, batch),
      mode: `离线降级（在线生成失败：${reason}）`,
      model: "内置离线背景",
      size: cfg.size,
      offline: true,
    };
  }
  generateAbort = null;

  /* 6. 成功：背景原图落盘 raws/，返回界面做布局编辑 */
  return {
    ok: true,
    raws: await persistRaws(generated.buffers, batch),
    mode: generated.mode,
    model: generated.model,
    size: generated.size,
  };
});

/* 取消当前生成任务：中断在途 HTTP 请求 */
ipcMain.handle("poster:cancel", () => {
  if (generateAbort) {
    generateAbort.abort();
    return { ok: true };
  }
  return { ok: false };
});

/* ------------------------------------------------------------------ */
/* IPC：生成海报 · 阶段二（按界面布局用 sharp 合成最终海报）               */
/* ------------------------------------------------------------------ */

/* 判断文件是否位于 raws/ 目录内：只允许合成本软件自己落盘的背景原图 */
function isInsideRaws(file) {
  try {
    const rel = path.relative(rawsDir(), path.resolve(file));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch (_) {
    return false;
  }
}

ipcMain.handle("poster:compose", async (event, payload = {}) => {
  const rawFiles = Array.isArray(payload.rawFiles) ? payload.rawFiles : [];
  const elements = Array.isArray(payload.elements) ? payload.elements : [];

  if (!rawFiles.length) return { ok: false, error: "没有可合成的背景原图。" };
  if (!elements.some((el) => el && String(el.text || "").trim())) {
    return { ok: false, error: "布局中没有任何文字区块。" };
  }

  const outDir = ensureDir(outputsDir());
  const batch = stamp();
  const results = [];

  for (let i = 0; i < rawFiles.length; i += 1) {
    const rawFile = rawFiles[i];
    if (!rawFile || !fs.existsSync(rawFile) || !isInsideRaws(rawFile)) continue;

    let finalBuffer;
    try {
      finalBuffer = await addTextToPoster(fs.readFileSync(rawFile), { elements });
    } catch (error) {
      return { ok: false, error: `文字合成失败：${error.message}` };
    }

    const suffix = rawFiles.length > 1 ? `-${i + 1}` : "";
    const file = path.join(outDir, `poster-${batch}${suffix}.jpg`);
    fs.writeFileSync(file, finalBuffer);

    results.push({
      file,
      dataUrl: `data:image/jpeg;base64,${finalBuffer.toString("base64")}`,
    });

    /* 记入「我的海报」历史（缩略图 + 文案） */
    try {
      await addHistoryRecord({ file, buffer: finalBuffer });
    } catch (error) {
      /* 历史写入失败不影响主流程 */
    }
  }

  if (!results.length) return { ok: false, error: "背景原图文件均已丢失，无法合成。" };

  /* 临时原图保留：用户可能修改文字后重新合成；下一轮生成开始时统一清理 */

  return { ok: true, results, outputsDir: outDir };
});

/* ------------------------------------------------------------------ */
/* 海报历史                                                              */
/* ------------------------------------------------------------------ */

function loadHistory() {
  try {
    const raw = fs.readFileSync(historyFile(), "utf8");
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function saveHistory(list) {
  ensureDir(path.dirname(historyFile()));
  fs.writeFileSync(historyFile(), JSON.stringify(list, null, 2), "utf8");
}

/**
 * 新增一条历史：生成缩略图落盘 + 记录文案，超出上限裁剪最旧记录
 */
async function addHistoryRecord({ file, buffer }) {
  ensureDir(historyThumbsDir());
  const id = `h_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const thumbFile = path.join(historyThumbsDir(), `${id}.jpg`);

  const thumbBuffer = await sharp(buffer)
    .resize({ width: 420, withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  fs.writeFileSync(thumbFile, thumbBuffer);

  const c = configCache;
  const record = {
    id,
    createdAt: new Date().toISOString(),
    file,
    thumbFile,
    copy: {
      clubName: c.clubName,
      slogan: c.slogan,
      activityTime: c.activityTime,
      activityLocation: c.activityLocation,
      style: c.style,
    },
  };

  const list = loadHistory();
  list.unshift(record);
  const kept = list.slice(0, HISTORY_LIMIT);

  /* 被裁剪掉的记录：删除其缩略图（海报原图保留） */
  list.slice(HISTORY_LIMIT).forEach((old) => {
    try {
      if (old.thumbFile && fs.existsSync(old.thumbFile)) fs.unlinkSync(old.thumbFile);
    } catch (_) {
      /* 忽略 */
    }
  });

  saveHistory(kept);
  return record;
}

/* 序列化一条记录给界面（附带缩略图 dataUrl，并校验文件状态） */
function serializeRecord(rec) {
  let thumbDataUrl = "";
  try {
    if (rec.thumbFile && fs.existsSync(rec.thumbFile)) {
      thumbDataUrl = `data:image/jpeg;base64,${fs.readFileSync(rec.thumbFile).toString("base64")}`;
    }
  } catch (_) {
    /* 缩略图读取失败留空 */
  }
  return {
    id: rec.id,
    createdAt: rec.createdAt,
    copy: rec.copy || {},
    fileExists: Boolean(rec.file && fs.existsSync(rec.file)),
    thumbDataUrl,
  };
}

ipcMain.handle("history:list", () => {
  const list = loadHistory();

  /* 清理：缩略图已丢失的记录直接移除；顺带落盘 */
  const valid = list.filter(
    (rec) => rec.thumbFile && fs.existsSync(rec.thumbFile)
  );
  if (valid.length !== list.length) saveHistory(valid);

  return { ok: true, records: valid.map(serializeRecord) };
});

/* 读取某条记录的完整海报（用于大图查看） */
ipcMain.handle("history:getImage", (event, payload = {}) => {
  const rec = loadHistory().find((r) => r.id === payload.id);
  if (!rec || !rec.file || !fs.existsSync(rec.file)) {
    return { ok: false, error: "海报原图不存在（可能已被移动或删除），可在文件夹中查找。" };
  }
  return {
    ok: true,
    dataUrl: `data:image/jpeg;base64,${fs.readFileSync(rec.file).toString("base64")}`,
    copy: rec.copy || {},
    file: rec.file,
  };
});

/* 删除历史记录（只删记录与缩略图，海报原图保留在 outputs/） */
ipcMain.handle("history:delete", (event, payload = {}) => {
  const list = loadHistory();
  const target = list.find((r) => r.id === payload.id);
  const next = list.filter((r) => r.id !== payload.id);
  saveHistory(next);
  if (target && target.thumbFile) {
    try {
      if (fs.existsSync(target.thumbFile)) fs.unlinkSync(target.thumbFile);
    } catch (_) {
      /* 忽略 */
    }
  }
  return { ok: true };
});

/* 清空全部历史记录（同样保留海报原图） */
ipcMain.handle("history:clear", () => {
  const list = loadHistory();
  list.forEach((rec) => {
    try {
      if (rec.thumbFile && fs.existsSync(rec.thumbFile)) fs.unlinkSync(rec.thumbFile);
    } catch (_) {
      /* 忽略 */
    }
  });
  saveHistory([]);
  return { ok: true };
});

/* 在系统文件管理器中定位海报原图 */
ipcMain.handle("history:reveal", (event, payload = {}) => {
  const rec = loadHistory().find((r) => r.id === payload.id);
  if (!rec || !rec.file || !fs.existsSync(rec.file)) {
    return { ok: false, error: "海报原图不存在，无法定位。" };
  }
  shell.showItemInFolder(rec.file);
  return { ok: true };
});

/* 把历史海报另存到用户选择的位置 */
ipcMain.handle("history:saveAs", async (event, payload = {}) => {
  const rec = loadHistory().find((r) => r.id === payload.id);
  if (!rec || !rec.file || !fs.existsSync(rec.file)) {
    return { ok: false, error: "海报原图不存在，无法另存。" };
  }
  const picked = await dialog.showSaveDialog(mainWindow, {
    title: "另存海报",
    defaultPath: path.join(app.getPath("pictures"), path.basename(rec.file)),
    filters: [{ name: "JPEG 图片", extensions: ["jpg"] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };

  try {
    fs.copyFileSync(rec.file, picked.filePath);
    return { ok: true, path: picked.filePath };
  } catch (error) {
    return { ok: false, error: `保存失败：${error.message}` };
  }
});

/* ------------------------------------------------------------------ */
/* IPC：另存图片 / 打开输出目录                                           */
/* ------------------------------------------------------------------ */

ipcMain.handle("poster:saveAs", async (event, file) => {
  if (!file || !fs.existsSync(file)) {
    return { ok: false, error: "当前没有可保存的海报文件。" };
  }
  const defaultName = path.basename(file);
  const picked = await dialog.showSaveDialog(mainWindow, {
    title: "保存海报图片",
    defaultPath: path.join(app.getPath("pictures"), defaultName),
    filters: [{ name: "JPEG 图片", extensions: ["jpg"] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };

  try {
    fs.copyFileSync(file, picked.filePath);
    return { ok: true, path: picked.filePath };
  } catch (error) {
    return { ok: false, error: `保存失败：${error.message}` };
  }
});

ipcMain.handle("outputs:open", async () => {
  const dir = ensureDir(outputsDir());
  const message = await shell.openPath(dir);
  return { ok: !message, path: dir, error: message };
});

/* ------------------------------------------------------------------ */
/* IPC：一键复制海报到剪贴板                                               */
/* ------------------------------------------------------------------ */

ipcMain.handle("poster:copyImage", async (event, payload = {}) => {
  const file = payload.file;
  if (!file || !fs.existsSync(file)) {
    return { ok: false, error: "当前没有可复制的海报。" };
  }
  try {
    const buffer = fs.readFileSync(file);
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return { ok: false, error: "图片数据无法识别。" };
    clipboard.writeImage(image);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `复制失败：${error.message}` };
  }
});

/* ------------------------------------------------------------------ */
/* IPC：智能文案（口号 / 拆分 / 一键填充）                                  */
/* ------------------------------------------------------------------ */

ipcMain.handle("smartcopy:run", async (event, payload = {}) => {
  try {
    const result = await apiService.smartCopy({
      baseUrl: configCache.baseUrl,
      apiKey: getApiKey(),
      model:
        (typeof payload.model === "string" && payload.model.trim()) || configCache.assistantModel,
      task: payload.task,
      input: payload.input,
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

/* ------------------------------------------------------------------ */
/* IPC：首次启动引导完成标记                                              */
/* ------------------------------------------------------------------ */

ipcMain.handle("onboarding:done", () => {
  configCache.onboarded = true;
  try {
    saveConfig();
  } catch (_) {
    /* 忽略 */
  }
  return { ok: true };
});

/* ------------------------------------------------------------------ */
/* 应用生命周期                                                          */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  loadConfig();
  ensureDir(outputsDir());
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
