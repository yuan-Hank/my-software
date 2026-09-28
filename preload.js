"use strict";

/**
 * preload.js
 * 通过 contextBridge 向渲染进程暴露安全的 IPC 接口。
 * 渲染进程统一使用 window.api.xxx(...)，不直接接触 Node / Electron。
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  /* 配置 */
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (payload) => ipcRenderer.invoke("config:save", payload),

  /* 模型 */
  fetchModels: () => ipcRenderer.invoke("models:fetch"),

  /* AI 提示词辅助 */
  assistPrompt: (payload) => ipcRenderer.invoke("prompt:assist", payload),

  /* 角色参考图 */
  pickReference: () => ipcRenderer.invoke("reference:pick"),
  clearReference: () => ipcRenderer.invoke("reference:clear"),

  /* 海报生成（两阶段：出背景原图 → 按布局合成） */
  generatePoster: (payload) => ipcRenderer.invoke("poster:generate", payload),
  cancelGenerate: () => ipcRenderer.invoke("poster:cancel"),
  composePoster: (payload) => ipcRenderer.invoke("poster:compose", payload),
  copyImageToClipboard: (payload) => ipcRenderer.invoke("poster:copyImage", payload),
  saveImageAs: (file) => ipcRenderer.invoke("poster:saveAs", file),

  /* 智能文案 */
  smartCopy: (payload) => ipcRenderer.invoke("smartcopy:run", payload),

  /* 首次启动引导 */
  finishOnboarding: () => ipcRenderer.invoke("onboarding:done"),

  /* 输出目录 */
  openOutputsDir: () => ipcRenderer.invoke("outputs:open"),

  /* 我的海报（历史记录） */
  listHistory: () => ipcRenderer.invoke("history:list"),
  getHistoryImage: (payload) => ipcRenderer.invoke("history:getImage", payload),
  deleteHistory: (payload) => ipcRenderer.invoke("history:delete", payload),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  revealHistory: (payload) => ipcRenderer.invoke("history:reveal", payload),
  saveHistoryAs: (payload) => ipcRenderer.invoke("history:saveAs", payload),
});
