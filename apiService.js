"use strict";

/**
 * apiService.js
 * 多厂商文生图 API 服务（OpenAI 兼容协议）
 *
 * 双通道分流：
 *   - POST /v1/images/generations  图片通道：纯文字出图
 *   - POST /v1/chat/completions    对话通道：Gemini 系图像模型 / 带角色参考图出图
 *
 * 从原聊天机器人插件重构而来，已移除全部宿主依赖（ctx.*），
 * 所有调用参数由调用方显式传入。
 */

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const REQUEST_TIMEOUT_MS = 180000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_IMAGES = 4;

/* 参考图归一化参数：长边像素上限、JPEG 字节目标上限（保证 base64 请求体不超过网关限制） */
const REFERENCE_MAX_EDGE = 1568;
const REFERENCE_TARGET_BYTES = 3 * 1024 * 1024;

/* Gemini 系的图像模型不在 /v1/images/generations 上，要走 /v1/chat/completions */
const CHAT_IMAGE_RE = /gemini|nano-banana|gpt-4o-image/i;

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function whole(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 归一化 Base URL：去掉结尾斜杠与结尾 /v1，最终由本服务统一拼接 /v1/xxx
 */
function normalizeBaseUrl(raw, fallback = "") {
  let base = text(raw, fallback);
  base = base.replace(/\/+$/, "");
  base = base.replace(/\/v1$/i, "");
  return base;
}

function supportsChatImage(model) {
  return CHAT_IMAGE_RE.test(String(model || ""));
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * 把各类 API 错误翻译成用户能看懂的中文说明
 */
function describeApiError(status, raw) {
  const data = parseJson(raw);
  const detail =
    (data && data.error && (data.error.message || data.error.code)) ||
    (data && data.message) ||
    String(raw || "").slice(0, 300);
  const said = String(detail || "");
  const tail = detail ? ` 服务端说：${detail}` : "";
  const hint =
    status === 401
      ? "鉴权失败（401）：API Key 不正确或已过期。"
      : status === 403
        ? "无权限（403）：这个 Key 可能没有调用该模型的权限。"
        : status === 404
          ? "接口不存在（404）：请检查 Base URL 是否写对。"
          : status === 429
            ? "请求被拒（429）：这条渠道当前的额度或频率受限。账户余额够的话，通常是该模型所走的这条上游渠道自己欠费或限流，换一个模型再试。"
            : status === 413
              ? "请求体过大（413）：发送的图片超过了该渠道的限制。"
              : `请求失败（HTTP ${status}）。`;
  let extra = "";
  if (/only imagen/i.test(said)) {
    extra = "（这条图片生成通道的上游只接受 imagen 系列模型，换个模型走别的渠道，别在这一条上耗。）";
  } else if (/not support(ed)? model/i.test(said)) {
    extra = "（这个模型不支持当前这种调用方式，换一个专门画图的模型。）";
  } else if (/missing required parameters|required parameter|invalid_request/i.test(said)) {
    extra = "（请求参数不符合这个模型的要求，多半是选错了模型类型。）";
  }
  return `${hint}${tail}${extra}`;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function httpRequest(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body = null,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal = null,
  } = options;

  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (_) {
      reject(new Error(`接口地址不合法：${url}`));
      return;
    }

    const transport = target.protocol === "https:" ? https : http;
    const payload =
      body == null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");

    const headersOut = { ...headers };
    if (payload) {
      headersOut["Content-Type"] = headersOut["Content-Type"] || "application/json";
      headersOut["Content-Length"] = payload.length;
    }

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: headersOut,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          detach();
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            buffer,
            text: buffer.toString("utf8"),
          });
        });
        res.on("error", (error) => {
          detach();
          reject(error);
        });
      }
    );

    function onAbort() {
      req.destroy(new Error("请求已取消"));
    }

    function detach() {
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    }

    req.on("error", (error) => {
      detach();
      reject(error);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`));
    });

    if (signal) {
      if (signal.aborted) {
        detach();
        reject(new Error("请求已取消"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (payload) req.write(payload);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* 图片解析                                                             */
/* ------------------------------------------------------------------ */

function mimeFromFile(file) {
  const ext = path.extname(String(file || "")).slice(1).toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

function dataUrlToBuffer(value) {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(String(value || ""));
  if (!match) return null;
  try {
    return Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  } catch (_) {
    return null;
  }
}

/**
 * 读取角色参考图并归一化为 JPEG data URL：
 *  - sharp 解码，rotate() 按 EXIF 自动旋正（手机照片才不会躺倒或倒置）
 *  - 长边超过 1568 才等比缩小（只缩不放）
 *  - 统一转 JPEG，质量按结果大小自适应（85 → 75 → 62）
 * 任何体积的照片都能发出去，请求体通常只有几百 KB，从根本上避开
 * “8MB 上限”与网关 413/400 两类失败。
 */
async function readReferenceAsDataUrl(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`找不到参考图：${file}`);
  }

  let pipeline;
  try {
    pipeline = sharp(file, { failOn: "error" }).rotate();
    const meta = await pipeline.metadata();
    const longEdge = Math.max(meta.width || 0, meta.height || 0);
    if (longEdge > REFERENCE_MAX_EDGE) {
      pipeline = pipeline.resize(
        meta.width >= meta.height
          ? { width: REFERENCE_MAX_EDGE, withoutEnlargement: true }
          : { height: REFERENCE_MAX_EDGE, withoutEnlargement: true }
      );
    }
  } catch (error) {
    throw new Error(
      `参考图读取失败：${error.message}。图片可能已损坏，请换一张 PNG / JPG / WEBP 图片。`
    );
  }

  let lastBuffer = null;
  for (const quality of [85, 75, 62]) {
    const buffer = await pipeline.jpeg({ quality }).toBuffer();
    lastBuffer = buffer;
    if (buffer.length <= REFERENCE_TARGET_BYTES) {
      return `data:image/jpeg;base64,${buffer.toString("base64")}`;
    }
  }

  /* 最低质量仍偏大（极少见）：用最小结果继续，不阻塞用户 */
  return `data:image/jpeg;base64,${lastBuffer.toString("base64")}`;
}

/**
 * 从各种形态的响应 JSON（images 通道 / chat 通道 / 各家厂商魔改字段）里
 * 尽可能把图片地址或 data URL 全部挖出来
 */
function extractImageUrls(data, raw) {
  const urls = [];
  const push = (value) => {
    if (typeof value !== "string" || !value.trim()) return;
    const clean = value.trim();
    if (!urls.includes(clean)) urls.push(clean);
  };

  const scanText = (value) => {
    if (typeof value !== "string" || !value) return;
    const dataUrls = value.match(/data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=\s]+/gi) || [];
    dataUrls.forEach((item) => push(item.replace(/\s+/g, "")));
    const markdown = value.match(/!\[[^\]]*\]\(\s*(https?:[^\s)]+)\s*\)/gi) || [];
    markdown.forEach((item) => {
      const inner = /\((https?:[^\s)]+)\)/.exec(item);
      if (inner) push(inner[1]);
    });
    const bare = value.match(/https?:\/\/[^\s"')\]]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"')]*)?/gi) || [];
    bare.forEach(push);
  };

  const visit = (node) => {
    if (!node) return;
    if (typeof node === "string") {
      scanText(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;

    if (typeof node.b64_json === "string" && node.b64_json) {
      push(`data:image/png;base64,${node.b64_json}`);
      return;
    }
    if (node.inline_data && node.inline_data.data) {
      push(`data:${node.inline_data.mime_type || "image/png"};base64,${node.inline_data.data}`);
      return;
    }
    if (node.source && node.source.data) {
      push(`data:${node.source.media_type || "image/png"};base64,${node.source.data}`);
      return;
    }
    if (typeof node.url === "string") push(node.url);
    if (typeof node.image_url === "string") push(node.image_url);
    if (node.image_url && typeof node.image_url.url === "string") push(node.image_url.url);

    Object.keys(node).forEach((key) => {
      if (key === "b64_json" || key === "url" || key === "image_url" || key === "inline_data" || key === "source") return;
      visit(node[key]);
    });
  };

  if (data && typeof data === "object") {
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (choice) visit(choice.message || choice.delta || choice.text || choice);
    if (Array.isArray(data.data)) visit(data.data);
    if (data.output) visit(data.output);
    if (Array.isArray(data.content)) visit(data.content);
  }
  if (!urls.length && raw) scanText(String(raw));
  return urls;
}

async function loadImageBuffer(url, apiKey, signal) {
  const inline = dataUrlToBuffer(url);
  if (inline) return inline;
  if (!/^https?:/i.test(url)) return null;
  const dl = await httpRequest(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    signal,
  }).catch(() => null);
  if (dl && dl.status >= 200 && dl.status < 300 && dl.buffer.length) return dl.buffer;
  return null;
}

/* ------------------------------------------------------------------ */
/* 模型列表                                                             */
/* ------------------------------------------------------------------ */

async function fetchModels({ baseUrl, apiKey, defaultBaseUrl, signal }) {
  if (!apiKey) throw new Error("还没有填写 API Key");
  const res = await httpRequest(`${normalizeBaseUrl(baseUrl, defaultBaseUrl)}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(describeApiError(res.status, res.text));
  const data = parseJson(res.text);
  const list = data && Array.isArray(data.data) ? data.data : [];
  return list
    .map((item) => (typeof item === "string" ? item : item && (item.id || item.name)))
    .filter(Boolean)
    .map((item) => String(item))
    .sort();
}

/* ------------------------------------------------------------------ */
/* 提示词构造                                                            */
/* ------------------------------------------------------------------ */

/**
 * 海报背景提示词
 * 基础：大学社团招新海报背景图，百团大战，社团名为[社团名]，风格为[风格]，
 *       高质量，画面留出大面积空白区域用于后期排版
 * 角色：填写了角色描述模板时，追加 “[角色描述模板], 上述海报场景”
 */
function buildPosterPrompt({ clubName, style, characterPrompt }) {
  const club = text(clubName, "某社团");
  const styleName = text(style, "扁平插画");

  const base =
    `大学社团招新海报背景图，百团大战，社团名为${club}，风格为${styleName}，` +
    `高质量，画面留出大面积空白区域用于后期排版`;

  const character = text(characterPrompt, "");
  if (!character) return base;
  return `${base}；${character}, 上述海报场景`;
}

/* ------------------------------------------------------------------ */
/* 两个通道                                                              */
/* ------------------------------------------------------------------ */

/**
 * 图片通道：POST /v1/images/generations
 * @returns {Promise<string[]>} 图片 URL / data URL 列表
 */
async function callImagesEndpoint({
  baseUrl,
  defaultBaseUrl,
  model,
  prompt,
  apiKey,
  n,
  size,
  negativePrompt,
  signal,
}) {
  const payload = { model, prompt, n, size };
  if (negativePrompt) payload.negative_prompt = negativePrompt;

  let res;
  try {
    res = await httpRequest(`${normalizeBaseUrl(baseUrl, defaultBaseUrl)}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      body: payload,
      signal,
    });
  } catch (error) {
    if (signal && signal.aborted) throw new Error("任务已取消");
    throw new Error(`连不上接口：${error.message}。请检查 Base URL 与网络。`);
  }

  if (res.status < 200 || res.status >= 300) throw new Error(describeApiError(res.status, res.text));

  const urls = extractImageUrls(parseJson(res.text), res.text);
  if (!urls.length) {
    throw new Error(`接口没有返回图片数据。原始返回：${String(res.text || "").slice(0, 300)}`);
  }
  return urls;
}

/**
 * 对话通道：POST /v1/chat/completions
 * Gemini 系图像模型、以及需要传角色参考图的场景走这里
 * @returns {Promise<string[]>} 图片 URL / data URL 列表
 */
async function callChatEndpoint({
  baseUrl,
  defaultBaseUrl,
  model,
  prompt,
  apiKey,
  imageDataUrl,
  signal,
}) {
  const content = [{ type: "text", text: prompt }];
  if (imageDataUrl) content.push({ type: "image_url", image_url: { url: imageDataUrl } });

  let res;
  try {
    res = await httpRequest(`${normalizeBaseUrl(baseUrl, defaultBaseUrl)}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      body: { model, messages: [{ role: "user", content }] },
      signal,
    });
  } catch (error) {
    if (signal && signal.aborted) throw new Error("任务已取消");
    throw new Error(`对话通道连不上接口：${error.message}`);
  }

  if (res.status < 200 || res.status >= 300) throw new Error(describeApiError(res.status, res.text));

  const urls = extractImageUrls(parseJson(res.text), res.text);
  if (!urls.length) {
    throw new Error(`接口没有返回图片。原始返回：${String(res.text || "").slice(0, 300)}`);
  }
  return urls;
}

async function collectBuffers({ urls, apiKey, n, signal }) {
  const buffers = [];
  for (const url of urls.slice(0, n)) {
    if (signal && signal.aborted) break;
    const buffer = await loadImageBuffer(url, apiKey, signal);
    if (buffer && buffer.length) buffers.push(buffer);
  }
  if (!buffers.length) throw new Error("图片数据解析失败，没有拿到任何有效图片。");
  return buffers;
}

/* ------------------------------------------------------------------ */
/* 对外主入口：生成海报背景图                                            */
/* ------------------------------------------------------------------ */

/**
 * 通道选择规则：
 *   - 有角色参考图 → 对话通道传图（若模型本身不是对话通道，也按用户意图强制走对话通道）
 *   - 无参考图但模型属于 Gemini/nano-banana/gpt-4o-image 系 → 对话通道
 *   - 其余 → 图片通道
 * 参考图对话通道失败时，自动回退图片通道纯文字出图（保留原插件的健壮逻辑）。
 *
 * @returns {Promise<{buffers: Buffer[], mode: string, model: string, size: string}>}
 */
async function generateBackground(options = {}) {
  const {
    baseUrl,
    defaultBaseUrl,
    model,
    apiKey,
    size = "1024x1024",
    count = 1,
    prompt,
    referenceFile = "",
    negativePrompt = "",
    signal = null,
  } = options;

  if (!text(model)) throw new Error("还没有选择绘图模型。");
  if (!apiKey) throw new Error("还没有填写 API Key。");
  const finalPrompt = text(prompt, "");
  if (!finalPrompt) throw new Error("提示词是空的，不知道要画什么。");

  const n = whole(count, 1, MAX_IMAGES, 1);
  const finalSize = text(size, "1024x1024");
  const reference = text(referenceFile, "");
  const useChat = Boolean(reference) || supportsChatImage(model);

  if (useChat) {
    let imageDataUrl = "";
    let chatPrompt = finalPrompt;
    let mode = "对话通道";
    if (reference) {
      imageDataUrl = await readReferenceAsDataUrl(reference);
      chatPrompt =
        `${finalPrompt}\n\n` +
        "海报中的角色必须与参考图完全相同：保持脸型五官、发色与发型、瞳色、体型和整体画风不变，" +
        "只改变场景、动作、表情、服装细节与光线。不要换成别的角色，也不要重新设计其长相。";
      mode = "参考图·对话通道";
    }

    try {
      const urls = await callChatEndpoint({
        baseUrl,
        defaultBaseUrl,
        model,
        prompt: chatPrompt,
        apiKey,
        imageDataUrl,
        signal,
      });
      const buffers = await collectBuffers({ urls, apiKey, n, signal });
      return { buffers, mode, model, size: finalSize };
    } catch (chatError) {
      // 参考图那条路没走通：回退纯文字图片通道，并把原因附在模式说明里
      if (reference) {
        const first = chatError && chatError.message ? chatError.message : String(chatError);
        try {
          const urls = await callImagesEndpoint({
            baseUrl,
            defaultBaseUrl,
            model,
            prompt: finalPrompt,
            apiKey,
            n,
            size: finalSize,
            negativePrompt,
            signal,
          });
          const buffers = await collectBuffers({ urls, apiKey, n, signal });
          return {
            buffers,
            mode: `纯文字·图片通道（参考图通道失败：${first}）`,
            model,
            size: finalSize,
          };
        } catch (imageError) {
          const second = imageError && imageError.message ? imageError.message : String(imageError);
          throw new Error(`参考图通道失败：${first} ｜ 纯文字通道也失败：${second}`);
        }
      }
      throw chatError;
    }
  }

  const urls = await callImagesEndpoint({
    baseUrl,
    defaultBaseUrl,
    model,
    prompt: finalPrompt,
    apiKey,
    n,
    size: finalSize,
    negativePrompt,
    signal,
  });
  const buffers = await collectBuffers({ urls, apiKey, n, signal });
  return { buffers, mode: "纯文字·图片通道", model, size: finalSize };
}

/* ------------------------------------------------------------------ */
/* AI 提示词辅助（对话模型）                                              */
/* ------------------------------------------------------------------ */

const ASSIST_MODES = {
  /* 简单中文想法 → Danbooru 风格英文 tag 串 */
  character:
    "你是一位资深的 AI 绘画提示词工程师，熟悉 Stable Diffusion / NovelAI / Danbooru 的 tag 体系。" +
    "请把用户给出的简单角色想法扩写成一段专业的英文图像生成提示词：" +
    "依次补充角色的性别、年龄感、脸型五官、发色发型、瞳色、表情、服装、配饰、动作姿态、画面视角，" +
    "并在结尾追加画质与风格词（如 masterpiece, best quality, ultra detailed, beautiful lighting）。" +
    "要求：全部使用英文，以逗号分隔的 tag 短语形式输出，不要输出完整句子；" +
    "不要解释、不要标题、不要输出任何中文，只输出提示词本身。",

  /* 社团名 + 风格 → 详细的海报背景画面描述 */
  scene:
    "你是一位资深的 AI 海报美术指导。用户会给出社团名称、海报风格以及补充想法，" +
    "请输出一段详细的中文画面描述，用于生成大学社团招新海报的背景图：" +
    "具体描写场景环境、构图方式、主体元素与道具、光影方向、色调、材质质感和整体氛围。" +
    "要求：画面要为后期文字排版留出大面积干净的空白区域；" +
    "不要描写任何文字、标题、字母或排版内容；不要解释、不要分点、不要加标题，只输出画面描述本身，120 字以内。",

  /* 中英互译：自动判断方向 */
  translate:
    "你是专业的 AI 绘画提示词翻译。请判断输入语言：若为中文，则翻译成地道的英文图像生成 prompt（可用逗号分隔的短语）；" +
    "若为英文，则翻译成通顺自然的中文。只输出翻译结果，不要解释、不要加任何前后缀。",

  /* 预设场景模板专用：简短主题 → 高质量英文海报 Prompt */
  poster:
    "你是一个专业的大学社团海报设计师。请将用户提供的简短主题，扩写为一段适合文生图模型的高质量英文Prompt。" +
    "要求包含：主题描述、画面风格、光影效果、画质修饰词。" +
    "最重要的：必须在Prompt末尾加上 'large blank space in the center for text layout'（中心留出大面积空白用于排版）。" +
    "只输出 Prompt 本身，使用英文，不要解释、不要分点、不要加标题。",
};

/* 预设场景模板：点击后把 topic（注入社团名）作为简短主题交给 poster 模式 */
const SCENE_TEMPLATES = [
  {
    id: "anime-recruit",
    name: "动漫社招新",
    topic:
      "大学动漫社团在百团大战摆摊招新的海报，二次元动漫风格，社团展位前聚集着热情的同学，" +
      "现场摆放漫画、周边与手绘展板，青春活泼、热闹欢快的氛围",
  },
  {
    id: "esports-match",
    name: "电竞比赛",
    topic:
      "校园电竞比赛宣传海报，赛博朋克科技感，选手戴着耳机在炫彩键盘前专注对战，" +
      "背景是超大屏幕与霓虹灯光，蓝紫色调，热血竞技、紧张刺激的氛围",
  },
  {
    id: "academic-lecture",
    name: "学术讲座",
    topic:
      "大学学术讲座宣传海报，安静明亮的报告厅场景，讲台上有投影幕布与麦克风，" +
      "座椅整齐，专业简约风格，柔和自然光，蓝白配色，严谨求知、宁静致远的学术氛围",
  },
];

/**
 * 调用对话模型完成提示词辅助
 * @param {string} options.baseUrl     接口根地址
 * @param {string} options.apiKey      API Key
 * @param {string} options.model       文本辅助（对话）模型名
 * @param {string} options.mode        character / scene / translate / poster
 * @param {string} options.input       用户输入
 * @param {object} options.signal      AbortSignal（可选）
 * @returns {Promise<string>} 模型生成的文本
 */
async function assistWithPrompt({ baseUrl, apiKey, model, mode, input, signal = null }) {
  const system = ASSIST_MODES[mode];
  if (!system) throw new Error(`未知的提示词辅助模式：${mode}`);
  if (!text(baseUrl)) throw new Error("还没有配置 Base URL。");
  if (!apiKey) throw new Error("还没有填写 API Key。");
  if (!text(model)) throw new Error("还没有选择文本辅助模型（请在「图像生成设置」里选择一个对话模型）。");
  const userInput = text(input, "");
  if (!userInput) throw new Error("请先在辅助输入框里填写内容。");

  let res;
  try {
    res = await httpRequest(`${normalizeBaseUrl(baseUrl)}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      body: {
        model,
        temperature: 0.7,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userInput },
        ],
      },
      signal,
    });
  } catch (error) {
    if (signal && signal.aborted) throw new Error("任务已取消");
    throw new Error(`连不上接口：${error.message}。请检查 Base URL 与网络。`);
  }

  if (res.status < 200 || res.status >= 300) throw new Error(describeApiError(res.status, res.text));

  const data = parseJson(res.text);
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content || !String(content).trim()) {
    throw new Error(`助手模型没有返回有效内容。原始返回：${String(res.text || "").slice(0, 300)}`);
  }
  return String(content).trim();
}

/* ------------------------------------------------------------------ */
/* 智能文案（口号 / 时间地点拆分 / 一键填充）                               */
/* ------------------------------------------------------------------ */

const SMART_COPY_TASKS = {
  /* 社团名（可带补充）→ 一句招新口号 */
  slogan:
    "你是大学社团招新文案高手。请根据用户给出的社团名称（可能附有补充信息），" +
    "创作一句朗朗上口、有感染力、适合印在招新海报上的中文口号：16 字以内，可押韵、可用对仗，" +
    "要紧扣社团特点、有号召力。只输出口号本身，不要引号、不要编号、不要解释。",

  /* 一段含时间地点的文字 → 拆分为 JSON */
  parse:
    "你是信息抽取助手。请从用户输入的中文句子中提取活动时间与活动地点，" +
    "并严格按以下 JSON 格式输出（字段不存在则输出空字符串，不要输出 JSON 以外的任何内容，不要代码块）：\n" +
    '{"activityTime":"","activityLocation":""}',

  /* 一段杂乱信息 → 填充全部文案字段 */
  fullfill:
    "你是大学社团招新信息整理助手。请分析用户输入的中文内容（可能包含社团名称、活动口号、时间、地点等零散信息），" +
    "缺失的信息请根据社团名称合理补全（口号需原创、时间地点给出合理的校园场景占位值）。" +
    "严格按以下 JSON 格式输出，不要输出 JSON 以外的任何内容，不要代码块：\n" +
    '{"clubName":"","slogan":"","activityTime":"","activityLocation":""}',
};

/** 从模型输出里提取第一个 JSON 对象（兼容误带 ```json 代码块的情况） */
function extractJsonObject(text) {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "").replace(/```/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return parseJson(cleaned.slice(start, end + 1));
}

/**
 * 智能文案处理
 * @param {string} options.task   slogan / parse / fullfill
 * @returns {Promise<object>} slogan → { slogan }；parse/fullfill → 对应字段对象
 */
async function smartCopy({ baseUrl, apiKey, model, task, input, signal = null }) {
  const system = SMART_COPY_TASKS[task];
  if (!system) throw new Error(`未知的智能文案任务：${task}`);
  if (!apiKey) throw new Error("还没有填写 API Key。");
  if (!text(model)) throw new Error("还没有选择文本辅助模型。");
  const userInput = text(input, "");
  if (!userInput) throw new Error("请先填写内容。");

  let res;
  try {
    res = await httpRequest(`${normalizeBaseUrl(baseUrl)}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      body: {
        model,
        temperature: 0.6,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userInput },
        ],
      },
      signal,
    });
  } catch (error) {
    if (signal && signal.aborted) throw new Error("任务已取消");
    throw new Error(`连不上接口：${error.message}。`);
  }

  if (res.status < 200 || res.status >= 300) throw new Error(describeApiError(res.status, res.text));

  const data = parseJson(res.text);
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content || !String(content).trim()) throw new Error("模型没有返回有效内容。");

  if (task === "slogan") {
    return { slogan: String(content).trim().replace(/^[“"']|[”"']$/g, "") };
  }

  const parsed = extractJsonObject(content);
  if (!parsed) throw new Error(`无法解析模型返回的 JSON：${String(content).slice(0, 200)}`);
  return parsed;
}

module.exports = {
  MAX_IMAGES,
  SCENE_TEMPLATES,
  assistWithPrompt,
  buildPosterPrompt,
  describeApiError,
  fetchModels,
  generateBackground,
  normalizeBaseUrl,
  readReferenceAsDataUrl,
  smartCopy,
  supportsChatImage,
};
