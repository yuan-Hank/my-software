"use strict";

/**
 * imageUtils.js
 * 海报文字合成工具（可拖拽布局版）
 *
 * 流程：
 *   布局元素（文本 + 坐标 + 字号 + 字体 + 颜色）
 *     → 构建覆盖整张背景图的文字层 SVG（自动底板 / 描边 / 投影）
 *     → 用 @resvg/resvg-js 渲染（显式加载内置思源黑体 + 系统字体）
 *     → sharp 将文字层合成到 AI 背景图上，输出 JPEG
 *
 * 内置字体 fonts/SourceHanSansSC-Regular.otf（思源黑体 / Noto Sans SC），
 * 保证在任何电脑上中文都不乱码。
 */

const path = require("node:path");
const sharp = require("sharp");
const { Resvg } = require("@resvg/resvg-js");

/* ------------------------------------------------------------------ */
/* 字体定义                                                              */
/* ------------------------------------------------------------------ */

const BUNDLED_FONT_FILE = path.join(__dirname, "fonts", "SourceHanSansSC-Regular.otf");

/* key → SVG font-family。界面字体下拉的顺序与此一致 */
const FONT_FAMILIES = {
  sourcehan: "SourceHanSansSC",
  yahei: "Microsoft YaHei",
  hei: "SimHei",
  song: "SimSun",
};

function fontFamilyOf(key) {
  return FONT_FAMILIES[key] || FONT_FAMILIES.sourcehan;
}

/* ------------------------------------------------------------------ */
/* 文本测量                                                              */
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

/* 多行额外行高（首行保持单行盒高 1.4fs，其后每行加 1.15fs） */
const EXTRA_LINE_HEIGHT = 1.15;

/**
 * 按最大像素宽度把文字拆成多行（贪心逐字符断行）
 *  - 兼容显式换行符 \n
 *  - 中文直接断字；英文 / 数字一个词放不下时也会从中间断开，保证永不超出宽度
 *  - 行首的空格自动吞掉
 * 注意：渲染进程 renderer.js 内有一份相同实现，改动需两边同步（保证所见即所得）
 */
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

/* ------------------------------------------------------------------ */
/* 颜色与底板                                                             */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || ""));
  if (!m) return { r: 255, g: 255, b: 255 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * 根据文字颜色自动选择底板与描边：
 *   浅色文字 → 深色半透明底板 + 深色描边
 *   深色文字 → 白色半透明底板 + 白色描边
 */
function plateStyleFor(color) {
  const isLight = luminance(color) > 0.6;
  return isLight
    ? { plate: "rgba(10,13,22,0.42)", stroke: "rgba(10,13,22,0.55)" }
    : { plate: "rgba(255,255,255,0.55)", stroke: "rgba(255,255,255,0.7)" };
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ */
/* SVG 构造                                                              */
/* ------------------------------------------------------------------ */

/**
 * 构建文字层 SVG
 * @param {number} W 背景宽
 * @param {number} H 背景高
 * @param {Array}  elements 布局元素
 */
function buildOverlaySvg(W, H, elements) {
  const parts = [];

  elements.forEach((el) => {
    const text = String(el.text || "").trim();
    if (!text) return;

    const fs = Math.max(10, Number(el.fontSize) || 40);
    const family = fontFamilyOf(el.font);
    const color = /^#([a-f\d]{3}|[a-f\d]{6})$/i.test(el.color) ? el.color : "#ffffff";
    const { plate, stroke } = plateStyleFor(color);
    const rotation = Math.min(45, Math.max(-45, Number(el.rotation) || 0));

    const padX = fs * 0.42;
    const padY = fs * 0.3;

    /* 自动换行：换行宽度夹紧在 [一个字, 画面可用宽] 之间；未指定时默认画面宽的 85% */
    let lineList = [text];
    if (el.wrap === true) {
      const maxW = Math.min(
        W - padX * 2,
        Math.max(fs, Number(el.maxWidth) || W * 0.85)
      );
      lineList = wrapTextToLines(text, fs, maxW);
    }

    /* 底板盒子尺寸：宽度按最长一行；高度随行数增加（首行保持原 1.4fs） */
    const lineWidths = lineList.map((line) => measureText(line, fs));
    const textW = Math.max(...lineWidths);
    const lineCount = lineList.length;
    const boxW = textW + padX * 2;
    const boxH = fs * 1.4 + (lineCount - 1) * fs * EXTRA_LINE_HEIGHT;

    /* 坐标夹紧到画面内（x,y 为底板左上角） */
    const x = Math.min(Math.max(0, Number(el.x) || 0), Math.max(0, W - boxW));
    const y = Math.min(Math.max(0, Number(el.y) || 0), Math.max(0, H - boxH));

    const radius = fs * 0.34;
    const textX = x + padX;
    const bold = el.bold === true;
    /* 各行基线：首行位置与旧单行版一致，其后逐行下移 */
    const baselines = lineList.map(
      (_, i) => y + padY + fs * 0.82 + i * fs * EXTRA_LINE_HEIGHT
    );
    const attrsX =
      `x="${textX.toFixed(1)}" font-family="${family}" font-size="${fs.toFixed(1)}"`;

    /* 对角排版：整块（底板+文字）绕盒子中心旋转 */
    const groupParts = [];
    const pushGroup = (inner) => {
      if (rotation) {
        const cx = x + boxW / 2;
        const cy = y + boxH / 2;
        parts.push(
          `<g transform="rotate(${rotation.toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)})">` +
            inner +
            `</g>`
        );
      } else {
        parts.push(inner);
      }
    };

    /* 半透明底板（整块一个） */
    groupParts.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${boxW.toFixed(1)}" ` +
        `height="${boxH.toFixed(1)}" rx="${radius.toFixed(1)}" fill="${plate}"/>`
    );

    /* 逐行生成：投影 + 正文 */
    lineList.forEach((line, i) => {
      const common = `${attrsX} y="${baselines[i].toFixed(1)}"`;
      const safe = escapeXml(line);

      /* 文字投影 */
      groupParts.push(
        `<text ${common} fill="#000000" fill-opacity="0.28" dx="${(fs * 0.05).toFixed(1)}" dy="${(fs * 0.06).toFixed(1)}">${safe}</text>`
      );

      if (bold) {
        /* 用同色描边伪造粗体，再叠描边色保证边缘清晰 */
        groupParts.push(
          `<text ${common} fill="${color}" stroke="${color}" stroke-width="${(fs * 0.06).toFixed(1)}" ` +
            `paint-order="stroke fill">${safe}</text>`
        );
        groupParts.push(
          `<text ${common} fill="none" stroke="${stroke}" stroke-width="${(fs * 0.03).toFixed(1)}" ` +
            `paint-order="stroke">${safe}</text>`
        );
      } else {
        groupParts.push(
          `<text ${common} fill="${color}" stroke="${stroke}" stroke-width="${(fs * 0.045).toFixed(1)}" ` +
            `paint-order="stroke fill">${safe}</text>`
        );
      }
    });

    pushGroup(groupParts.join(""));
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    parts.join("") +
    `</svg>`
  );
}

/* ------------------------------------------------------------------ */
/* resvg 渲染文字层                                                      */
/* ------------------------------------------------------------------ */

function renderOverlay(svg, W, H) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: {
      fontFiles: [BUNDLED_FONT_FILE],
      loadSystemFonts: true,
      loadDefaultFonts: false,
      defaultFontFamily: "SourceHanSansSC",
    },
  });
  const rendered = resvg.render();
  /* 校验输出尺寸与背景一致 */
  if (rendered.width !== W || rendered.height !== H) {
    throw new Error(`文字层尺寸异常：${rendered.width}x${rendered.height}，应为 ${W}x${H}`);
  }
  return Buffer.from(rendered.asPng());
}

/* ------------------------------------------------------------------ */
/* 对外主入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 按用户布局在 AI 背景图上合成海报文字
 *
 * @param {Buffer} backgroundBuffer AI 背景图 buffer
 * @param {object} options
 * @param {Array<{
 *   text: string, x: number, y: number, fontSize: number,
 *   font: string, color: string, bold?: boolean
 * }>} options.elements 布局元素（x/y/fontSize 均为背景图像素坐标）
 * @returns {Promise<Buffer>} 合成后的 JPEG buffer
 */
async function addTextToPoster(backgroundBuffer, options = {}) {
  if (!Buffer.isBuffer(backgroundBuffer) || !backgroundBuffer.length) {
    throw new Error("背景图数据为空，无法合成文字。");
  }
  const elements = Array.isArray(options.elements) ? options.elements : [];
  const valid = elements.filter((el) => el && String(el.text || "").trim());
  if (!valid.length) throw new Error("布局中没有任何文字区块。");

  const meta = await sharp(backgroundBuffer).metadata();
  const W = meta.width || 1024;
  const H = meta.height || 1024;

  const svg = buildOverlaySvg(W, H, valid);
  const overlayPng = renderOverlay(svg, W, H);

  return sharp(backgroundBuffer)
    .composite([{ input: overlayPng, top: 0, left: 0 }])
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
}

/* ------------------------------------------------------------------ */
/* 离线降级背景（无 API Key / 断网时使用）                                 */
/* ------------------------------------------------------------------ */

/* 几套内置背景：渐变色 + 装饰光斑，保证软件永远能出一张海报 */
const OFFLINE_VARIANTS = [
  {
    id: "sunset",
    stops: ["#2b1055", "#7597de"],
    shapes: [
      { cx: 0.18, cy: 0.2, r: 0.28, opacity: 0.14 },
      { cx: 0.85, cy: 0.75, r: 0.34, opacity: 0.1 },
    ],
  },
  {
    id: "ocean",
    stops: ["#0f2027", "#2c5364"],
    shapes: [
      { cx: 0.8, cy: 0.15, r: 0.24, opacity: 0.16 },
      { cx: 0.15, cy: 0.85, r: 0.3, opacity: 0.12 },
    ],
  },
  {
    id: "candy",
    stops: ["#41295a", "#2f0743"],
    shapes: [
      { cx: 0.25, cy: 0.3, r: 0.2, opacity: 0.2 },
      { cx: 0.75, cy: 0.7, r: 0.26, opacity: 0.14 },
    ],
  },
  {
    id: "forest",
    stops: ["#134e5e", "#71b280"],
    shapes: [
      { cx: 0.7, cy: 0.25, r: 0.26, opacity: 0.12 },
      { cx: 0.2, cy: 0.8, r: 0.3, opacity: 0.1 },
    ],
  },
];

/**
 * 生成一张离线背景（PNG buffer）
 * @param {number} width
 * @param {number} height
 * @param {number} [variantIndex] 不指定则随机
 */
async function createOfflineBackground(width, height, variantIndex) {
  const W = Number(width) || 1024;
  const H = Number(height) || 1024;
  const idx =
    variantIndex == null
      ? Math.floor(Math.random() * OFFLINE_VARIANTS.length)
      : Math.abs(Number(variantIndex) || 0) % OFFLINE_VARIANTS.length;
  const v = OFFLINE_VARIANTS[idx];

  const shapes = v.shapes
    .map(
      (s) =>
        `<circle cx="${(s.cx * W).toFixed(0)}" cy="${(s.cy * H).toFixed(0)}" ` +
        `r="${(s.r * Math.max(W, H)).toFixed(0)}" fill="#ffffff" fill-opacity="${s.opacity}"/>`
    )
    .join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">` +
    `<stop offset="0" stop-color="${v.stops[0]}"/><stop offset="1" stop-color="${v.stops[1]}"/>` +
    `</linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#bg)"/>${shapes}` +
    `</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = {
  OFFLINE_VARIANTS,
  addTextToPoster,
  buildOverlaySvg,
  createOfflineBackground,
  fontFamilyOf,
  measureText,
  wrapTextToLines,
  BUNDLED_FONT_FILE,
};
