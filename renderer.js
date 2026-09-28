"use strict";

/**
 * renderer.js
 * AI百团大战海报生成器 · 渲染进程
 * 只通过 window.api（preload 暴露的 IPC 桥）与主进程通信。
 */

const $ = (id) => document.getElementById(id);

/* 把任意值转义为安全的 HTML 文本；凡是要插进 innerHTML 的动态内容（错误信息、模型名、路径等）都先过这一道 */
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let vendorPresets = [];
let currentResults = [];
let currentIndex = 0;
let appConfig = null;

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
/* ------------------------------------------------------------------ */

function setSideStatus(message, kind) {
  const el = $("modelStatus");
  el.textContent = message || "";
  el.className = "status" + (kind ? " " + kind : "");
}

function setGenStatus(message, kind) {
  const el = $("genStatusBar");
  el.innerHTML = message || "";
  el.className = kind || "";
}

/* 通用弹窗显示/隐藏（flex 居中） */
function showModal(id) {
  $(id).style.display = "flex";
}
function hideModal(id) {
  $(id).style.display = "none";
}

/* 本地文件路径 → 可显示的 file:/// URL（页面本身为 file:// 源，允许访问） */
function fileToUrl(p) {
  if (!p) return "";
  let s = String(p).replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  return "file://" + s;
}

function selectedModel() {
  const manual = $("modelManual").value.trim();
  if (manual) return manual;
  return $("model").value.trim();
}

function selectedAssistantModel() {
  const manual = $("assistantModelManual").value.trim();
  if (manual) return manual;
  return $("assistantModel").value.trim();
}

function collectForm() {
  return {
    vendor: $("vendor").value,
    baseUrl: $("baseUrl").value.trim(),
    apiKey: $("apiKey").value,
    model: selectedModel(),
    assistantModel: selectedAssistantModel(),
    size: $("size").value,
    count: Number($("count").value) || 1,
    clubName: $("clubName").value.trim(),
    slogan: $("slogan").value.trim(),
    activityTime: $("activityTime").value.trim(),
    activityLocation: $("activityLocation").value.trim(),
    style: $("style").value,
    characterPrompt: $("characterPrompt").value,
    extraNegative: $("extraNegative").value.trim(),
    referenceImage: $("referenceImage").value.trim(),
  };
}

/* ------------------------------------------------------------------ */
/* 初始化：载入配置                                                       */
/* ------------------------------------------------------------------ */

async function init() {
  const cfg = await window.api.getConfig();
  appConfig = cfg;
  vendorPresets = cfg.vendors || [];
  renderSceneTemplates(cfg.sceneTemplates || []);

  /* 厂商下拉 */
  const vendorSelect = $("vendor");
  vendorSelect.innerHTML = "";
  vendorPresets.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.name;
    vendorSelect.appendChild(opt);
  });
  vendorSelect.value = cfg.vendor || "custom";

  $("baseUrl").value = cfg.baseUrl || "";
  $("modelManual").value = "";
  $("assistantModelManual").value = "";
  $("count").value = cfg.count || 1;
  $("clubName").value = cfg.clubName || "";
  $("slogan").value = cfg.slogan || "";
  $("activityTime").value = cfg.activityTime || "";
  $("activityLocation").value = cfg.activityLocation || "";
  $("style").value = cfg.style || "扁平插画";
  $("characterPrompt").value = cfg.characterPrompt || "";
  $("extraNegative").value = cfg.extraNegative || "";
  $("referenceImage").value = cfg.referenceImage || "";

  /* 尺寸 */
  if (cfg.size) {
    const exists = Array.from($("size").options).some((o) => o.value === cfg.size);
    if (exists) $("size").value = cfg.size;
  }

  /* 模型：已保存的模型先放进下拉（拉取后会被完整列表替换） */
  const modelSelect = $("model");
  modelSelect.innerHTML = "";
  if (cfg.model) {
    const opt = document.createElement("option");
    opt.value = cfg.model;
    opt.textContent = cfg.model;
    opt.selected = true;
    modelSelect.appendChild(opt);
  } else {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "（请先拉取模型列表）";
    modelSelect.appendChild(opt);
  }

  /* 助手模型：已保存的先放进下拉（拉取后会被完整列表替换） */
  const assistantSelect = $("assistantModel");
  assistantSelect.innerHTML = "";
  const assistantEmpty = document.createElement("option");
  assistantEmpty.value = "";
  assistantEmpty.textContent = "（拉取模型列表后选择）";
  assistantSelect.appendChild(assistantEmpty);
  if (cfg.assistantModel) {
    const opt = document.createElement("option");
    opt.value = cfg.assistantModel;
    opt.textContent = cfg.assistantModel;
    opt.selected = true;
    assistantSelect.appendChild(opt);
  }

  /* Key 状态 */
  updateKeyState(cfg.hasKey, cfg.keyStorage);

  /* 参考图缩略图 */
  showReferencePreview(cfg.referenceImage);
}

function updateKeyState(hasKey, keyStorage) {
  const el = $("keyState");
  el.textContent = hasKey ? "Key 已加密保存" : "未填写 Key";
  el.className = "pill" + (hasKey ? " ok" : " warn");
  if (keyStorage && keyStorage.backend) el.title = `存储方式：${keyStorage.backend}`;
}

function showReferencePreview(pathValue) {
  const img = $("refPreview");
  if (pathValue) {
    img.src = fileToUrl(pathValue);
    img.style.display = "block";
  } else {
    img.removeAttribute("src");
    img.style.display = "none";
  }
}

/* ------------------------------------------------------------------ */
/* 厂商切换：自动填 Base URL                                             */
/* ------------------------------------------------------------------ */

$("vendor").addEventListener("change", () => {
  const picked = vendorPresets.find((v) => v.id === $("vendor").value);
  if (picked && picked.baseUrl) $("baseUrl").value = picked.baseUrl;
});

/* ------------------------------------------------------------------ */
/* 拉取模型列表                                                          */
/* ------------------------------------------------------------------ */

/* 用完整模型列表填充下拉，保留之前的选择 */
function populateModelSelect(select, models, previous, emptyLabel) {
  select.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = emptyLabel;
  select.appendChild(empty);
  models.forEach((id) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    if (id === previous) opt.selected = true;
    select.appendChild(opt);
  });
}

$("fetchModels").addEventListener("click", async () => {
  const btn = $("fetchModels");
  btn.disabled = true;
  setSideStatus("正在拉取模型列表…");

  /* 先记录两个下拉的当前选择 */
  const prevModel = $("model").value;
  const prevAssistant = $("assistantModel").value;

  const result = await window.api.fetchModels();
  btn.disabled = false;

  if (!result.ok) {
    setSideStatus(result.error, "err");
    return;
  }

  if (!result.models.length) {
    setSideStatus("接口返回了 0 个模型，可手动输入模型名。", "err");
    return;
  }

  populateModelSelect($("model"), result.models, prevModel, "（请选择绘图模型）");
  populateModelSelect($("assistantModel"), result.models, prevAssistant, "（请选择助手模型）");
  setSideStatus(`已拉取 ${result.models.length} 个模型，请分别选择绘图模型与助手模型。`, "ok");
});

/* ------------------------------------------------------------------ */
/* 保存配置                                                              */
/* ------------------------------------------------------------------ */

$("saveConfigBtn").addEventListener("click", async () => {
  const form = collectForm();
  const result = await window.api.saveConfig(form);
  if (result.ok) {
    $("apiKey").value = "";
    updateKeyState(result.hasKey, result.keyStorage);
    setSideStatus(
      `配置已保存，API Key 经${result.keyStorage ? result.keyStorage.backend : "加密"}处理。` +
        (result.notice ? `注意：${result.notice}` : ""),
      "ok"
    );
  } else {
    setSideStatus(result.error || "保存失败", "err");
  }
});

/* ------------------------------------------------------------------ */
/* 角色参考图                                                             */
/* ------------------------------------------------------------------ */

$("pickRef").addEventListener("click", async () => {
  const result = await window.api.pickReference();
  if (result.ok) {
    $("referenceImage").value = result.path;
    showReferencePreview(result.path);
    setSideStatus("参考图已就绪（生成时会自动压缩后发送，原图再大也不怕）。", "ok");
  } else if (!result.canceled) {
    setSideStatus(result.error || "选择参考图失败", "err");
  }
});

$("clearRef").addEventListener("click", async () => {
  await window.api.clearReference();
  $("referenceImage").value = "";
  showReferencePreview("");
  setSideStatus("已清除参考图。", "ok");
});

/* ------------------------------------------------------------------ */
/* 生成海报（核心链路）                                                   */
/* ------------------------------------------------------------------ */

$("generateBtn").addEventListener("click", () => {
  const form = collectForm();

  /* 社团名是唯一硬性必填；未填 Key/模型时自动走离线模板 */
  if (!form.clubName) {
    setGenStatus("请先填写社团名称（其余内容可以都交给 AI）", "err");
    return;
  }

  openConfirmModal(form);
});

/* 生成前确认弹窗 */
function openConfirmModal(form) {
  /* 已保存 Key（appConfig.hasKey）或表单里刚输入了新 Key，都算在线，避免弹窗显示与实际行为不一致 */
  const online = Boolean(
    form.baseUrl && form.model && appConfig && (appConfig.hasKey || form.apiKey.trim())
  );
  const sizeLabel = ($("size").selectedOptions[0] || {}).text || form.size;
  const lines = [];
  lines.push(["生成方式", online ? "在线 AI 生图" : "离线模板（渐变背景 + 文字排版）"]);
  lines.push(["调用模型", online ? form.model : "内置离线模板，不调用网络"]);
  lines.push(["图片尺寸", sizeLabel]);
  lines.push(["生成张数", `${form.count} 张`]);

  const body = $("confirmBody");
  body.innerHTML = lines
    .map(
      ([k, v]) =>
        `<div class="info-line"><span class="k">${k}</span><span>${escapeHtml(v)}</span></div>`
    )
    .join("");
  if (online) {
    const per = form.count * 30;
    body.insertAdjacentHTML(
      "beforeend",
      `<div class="note">预估耗时：每张约 15～60 秒，共约 ${per} 秒（视服务商与排队情况而定）。<br>费用：以服务商实际计费为准，本软件不收取任何费用。生成期间可点「取消生成」中断。</div>`
    );
  } else {
    body.insertAdjacentHTML(
      "beforeend",
      `<div class="note">未配置 API Key / 模型，或当前处于离线状态：将瞬间生成，不耗时、不产生任何费用，保证永远能出一张海报。</div>`
    );
  }

  showModal("confirmModal");
  $("confirmOk").onclick = () => {
    hideModal("confirmModal");
    runGenerate(form);
  };
}

$("confirmCancel").addEventListener("click", () => hideModal("confirmModal"));

/* 实际执行生成（含取消按钮与离线提示） */
async function runGenerate(form) {
  const btn = $("generateBtn");
  btn.disabled = true;
  btn.style.display = "none";
  $("cancelBtn").style.display = "";
  $("saveBtn").disabled = true;
  $("copyBtn").disabled = true;
  $("editTextBtn").disabled = true;
  setGenStatus('<span class="spin"></span> 正在构思画面…（可随时点「取消生成」中断）');

  let result;
  try {
    result = await window.api.generatePoster(form);
  } catch (error) {
    restoreGenerateButton();
    setGenStatus(`生成失败：${escapeHtml(error.message || error)}`, "err");
    return;
  }

  restoreGenerateButton();

  if (!result.ok) {
    if (result.canceled) {
      setGenStatus("已取消生成，本次请求已中断。", "err");
    } else {
      setGenStatus(`生成失败：${escapeHtml(result.error)}`, "err");
    }
    return;
  }

  /* 阶段一完成：进入布局编辑（全新布局，撤销/重做栈清空） */
  raws = result.raws;
  elements = buildDefaultLayout(raws[0].width, raws[0].height, form);
  selectedId = null;
  undoStack = [];
  redoStack = [];
  refreshHistoryButtons();
  openEditor(raws[0]);

  if (result.offline) {
    setGenStatus(
      `已使用${escapeHtml(result.mode || "离线模板")}生成 ${raws.length} 张：可继续拖动文字、套用版式后合成。配置 API Key 后即可使用 AI 背景。`,
      "ok"
    );
  } else {
    setGenStatus(
      `背景图已构思完成（通道：${escapeHtml(result.mode)}｜模型：${escapeHtml(result.model)}｜共 ${raws.length} 张）：` +
        "拖动文字区块（自动吸附）、套用版式，再点「应用布局并合成」",
      "ok"
    );
  }
}

function restoreGenerateButton() {
  $("generateBtn").disabled = false;
  $("generateBtn").style.display = "";
  $("cancelBtn").style.display = "none";
}

/* 取消生成 */
$("cancelBtn").addEventListener("click", async () => {
  $("cancelBtn").disabled = true;
  try {
    await window.api.cancelGenerate();
  } finally {
    $("cancelBtn").disabled = false;
  }
});

/* ================================================================== */
/* 布局编辑器                                                            */
/* ================================================================== */

let raws = [];
let elements = [];
let selectedId = null;

/* ------------------------------------------------------------------ */
/* 撤销 / 重做：保存「元素列表」的整体快照（元素是纯数据，可直接 JSON 深拷贝） */
/* ------------------------------------------------------------------ */

const HISTORY_LIMIT = 60;
let undoStack = [];
let redoStack = [];

/* 在任何修改元素的操作「之前」调用：保存当前状态，并清空重做栈 */
function pushHistory() {
  undoStack.push(JSON.stringify(elements));
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  refreshHistoryButtons();
}

/* 撤销 / 重做后恢复元素；选中块若已不存在则取消选中 */
function restoreElements(json) {
  elements = JSON.parse(json);
  if (selectedId && !elements.some((e) => e.id === selectedId)) {
    selectedId = null;
  }
  renderBlocks();
  if (selectedId) syncBlockControls(elements.find((e) => e.id === selectedId));
}

function undo() {
  if (!undoStack.length) {
    setGenStatus("没有可撤销的操作。");
    return;
  }
  redoStack.push(JSON.stringify(elements));
  restoreElements(undoStack.pop());
  refreshHistoryButtons();
  setGenStatus("已撤销上一步操作。");
}

function redo() {
  if (!redoStack.length) {
    setGenStatus("没有可重做的操作。");
    return;
  }
  undoStack.push(JSON.stringify(elements));
  restoreElements(redoStack.pop());
  refreshHistoryButtons();
  setGenStatus("已重做。");
}

/* 根据栈状态启用/停用撤销重做按钮 */
function refreshHistoryButtons() {
  $("undoBtn").disabled = undoStack.length === 0;
  $("redoBtn").disabled = redoStack.length === 0;
}

$("undoBtn").addEventListener("click", undo);
$("redoBtn").addEventListener("click", redo);

/* 快捷键：Ctrl+Z 撤销；Ctrl+Y 或 Ctrl+Shift+Z 重做（编辑器隐藏 / 输入控件内不生效） */
window.addEventListener("keydown", (ev) => {
  if (!(ev.ctrlKey || ev.metaKey)) return;
  if ($("editorStage").style.display === "none") return;
  const tag = (ev.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;

  const key = ev.key.toLowerCase();
  if (key === "z") {
    ev.preventDefault();
    if (ev.shiftKey) redo();
    else undo();
  } else if (key === "y") {
    ev.preventDefault();
    redo();
  }
});

const FONT_CSS = {
  sourcehan: "SourceHanSansSC",
  yahei: "Microsoft YaHei",
  hei: "SimHei",
  song: "SimSun",
};

/* ------------------------------------------------------------------ */
/* 文字测量与换行（与 imageUtils.js 内实现保持一致，保证预览＝合成结果）     */
/* ------------------------------------------------------------------ */

function charWidth(ch, fontSize) {
  if (ch === " ") return fontSize * 0.32;
  const code = ch.codePointAt(0);
  if (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef)
  ) {
    return fontSize;
  }
  return fontSize * 0.56;
}

function measureText(str, fontSize) {
  let w = 0;
  for (const ch of String(str)) w += charWidth(ch, fontSize);
  return w;
}

/* 多行额外行高，与后端 EXTRA_LINE_HEIGHT 一致 */
const EXTRA_LINE_HEIGHT = 1.15;

/* 按最大像素宽度贪心逐字符拆行（详见 imageUtils.wrapTextToLines） */
function wrapTextToLines(text, fontSize, maxWidth) {
  const paragraphs = String(text || "").split(/\r?\n/);
  const lines = [];

  paragraphs.forEach((para) => {
    let line = "";
    for (const ch of para) {
      const test = line + ch;
      if (line && measureText(test, fontSize) > maxWidth) {
        lines.push(line);
        line = ch === " " ? "" : ch;
      } else {
        line = test;
      }
    }
    lines.push(line);
  });

  return lines.length ? lines : [""];
}

/* 计算元素拆行后的盒子尺寸（背景像素），供边界保护 / 夹紧复用 */
function elementBox(el, W) {
  const padX = el.fontSize * 0.42;
  let lineList = [String(el.text || "")];
  if (el.wrap === true) {
    const maxW = Math.min(
      W - padX * 2,
      Math.max(el.fontSize, Number(el.maxWidth) || W * 0.85)
    );
    lineList = wrapTextToLines(el.text, el.fontSize, maxW);
  }
  const textW = Math.max(...lineList.map((l) => measureText(l, el.fontSize)));
  return {
    lines: lineList,
    width: textW + padX * 2,
    height:
      el.fontSize * 1.4 + (lineList.length - 1) * el.fontSize * EXTRA_LINE_HEIGHT,
  };
}

function colorLuminance(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || ""));
  if (!m) return 1;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/* 与后端 plateStyleFor 保持一致：浅色文字→深色底板，深色文字→白色底板 */
function plateCss(color) {
  return colorLuminance(color) > 0.6 ? "rgba(10,13,22,0.42)" : "rgba(255,255,255,0.55)";
}

/**
 * 默认布局（坐标为背景图像素）
 */
function buildDefaultLayout(W, H, form) {
  const list = [];
  const add = (id, text, sizeFrac, yFrac, bold) => {
    if (!String(text || "").trim()) return;
    list.push({
      id,
      text: String(text).trim(),
      x: W * 0.055,
      y: H * yFrac,
      fontSize: W * sizeFrac,
      font: "sourcehan",
      color: "#ffffff",
      bold: Boolean(bold),
      rotation: 0,
      /* 自动换行开关与换行宽度（背景像素，0 = 未指定，勾选时默认画面宽 85%） */
      wrap: false,
      maxWidth: 0,
    });
  };
  add("clubName", form.clubName, 0.1, 0.56, true);
  add("slogan", form.slogan, 0.047, 0.71);
  add("activityTime", form.activityTime ? `时间  ${form.activityTime}` : "", 0.038, 0.82);
  add("activityLocation", form.activityLocation ? `地点  ${form.activityLocation}` : "", 0.038, 0.9);
  return list;
}

function getScale() {
  const rect = $("editorImg").getBoundingClientRect();
  return rect.width / raws[0].width;
}

function openEditor(raw) {
  $("previewPlaceholder").style.display = "none";
  $("posterImage").style.display = "none";
  $("thumbStrip").style.display = "none";
  $("layoutBar").style.display = "flex";
  $("layoutBar2").style.display = "flex";

  const stage = $("editorStage");
  stage.style.display = "inline-block";
  $("editorImg").src = raw.dataUrl;
  /* 图片加载完成后再渲染，确保拿到准确缩放比 */
  $("editorImg").onload = () => renderBlocks();
}

/* 把选中元素的字体 / 颜色 / 换行设置同步到工具条控件 */
function syncBlockControls(el) {
  if (!el) return;
  $("blockFont").value = el.font;
  $("blockColor").value = el.color;
  $("blockFontSize").value = Math.round(el.fontSize);
  $("blockWrap").checked = el.wrap === true;
  /* 宽度输入框：已指定用已保存值，否则给默认 85% 画面宽作占位 */
  $("blockWrapWidth").value = Math.round(
    el.maxWidth || raws[0].width * 0.85
  );
}

function selectBlock(id) {
  selectedId = id;
  syncBlockControls(elements.find((e) => e.id === id));
  renderBlocks();
}

/* 吸附阈值（屏幕像素）：小于该距离即吸附 */
const SNAP_PX = 8;

/**
 * 单轴吸附：块起点靠近「贴边 / 居中 / 贴另一边」时自动对齐
 * 返回 {value: 吸附后起点, guide: 参考线位置（图像像素，无则 null）}
 */
function snapAxis(value, size, max, threshold) {
  const candidates = [
    { start: 0, pos: 0 },
    { start: max / 2, pos: max / 2 - size / 2 },
    { start: max, pos: max - size },
  ];
  let best = null;
  candidates.forEach((c) => {
    const d = Math.abs(value - c.pos);
    if (d <= threshold && (!best || d < best.d)) best = { ...c, d };
  });
  return best ? { value: best.pos, guide: best.start } : { value, guide: null };
}

/* 参考线显示 */
function clearGuides() {
  $("guidesLayer").innerHTML = "";
}
function showGuides(list) {
  const s = getScale();
  const layer = $("guidesLayer");
  layer.innerHTML = "";
  list
    .filter(Boolean)
    .forEach((g) => {
      const d = document.createElement("div");
      d.className = g.axis === "v" ? "guide-v" : "guide-h";
      if (g.axis === "v") d.style.left = `${g.pos * s}px`;
      else d.style.top = `${g.pos * s}px`;
      layer.appendChild(d);
    });
}

function renderBlocks() {
  if (!raws.length) return;
  clearGuides();
  const scale = getScale();
  const W = raws[0].width;
  const H = raws[0].height;
  const layer = $("blocksLayer");
  layer.innerHTML = "";

  elements.forEach((el) => {
    /* 先按换行设置算出盒子（含拆行结果），并把坐标夹紧到画面内 */
    const box = elementBox(el, W);
    el.x = Math.min(Math.max(0, el.x), Math.max(0, W - box.width));
    el.y = Math.min(Math.max(0, el.y), Math.max(0, H - box.height));

    const node = document.createElement("div");
    node.className = "text-block" + (el.id === selectedId ? " selected" : "");
    node.style.left = `${el.x * scale}px`;
    node.style.top = `${el.y * scale}px`;
    node.style.fontSize = `${el.fontSize * scale}px`;
    node.style.fontFamily = FONT_CSS[el.font] || FONT_CSS.sourcehan;
    node.style.fontWeight = el.bold ? "700" : "400";
    node.style.color = el.color;
    node.style.background = plateCss(el.color);
    node.style.transform = `rotate(${el.rotation || 0}deg)`;

    /* 逐行渲染（每一行一个 div，外壳宽度 shrink-to-fit 到最长行） */
    box.lines.forEach((line) => {
      const lineNode = document.createElement("div");
      lineNode.className = "text-line";
      lineNode.textContent = line;
      node.appendChild(lineNode);
    });

    /* 双击文字块：弹窗修改这块文字的内容 */
    node.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openTextEditModal(el.id);
    });

    node.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      node.setPointerCapture(ev.pointerId);

      /* 只切换选中态与控件，不重建 DOM（避免拖拽中途节点被销毁） */
      if (selectedId !== el.id) {
        selectedId = el.id;
        layer
          .querySelectorAll(".text-block.selected")
          .forEach((n) => n.classList.remove("selected"));
        node.classList.add("selected");
        syncBlockControls(el);
      }

      const startX = ev.clientX;
      const startY = ev.clientY;
      const origX = el.x;
      const origY = el.y;
      const s = getScale();
      const bw = node.offsetWidth / s;
      const bh = node.offsetHeight / s;
      const threshold = SNAP_PX / s;
      let historyPushed = false;

      const onMove = (mev) => {
        /* 第一次实际移动前保存快照（纯点击不产生历史） */
        if (!historyPushed) {
          pushHistory();
          historyPushed = true;
        }
        const nx = origX + (mev.clientX - startX) / s;
        const ny = origY + (mev.clientY - startY) / s;
        const rx = snapAxis(nx, bw, W, threshold);
        const ry = snapAxis(ny, bh, H, threshold);
        el.x = Math.min(Math.max(0, rx.value), W - bw);
        el.y = Math.min(Math.max(0, ry.value), H - bh);
        node.style.left = `${el.x * s}px`;
        node.style.top = `${el.y * s}px`;
        showGuides([
          rx.guide !== null ? { axis: "v", pos: rx.guide } : null,
          ry.guide !== null ? { axis: "h", pos: ry.guide } : null,
        ]);
      };
      const onUp = () => {
        node.removeEventListener("pointermove", onMove);
        node.removeEventListener("pointerup", onUp);
        clearGuides();
      };
      node.addEventListener("pointermove", onMove);
      node.addEventListener("pointerup", onUp);
    });

    layer.appendChild(node);
  });
}

/* 键盘微调：选中区块后，方向键 1px；Shift + 方向键 10px */
window.addEventListener("keydown", (ev) => {
  if (!selectedId) return;
  if ($("editorStage").style.display === "none") return;
  const tag = (ev.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;

  const step = ev.shiftKey ? 10 : 1;
  let dx = 0;
  let dy = 0;
  if (ev.key === "ArrowLeft") dx = -step;
  else if (ev.key === "ArrowRight") dx = step;
  else if (ev.key === "ArrowUp") dy = -step;
  else if (ev.key === "ArrowDown") dy = step;
  else return;
  ev.preventDefault();
  pushHistory();

  const el = elements.find((e) => e.id === selectedId);
  const node = $("blocksLayer").querySelector(".text-block.selected");
  if (!el || !node) return;
  const s = getScale();
  const bw = node.offsetWidth / s;
  const bh = node.offsetHeight / s;
  el.x = Math.min(Math.max(0, el.x + dx), raws[0].width - bw);
  el.y = Math.min(Math.max(0, el.y + dy), raws[0].height - bh);
  node.style.left = `${el.x * s}px`;
  node.style.top = `${el.y * s}px`;
});

/* 水平居中 / 底部对齐（作用于当前选中区块） */
$("alignHCenter").addEventListener("click", () => {
  const el = elements.find((e) => e.id === selectedId);
  const node = $("blocksLayer").querySelector(".text-block.selected");
  if (!el || !node) {
    setGenStatus("请先点击选中一个文字区块。", "err");
    return;
  }
  const s = getScale();
  pushHistory();
  el.x = (raws[0].width - node.offsetWidth / s) / 2;
  renderBlocks();
});

$("alignBottom").addEventListener("click", () => {
  const el = elements.find((e) => e.id === selectedId);
  const node = $("blocksLayer").querySelector(".text-block.selected");
  if (!el || !node) {
    setGenStatus("请先点击选中一个文字区块。", "err");
    return;
  }
  const s = getScale();
  pushHistory();
  el.y = raws[0].height - node.offsetHeight / s;
  renderBlocks();
});

/* ------------------------------------------------------------------ */
/* 内置版式：一键套用                                                      */
/* ------------------------------------------------------------------ */

function findBlock(id) {
  return elements.find((e) => e.id === id);
}

/* 按比例设置位置与字号（坐标为背景图像素），并重置旋转 */
function place(id, xFrac, yFrac, sizeFrac, rotation) {
  const el = findBlock(id);
  if (!el) return;
  const W = raws[0].width;
  const H = raws[0].height;
  el.x = W * xFrac;
  el.y = H * yFrac;
  if (sizeFrac) el.fontSize = W * sizeFrac;
  el.rotation = rotation || 0;
}

const LAYOUT_PRESETS = {
  /* 底部信息条：所有信息收在底部，形成信息条 */
  bottombar() {
    place("clubName", 0.06, 0.64, 0.09);
    place("slogan", 0.06, 0.76, 0.044);
    place("activityTime", 0.06, 0.85);
    place("activityLocation", 0.06, 0.93);
  },
  /* 左对齐：沿左侧边距自上而下排开 */
  left() {
    place("clubName", 0.05, 0.14, 0.085);
    place("slogan", 0.05, 0.26, 0.044);
    place("activityTime", 0.05, 0.37);
    place("activityLocation", 0.05, 0.45);
  },
  /* 居中大标题：超大标题居中，其余信息横向居中（居中换算在渲染后做） */
  center() {
    place("clubName", 0.5, 0.28, 0.13);
    place("slogan", 0.5, 0.5, 0.05);
    place("activityTime", 0.5, 0.64);
    place("activityLocation", 0.5, 0.72);
  },
  /* 对角排版：左上标题与右下信息对角呼应，整块轻微倾斜 */
  diagonal() {
    place("clubName", 0.06, 0.12, 0.1, -9);
    place("slogan", 0.12, 0.28, 0.045, -9);
    place("activityTime", 0.5, 0.72, 0.038, 9);
    place("activityLocation", 0.5, 0.82, 0.038, 9);
  },
};

document.querySelectorAll("[data-layout]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const name = btn.getAttribute("data-layout");
    if (!elements.length) return;
    pushHistory();
    LAYOUT_PRESETS[name]();
    selectedId = null;
    renderBlocks();
    /* 居中版式：首轮渲染后按实测块宽换算成水平居中坐标，再渲染一次 */
    if (name === "center") {
      const nodes = $("blocksLayer").querySelectorAll(".text-block");
      const s = getScale();
      elements.forEach((el, i) => {
        if (nodes[i]) el.x = raws[0].width / 2 - nodes[i].offsetWidth / s / 2;
      });
      renderBlocks();
    }
    setGenStatus(`已套用版式「${escapeHtml(btn.textContent)}」，可继续拖动微调。`);
  });
});

/* 字体 / 颜色控件：作用于当前选中区块 */
$("blockFont").addEventListener("change", () => {
  const el = elements.find((e) => e.id === selectedId);
  if (!el) return;
  pushHistory();
  el.font = $("blockFont").value;
  renderBlocks();
});

/* 打开取色器时先存快照（input 事件会连续触发，不能每次都存） */
$("blockColor").addEventListener("pointerdown", () => {
  if (elements.some((e) => e.id === selectedId)) pushHistory();
});

$("blockColor").addEventListener("input", () => {
  const el = elements.find((e) => e.id === selectedId);
  if (!el) return;
  el.color = $("blockColor").value;
  renderBlocks();
});

/* 自动换行开关：作用于当前选中区块 */
$("blockWrap").addEventListener("change", () => {
  const el = elements.find((e) => e.id === selectedId);
  if (!el) {
    /* 没有选中块时开关自动弹回，避免界面状态无主 */
    $("blockWrap").checked = false;
    setGenStatus("请先点击选中一个文字区块，再设置自动换行。", "err");
    return;
  }
  pushHistory();
  el.wrap = $("blockWrap").checked;
  /* 首次勾选且未指定过宽度：给默认 85% 画面宽 */
  if (el.wrap && !el.maxWidth) {
    el.maxWidth = Math.round(raws[0].width * 0.85);
    $("blockWrapWidth").value = el.maxWidth;
  }
  renderBlocks();
  setGenStatus(
    el.wrap ? "已开启自动换行，可调整右侧宽度，文字会在宽度内折行。" : "已关闭自动换行，恢复单行显示。"
  );
});

/* 换行宽度：修改后自动开启换行，宽度夹紧到画面范围内 */
$("blockWrapWidth").addEventListener("change", () => {
  const el = elements.find((e) => e.id === selectedId);
  if (!el) return;
  pushHistory();
  const W = raws[0].width;
  const input = Number.parseInt($("blockWrapWidth").value, 10);
  const value = Math.min(W, Math.max(el.fontSize, input || W * 0.85));
  el.maxWidth = Math.round(value);
  el.wrap = true;
  $("blockWrap").checked = true;
  $("blockWrapWidth").value = el.maxWidth;
  renderBlocks();
  setGenStatus(`每行宽度已设为 ${el.maxWidth} px（背景像素）。`);
});

/* ------------------------------------------------------------------ */
/* 字号调节：直接输入像素值，或 A−/A+ 按 10% 步进                          */
/* ------------------------------------------------------------------ */

/* 字号合理范围：画面宽的 2% ~ 60%，防止过小看不见或过大炸出版面 */
function fontSizeRange() {
  const W = raws[0].width;
  return { min: W * 0.02, max: W * 0.6 };
}

/* 把字号应用到当前选中块；调用前需已 pushHistory */
function applyFontSize(px) {
  const el = elements.find((e) => e.id === selectedId);
  if (!el) {
    setGenStatus("请先点击选中一个文字区块，再调整字号。", "err");
    return false;
  }
  const { min, max } = fontSizeRange();
  el.fontSize = Math.min(max, Math.max(min, px));
  renderBlocks();
  $("blockFontSize").value = Math.round(el.fontSize);
  return true;
}

/* 直接输入字号（change 时一次生效） */
$("blockFontSize").addEventListener("change", () => {
  const value = Number.parseInt($("blockFontSize").value, 10);
  if (!Number.isFinite(value)) return;
  pushHistory();
  if (applyFontSize(value)) setGenStatus(`字号已设为 ${Math.round(value)} px（背景像素）。`);
});

/* A− / A+：每次乘 0.9 / 1.1，手感连续 */
function bumpFontSize(factor) {
  const el = elements.find((e) => e.id === selectedId);
  if (!el) {
    setGenStatus("请先点击选中一个文字区块，再调整字号。", "err");
    return;
  }
  pushHistory();
  applyFontSize(el.fontSize * factor);
}

$("fontSizeDown").addEventListener("click", () => bumpFontSize(0.9));
$("fontSizeUp").addEventListener("click", () => bumpFontSize(1.1));

/* ------------------------------------------------------------------ */
/* 新增自定义文字块：默认放在画面正中并自动选中，随后可改字/拖动/调样式        */
/* ------------------------------------------------------------------ */

$("addTextBlock").addEventListener("click", () => {
  if (!raws.length) return;
  const W = raws[0].width;
  const H = raws[0].height;

  const el = {
    id: `custom_${Date.now().toString(36)}`,
    text: "自定义文字",
    x: 0,
    y: 0,
    fontSize: W * 0.05,
    font: "sourcehan",
    color: "#ffffff",
    bold: false,
    rotation: 0,
    wrap: false,
    maxWidth: 0,
  };

  pushHistory();
  elements.push(el);
  selectedId = el.id;

  /* 按实测盒子尺寸居中放置 */
  const box = elementBox(el, W);
  el.x = Math.max(0, (W - box.width) / 2);
  el.y = Math.max(0, (H - box.height) / 2);

  renderBlocks();
  syncBlockControls(el);
  setGenStatus("已添加文字块：双击可改字，也可拖动或调整字号颜色。");
});

/* 恢复默认布局 */
$("resetLayout").addEventListener("click", () => {
  const form = collectForm();
  pushHistory();
  elements = buildDefaultLayout(raws[0].width, raws[0].height, form);
  selectedId = null;
  renderBlocks();
  setGenStatus("已恢复默认布局，可继续拖动调整。");
});

/* 阶段二：应用布局 → sharp 合成最终海报 */
$("applyLayout").addEventListener("click", async () => {
  const btn = $("applyLayout");
  btn.disabled = true;
  setGenStatus('<span class="spin"></span> 正在排版文字…（按当前布局用 sharp 合成最终海报）');

  let result;
  try {
    result = await window.api.composePoster({
      rawFiles: raws.map((r) => r.file),
      elements,
    });
  } catch (error) {
    btn.disabled = false;
    setGenStatus(`合成失败：${escapeHtml(error.message || error)}`, "err");
    return;
  }
  btn.disabled = false;

  if (!result.ok) {
    setGenStatus(`合成失败：${escapeHtml(result.error)}`, "err");
    return;
  }

  /* 退出编辑态，展示成品 */
  $("editorStage").style.display = "none";
  $("layoutBar").style.display = "none";
  $("layoutBar2").style.display = "none";

  currentResults = result.results;
  currentIndex = 0;
  showPoster(0);

  $("saveBtn").disabled = false;
  $("copyBtn").disabled = false;
  $("editTextBtn").disabled = false;
  setGenStatus(`海报生成成功！共 ${result.results.length} 张，已保存到输出文件夹，可一键复制。`, "ok");
});

/* ------------------------------------------------------------------ */
/* 修改文字弹窗（双击文字块打开；也可在成品页点「修改文字」回到编辑器）        */
/* ------------------------------------------------------------------ */

let editingId = null;

function openTextEditModal(id) {
  const el = elements.find((e) => e.id === id);
  if (!el) return;

  editingId = id;
  $("textEditError").textContent = "";
  $("textEditInput").value = el.text;
  $("textEditModal").style.display = "flex";

  /* 光标放到末尾并聚焦 */
  const input = $("textEditInput");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function closeTextEditModal() {
  $("textEditModal").style.display = "none";
  editingId = null;
}

/* 保存：更新该块文字并重渲染（坐标不变；换行设置照旧生效） */
function saveTextEdit() {
  const el = elements.find((e) => e.id === editingId);
  if (!el) {
    closeTextEditModal();
    return;
  }

  const value = $("textEditInput").value.trim();
  if (!value) {
    $("textEditError").textContent = "文字内容不能为空；如不需要这块，请点「删除该文字块」。";
    return;
  }

  pushHistory();
  el.text = value;
  closeTextEditModal();
  renderBlocks();
  setGenStatus("文字已修改，点「应用布局并合成」即可生成新海报。", "ok");
}

/* 删除该文字块 */
function deleteEditingBlock() {
  const index = elements.findIndex((e) => e.id === editingId);
  if (index >= 0) {
    pushHistory();
    elements.splice(index, 1);
  }
  if (selectedId === editingId) selectedId = null;
  closeTextEditModal();
  renderBlocks();
  setGenStatus("已删除该文字块。", "ok");
}

$("textEditSave").addEventListener("click", saveTextEdit);
$("textEditCancel").addEventListener("click", closeTextEditModal);
$("textEditDelete").addEventListener("click", deleteEditingBlock);

/* 输入框快捷键：Ctrl+Enter 保存，Esc 取消 */
$("textEditInput").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    saveTextEdit();
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    closeTextEditModal();
  }
});

/* 成品页「修改文字」：回到布局编辑器，改完重新合成 */
$("editTextBtn").addEventListener("click", () => {
  if (!raws.length || !elements.length) return;

  $("posterImage").style.display = "none";
  $("filePathBar").style.display = "none";
  openEditor(raws[currentIndex] || raws[0]);

  /* 滚动到编辑器，手机/小屏也能看到 */
  $("editorStage").scrollIntoView({ behavior: "smooth", block: "start" });
  setGenStatus("已返回编辑：双击文字块修改内容，再点「应用布局并合成」。", "ok");
});

/* 窗口尺寸变化时重算区块显示位置 */
window.addEventListener("resize", () => {
  if ($("editorStage").style.display !== "none") renderBlocks();
});

function showPoster(index) {
  currentIndex = index;
  const item = currentResults[index];
  if (!item) return;

  $("previewPlaceholder").style.display = "none";
  $("editorStage").style.display = "none";
  $("layoutBar").style.display = "none";
  $("layoutBar2").style.display = "none";
  const img = $("posterImage");
  img.src = item.dataUrl;
  img.style.display = "block";

  const bar = $("filePathBar");
  bar.style.display = "block";
  bar.textContent = `已保存：${item.file}`;

  renderThumbs();
}

function renderThumbs() {
  const strip = $("thumbStrip");
  strip.innerHTML = "";

  if (currentResults.length <= 1) {
    strip.style.display = "none";
    return;
  }

  strip.style.display = "flex";
  currentResults.forEach((item, i) => {
    const t = document.createElement("img");
    t.src = item.dataUrl;
    if (i === currentIndex) t.classList.add("active");
    t.addEventListener("click", () => showPoster(i));
    strip.appendChild(t);
  });
}

/* ------------------------------------------------------------------ */
/* 保存图片（另存到用户选择的位置）                                        */
/* ------------------------------------------------------------------ */

$("saveBtn").addEventListener("click", async () => {
  const item = currentResults[currentIndex];
  if (!item) return;
  const result = await window.api.saveImageAs(item.file);
  if (result.ok) {
    setGenStatus(`已另存为：${escapeHtml(result.path)}`, "ok");
  } else if (!result.canceled) {
    setGenStatus(escapeHtml(result.error || "保存失败"), "err");
  }
});

/* ------------------------------------------------------------------ */
/* 一键复制海报到系统剪贴板                                                */
/* ------------------------------------------------------------------ */

$("copyBtn").addEventListener("click", async () => {
  const item = currentResults[currentIndex];
  if (!item) return;
  const result = await window.api.copyImageToClipboard({ file: item.file });
  if (result.ok) {
    setGenStatus("海报已复制到剪贴板，可直接粘贴到 QQ / 微信 / 文档中。", "ok");
  } else {
    setGenStatus(escapeHtml(result.error || "复制失败"), "err");
  }
});

/* ------------------------------------------------------------------ */
/* 打开输出文件夹                                                         */
/* ------------------------------------------------------------------ */

$("openDirBtn").addEventListener("click", async () => {
  const result = await window.api.openOutputsDir();
  if (!result.ok) setGenStatus(escapeHtml(result.error || "打开文件夹失败"), "err");
});

/* ------------------------------------------------------------------ */
/* AI 提示词辅助                                                          */
/* ------------------------------------------------------------------ */

/* 填入角色描述模板前的快照，用于单次撤销 */
let prevCharacterSnapshot = null;

function setAssistStatus(message, kind) {
  const el = $("assistStatus");
  el.textContent = message || "";
  el.className = "status" + (kind ? " " + kind : "");
}

/* 渲染预设场景模板快捷按钮：点击以 poster 模式调用文本辅助模型 */
function renderSceneTemplates(templates) {
  const bar = $("sceneTemplateBar");
  bar.innerHTML = "";
  templates.forEach((tpl) => {
    const btn = document.createElement("button");
    btn.className = "btn template";
    btn.textContent = tpl.name;
    btn.addEventListener("click", () => {
      runAssist("poster", () => {
        const club = $("clubName").value.trim();
        /* 把模板预设主题作为简短主题；已填社团名则一并注入 */
        return club ? `${tpl.topic}，社团名为${club}` : tpl.topic;
      });
    });
    bar.appendChild(btn);
  });
}

async function runAssist(mode, buildInput) {
  const fixedButtons = ["assistCharacter", "assistScene", "assistTranslate"].map($);
  const templateButtons = Array.from(document.querySelectorAll("#sceneTemplateBar .btn"));
  const allButtons = fixedButtons.concat(templateButtons);
  allButtons.forEach((b) => { b.disabled = true; });
  setAssistStatus("正在调用文本辅助模型，请稍候…");

  try {
    const result = await window.api.assistPrompt({
      mode,
      input: buildInput(),
      model: selectedAssistantModel(),
    });
    if (!result.ok) {
      setAssistStatus(result.error, "err");
      return;
    }
    $("assistOutput").value = result.result;
    setAssistStatus("辅助生成完成：可「填入角色描述模板」参与生图，或复制结果。", "ok");
  } catch (error) {
    setAssistStatus(error.message || String(error), "err");
  } finally {
    allButtons.forEach((b) => { b.disabled = false; });
  }
}

/* 角色想法 → 英文 tag */
$("assistCharacter").addEventListener("click", () => {
  runAssist("character", () => $("assistInput").value);
});

/* 海报画面优化：自动带上社团名与风格，输入框内容作为补充想法 */
$("assistScene").addEventListener("click", () => {
  runAssist("scene", () => {
    const parts = [
      `社团名称：${$("clubName").value.trim() || "（未填写）"}`,
      `海报风格：${$("style").value}`,
    ];
    const extra = $("assistInput").value.trim();
    if (extra) parts.push(`补充想法：${extra}`);
    return parts.join("；");
  });
});

/* 中英互译：自动判断方向 */
$("assistTranslate").addEventListener("click", () => {
  runAssist("translate", () => $("assistInput").value);
});

/* 填入角色描述模板（生图仍读模板框内容，链路不变） */
$("applyCharacter").addEventListener("click", () => {
  const value = $("assistOutput").value.trim();
  if (!value) {
    setAssistStatus("辅助结果为空，没有可填入的内容。", "err");
    return;
  }
  prevCharacterSnapshot = $("characterPrompt").value;
  $("characterPrompt").value = value;
  $("undoCharacter").disabled = false;
  setAssistStatus("已填入角色描述模板，可点「撤销填入」恢复原文。", "ok");
});

$("undoCharacter").addEventListener("click", () => {
  if (prevCharacterSnapshot === null) return;
  $("characterPrompt").value = prevCharacterSnapshot;
  prevCharacterSnapshot = null;
  $("undoCharacter").disabled = true;
  setAssistStatus("已恢复填入前的角色描述。", "ok");
});

/* 复制结果：优先剪贴板 API，失败则回退 execCommand */
$("copyAssist").addEventListener("click", async () => {
  const value = $("assistOutput").value;
  if (!value.trim()) {
    setAssistStatus("辅助结果为空，没有可复制的内容。", "err");
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    setAssistStatus("结果已复制到剪贴板。", "ok");
  } catch (_) {
    const area = $("assistOutput");
    area.removeAttribute("readonly");
    area.focus();
    area.select();
    const ok = document.execCommand("copy");
    area.setAttribute("readonly", "");
    setAssistStatus(
      ok ? "结果已复制到剪贴板。" : "复制失败，请手动选择文本复制。",
      ok ? "ok" : "err"
    );
  }
});

/* ================================================================== */
/* 智能文案：口号生成 / 时间地点拆分 / 一键填充                              */
/* ================================================================== */

function setSmartStatus(message, kind) {
  const el = $("smartStatus");
  el.textContent = message || "";
  el.className = "status" + (kind ? " " + kind : "");
}

async function runSmartCopy(task) {
  const input = $("smartInput").value.trim();
  if (!input) {
    setSmartStatus("请先在上方输入一句话（社团名 / 时间地点 / 随便几句想法）。", "err");
    return;
  }
  if (!selectedAssistantModel()) {
    setSmartStatus("请先在上方「服务商设置」里拉取并选择一个文本模型。", "err");
    return;
  }

  ["smartSlogan", "smartParse", "smartFullfill"].forEach((id) => ($(id).disabled = true));
  setSmartStatus("AI 正在代笔，请稍候…");

  let result;
  try {
    result = await window.api.smartCopy({
      task,
      input,
      model: selectedAssistantModel(),
    });
  } catch (error) {
    setSmartStatus(error.message || String(error), "err");
    result = { ok: false, error: error.message };
  } finally {
    ["smartSlogan", "smartParse", "smartFullfill"].forEach((id) => ($(id).disabled = false));
  }

  if (!result.ok) {
    setSmartStatus(result.error || "智能文案失败", "err");
    return;
  }
  applySmartResult(task, result.result);
}

/* 把 AI 返回结果写入对应表单字段（空值不覆盖用户已填内容） */
function applySmartResult(task, r) {
  const data = r || {};
  const fill = (field, value) => {
    const v = String(value || "").trim();
    if (v) $(field).value = v;
  };

  if (task === "slogan") {
    fill("slogan", data.slogan);
    setSmartStatus(data.slogan ? "招新口号已生成并填入，可继续修改。" : "AI 未返回有效口号。", "ok");
    return;
  }

  if (task === "parse") {
    fill("activityTime", data.activityTime);
    fill("activityLocation", data.activityLocation);
    const got = [data.activityTime, data.activityLocation].filter(Boolean).length;
    setSmartStatus(
      got ? `已自动拆分并填入 ${got} 个字段。` : "没有从句子中识别出时间或地点。",
      got ? "ok" : "err"
    );
    return;
  }

  /* fullfill：一键填充全部文案 */
  fill("clubName", data.clubName);
  fill("slogan", data.slogan);
  fill("activityTime", data.activityTime);
  fill("activityLocation", data.activityLocation);
  const n = [data.clubName, data.slogan, data.activityTime, data.activityLocation].filter(Boolean).length;
  setSmartStatus(
    n ? `一键填充完成，共填入 ${n} 个字段，检查一下就可以生成海报了。` : "AI 未返回有效内容。",
    n ? "ok" : "err"
  );
}

$("smartSlogan").addEventListener("click", () => runSmartCopy("slogan"));
$("smartParse").addEventListener("click", () => runSmartCopy("parse"));
$("smartFullfill").addEventListener("click", () => runSmartCopy("fullfill"));

/* ================================================================== */
/* 顶部导航：视图切换                                                      */
/* ================================================================== */

function switchView(which) {
  const isMaker = which === "maker";
  $("viewMaker").style.display = isMaker ? "flex" : "none";
  $("viewHistory").style.display = isMaker ? "none" : "flex";
  $("navMaker").classList.toggle("active", isMaker);
  $("navHistory").classList.toggle("active", !isMaker);
  if (!isMaker) loadHistoryList();
}

$("navMaker").addEventListener("click", () => switchView("maker"));
$("navHistory").addEventListener("click", () => switchView("history"));

/* ================================================================== */
/* 我的海报：历史记录                                                      */
/* ================================================================== */

let historyRecords = [];
let modalId = null;

function setHistoryStatus(message, kind) {
  const el = $("historyStatus");
  el.textContent = message || "";
  el.style.color = kind === "err" ? "#ff8b8b" : kind === "ok" ? "#8ef0a8" : "";
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* 把文案对象整理成可复制的纯文本 */
function formatCopyText(copy) {
  const lines = [];
  if (copy.clubName) lines.push(`社团：${copy.clubName}`);
  if (copy.slogan) lines.push(`口号：${copy.slogan}`);
  if (copy.activityTime) lines.push(`时间：${copy.activityTime}`);
  if (copy.activityLocation) lines.push(`地点：${copy.activityLocation}`);
  if (copy.style) lines.push(`风格：${copy.style}`);
  return lines.join("\n");
}

async function loadHistoryList() {
  setHistoryStatus("正在加载历史记录…");
  let result;
  try {
    result = await window.api.listHistory();
  } catch (error) {
    setHistoryStatus(error.message || String(error), "err");
    return;
  }
  if (!result.ok) {
    setHistoryStatus(result.error, "err");
    return;
  }

  historyRecords = result.records;
  renderHistoryGrid();
  setHistoryStatus(
    historyRecords.length ? `共 ${historyRecords.length} 张历史海报` : ""
  );
}

function renderHistoryGrid() {
  const grid = $("historyGrid");
  const empty = $("historyEmpty");
  grid.innerHTML = "";

  if (!historyRecords.length) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  historyRecords.forEach((rec) => {
    const copy = rec.copy || {};
    const card = document.createElement("div");
    card.className = "poster-card";

    const thumb = document.createElement("img");
    thumb.className = "thumb";
    thumb.src = rec.thumbDataUrl;
    thumb.alt = copy.clubName || "海报";
    thumb.addEventListener("click", () => openHistoryModal(rec.id));

    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = copy.clubName || "未命名海报";
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `${copy.style || ""}　${formatDate(rec.createdAt)}`;
    meta.appendChild(name);
    meta.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const mkBtn = (text, handler) => {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = text;
      b.addEventListener("click", handler);
      return b;
    };
    actions.appendChild(mkBtn("查看", () => openHistoryModal(rec.id)));
    actions.appendChild(
      mkBtn("复制文案", async () => {
        await copyText(formatCopyText(copy));
        setHistoryStatus("文案已复制到剪贴板。", "ok");
      })
    );
    actions.appendChild(
      mkBtn("另存为", async () => {
        const r = await window.api.saveHistoryAs({ id: rec.id });
        if (r.ok) setHistoryStatus(`已另存到：${r.path}`, "ok");
        else if (!r.canceled) setHistoryStatus(r.error, "err");
      })
    );
    actions.appendChild(
      mkBtn("删除", () => removeHistory(rec.id))
    );

    card.appendChild(thumb);
    card.appendChild(meta);
    card.appendChild(actions);
    grid.appendChild(card);
  });
}

/* 复制文本：优先剪贴板 API，失败回退 execCommand */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }
}

async function removeHistory(id) {
  const rec = historyRecords.find((r) => r.id === id);
  if (!rec) return;
  const ok = window.confirm(
    `确定删除「${rec.copy.clubName || "该海报"}」的历史记录吗？\n（只删除记录与缩略图，outputs 文件夹里的海报原图会保留）`
  );
  if (!ok) return;

  const result = await window.api.deleteHistory({ id });
  if (result.ok) {
    if (modalId === id) closeHistoryModal();
    await loadHistoryList();
    setHistoryStatus("历史记录已删除（海报原图保留）。", "ok");
  }
}

/* ---------------- 详情弹窗 ---------------- */

async function openHistoryModal(id) {
  modalId = id;
  const modal = $("historyModal");
  const copyBox = $("modalCopyBox");
  $("modalImg").src = "";
  $("modalTitle").textContent = "海报详情";
  copyBox.textContent = "正在加载海报原图…";
  modal.style.display = "flex";

  const result = await window.api.getHistoryImage({ id });
  if (modalId !== id) return;

  if (!result.ok) {
    $("modalImg").style.display = "none";
    copyBox.textContent = result.error;
    /* 原图丢失时仍展示卡片上的文案，方便复制 */
    const rec = historyRecords.find((r) => r.id === id);
    if (rec) {
      $("modalTitle").textContent = rec.copy.clubName || "海报详情";
      copyBox.textContent = formatCopyText(rec.copy);
    }
    return;
  }

  $("modalImg").style.display = "block";
  $("modalImg").src = result.dataUrl;
  $("modalTitle").textContent = result.copy.clubName || "海报详情";
  copyBox.textContent = formatCopyText(result.copy);
}

function closeHistoryModal() {
  modalId = null;
  $("historyModal").style.display = "none";
  $("modalImg").src = "";
}

$("modalClose").addEventListener("click", closeHistoryModal);
$("historyModal").addEventListener("click", (ev) => {
  /* 点击遮罩空白处关闭（点弹窗内部不关闭） */
  if (ev.target === $("historyModal")) closeHistoryModal();
});

$("modalCopyText").addEventListener("click", async () => {
  if (!modalId) return;
  const rec = historyRecords.find((r) => r.id === modalId);
  if (!rec) return;
  const ok = await copyText(formatCopyText(rec.copy));
  setHistoryStatus(ok ? "文案已复制到剪贴板。" : "复制失败，请手动选择文本。", ok ? "ok" : "err");
});

$("modalSaveAs").addEventListener("click", async () => {
  if (!modalId) return;
  const r = await window.api.saveHistoryAs({ id: modalId });
  if (r.ok) setHistoryStatus(`已另存到：${r.path}`, "ok");
  else if (!r.canceled) setHistoryStatus(r.error, "err");
});

$("modalReveal").addEventListener("click", async () => {
  if (!modalId) return;
  const r = await window.api.revealHistory({ id: modalId });
  if (!r.ok) setHistoryStatus(r.error, "err");
});

$("modalDelete").addEventListener("click", async () => {
  if (modalId) await removeHistory(modalId);
});

$("historyRefresh").addEventListener("click", loadHistoryList);

$("historyClear").addEventListener("click", async () => {
  if (!historyRecords.length) {
    setHistoryStatus("当前没有任何历史记录。");
    return;
  }
  const ok = window.confirm(
    `确定清空全部 ${historyRecords.length} 条历史记录吗？\n（只清空记录与缩略图，outputs 文件夹里的海报原图都会保留）`
  );
  if (!ok) return;
  const result = await window.api.clearHistory();
  if (result.ok) {
    await loadHistoryList();
    setHistoryStatus("历史记录已清空（海报原图保留）。", "ok");
  }
});

/* ================================================================== */
/* 首次启动引导                                                            */
/* ================================================================== */

const ONBOARD_STEPS = [
  {
    title: "欢迎使用 AI 百团大战海报生成器",
    body:
      "只要三步：<b>填文案 → AI 出背景 → 一键合成</b>。<br>" +
      "支持多家兼容 OpenAI 接口的模型服务，本软件本地运行，不收取任何费用。",
  },
  {
    title: "文案几乎不用打字",
    body:
      "在「智能文案」卡片里随手写一句话：<br>" +
      "输入<b>社团名</b>自动生成招新口号；输入「9月20日 18:00 东区操场」自动<b>拆分时间、地点</b>填表；<br>" +
      "点「<b>一键填充全部</b>」，所有字段一次到位。",
  },
  {
    title: "拖拽排版，精准微调",
    body:
      "拖动文字块时会显示<b>对齐参考线</b>，靠近中线 / 边缘<b>自动吸附</b>；<br>" +
      "选中后用 <kbd>方向键</kbd> 微调 1px，<kbd>Shift</kbd> + <kbd>方向键</kbd> 移动 10px；<br>" +
      "还内置底部信息条、左对齐、居中大标题、对角排版 <b>4 套版式</b>，一键套用。",
  },
  {
    title: "没网没 Key 也永远能出图",
    body:
      "未配置 API Key 或断网时，自动使用<b>内置渐变背景 + 文字排版</b>，瞬间成稿。<br>" +
      "每次生成前会<b>弹窗确认</b>模型、张数与预估耗时 / 费用，长任务可随时「<b>取消生成</b>」。<br>" +
      "成品支持「<b>复制到剪贴板</b>」，直接粘贴到 QQ 群、公众号。",
  },
];

let onboardIndex = 0;

function renderOnboard() {
  const step = ONBOARD_STEPS[onboardIndex];
  $("onboardContent").innerHTML =
    `<div class="step-title">${step.title}</div><div class="step-body">${step.body}</div>`;
  $("onboardDots").innerHTML = ONBOARD_STEPS.map(
    (_, i) => `<span class="dot${i === onboardIndex ? " active" : ""}"></span>`
  ).join("");
  $("onboardPrev").style.visibility = onboardIndex === 0 ? "hidden" : "visible";
  $("onboardNext").textContent =
    onboardIndex === ONBOARD_STEPS.length - 1 ? "开始使用" : "下一步";
}

async function closeOnboarding() {
  hideModal("onboardingModal");
  try {
    await window.api.finishOnboarding();
    if (appConfig) appConfig.onboarded = true;
  } catch (_) {
    /* 标记失败不影响使用 */
  }
}

$("onboardNext").addEventListener("click", () => {
  if (onboardIndex < ONBOARD_STEPS.length - 1) {
    onboardIndex += 1;
    renderOnboard();
  } else {
    closeOnboarding();
  }
});
$("onboardPrev").addEventListener("click", () => {
  if (onboardIndex > 0) {
    onboardIndex -= 1;
    renderOnboard();
  }
});
$("onboardSkip").addEventListener("click", closeOnboarding);

function startOnboardingIfNeeded() {
  if (appConfig && !appConfig.onboarded) {
    onboardIndex = 0;
    renderOnboard();
    showModal("onboardingModal");
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                  */
/* ------------------------------------------------------------------ */

init()
  .then(startOnboardingIfNeeded)
  .catch((error) => {
    setGenStatus(`界面初始化失败：${escapeHtml(error.message || error)}`, "err");
  });
