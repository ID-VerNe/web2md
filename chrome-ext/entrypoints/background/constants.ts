/// <reference types="wxt-vite-plugin" />

/** web2md — 后台常量。 */

export const FASTAPI_HOST = "http://127.0.0.1";
export const DEFAULT_PORT = 8765;
export const HEALTH_ALARM = "web2md-health";
export const POLL_ALARM = "web2md-poll";
export const POLL_PERIOD_MIN = 1 / 60; // 1s

// ── Grok AI 页面常量 ───────────────────────────────
export const GROK_BASE = "https://x.com/i/grok";
export const GROK_TEXTAREA =
  'textarea[placeholder="随便问点什么"], textarea[placeholder="Ask anything"]';
export const GROK_SEND_BTN =
  'button[aria-label="问 Grok 问题"], button[aria-label="Ask Grok"], button[aria-label="发送"], button[aria-label="Send"]';
export const GROK_COPY_BTN =
  'button[aria-label="复制文本"], button[aria-label="Copy text"]';
export const GROK_READY_TIMEOUT_MS = 60_000;
export const GROK_TEXTAREA_TIMEOUT_MS = 15_000;
export const GROK_SEND_TIMEOUT_MS = 5_000;

// ── Google AI Mode 页面常量 ─────────────────────────
export const GOOGLE_AI_TEXTAREA = 'textarea.ITIRGe[placeholder="尽情提问"]';
export const GOOGLE_AI_SEND_BTN = 'button[aria-label="发送"], button[aria-label="Send"]';
export const GOOGLE_AI_ANSWER_ROOT = '[data-xid="aim-mars-turn-root"]';
export const GOOGLE_AI_READY_TIMEOUT_MS = 60_000;
export const GOOGLE_AI_TEXTAREA_TIMEOUT_MS = 15_000;
export const GOOGLE_AI_SEND_TIMEOUT_MS = 10_000; // Google 的输入检测比 X 慢一点