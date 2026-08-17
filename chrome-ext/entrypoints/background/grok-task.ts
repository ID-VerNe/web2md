/// <reference types="wxt-vite-plugin" />

/** web2md — Grok AI 提问任务。

打开 x.com/i/grok，输入 prompt 并点击"问 Grok 问题"发送按钮，
等回复渲染后提取对话。

注意：必须 active: true 前台打开——X.com 对后台隐藏标签页有
反自动化检测（"Something went wrong" 错误页，textarea 不渲染）。
前台标签页自动提取后即关闭。
*/

import { validateUrl, UnsafeUrlError } from "@/utils/url-validator";
import { isBlacklisted } from "./blacklist";
import { trackOrphanTab, forgetOrphanTab } from "./orphan-tabs";
import { waitForSelector } from "./tab-utils";
import { extractFromTab } from "./extract-from-tab";
import {
  GROK_BASE,
  GROK_COPY_BTN,
  GROK_SEND_BTN,
  GROK_TEXTAREA,
  GROK_READY_TIMEOUT_MS,
  GROK_TEXTAREA_TIMEOUT_MS,
  GROK_SEND_TIMEOUT_MS,
} from "./constants";

export async function openGrokAndAsk(
  taskId: string,
  params: any,
  reportResult: (
    taskId: string,
    markdown: string | null,
    status?: string
  ) => Promise<void>
): Promise<void> {
  const prompt = params?.prompt;
  if (!prompt || !String(prompt).trim()) {
    console.log("web2md: grok_ask missing prompt, task failed", taskId);
    await reportResult(taskId, null, "failed");
    return;
  }

  // URL 安全检查
  try {
    validateUrl(GROK_BASE);
  } catch (e) {
    console.log(
      "web2md: url rejected, task failed",
      taskId,
      (e as UnsafeUrlError).message
    );
    await reportResult(taskId, null, "failed");
    return;
  }
  if (await isBlacklisted(GROK_BASE)) {
    console.log("web2md: blacklisted, task failed", taskId, GROK_BASE);
    await reportResult(taskId, null, "failed");
    return;
  }

  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({
      url: GROK_BASE,
      active: true, // 必须前台：X.com 反自动化检测隐藏标签页
    });
    tabId = tab.id;
    if (!tabId) throw new Error("no tab id");
    await trackOrphanTab(tabId, taskId, GROK_BASE);

    // 等 Grok 对话输入框渲染（登录态时正常渲染；未登录则超时失败）
    await waitForSelector(tabId, GROK_TEXTAREA, GROK_TEXTAREA_TIMEOUT_MS);

    // 填入 prompt（用 value setter + input 事件触发 React 检测）
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (text) => {
        const ta = document.querySelector(
          'textarea[placeholder="随便问点什么"], textarea[placeholder="Ask anything"]'
        ) as HTMLTextAreaElement | null;
        if (!ta) return "no_textarea";
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )?.set;
        if (setter) setter.call(ta, text);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return "ok";
      },
      args: [String(prompt)],
    });

    // 等 X 处理输入后出现"问 Grok 问题"发送按钮
    await waitForSelector(tabId, GROK_SEND_BTN, GROK_SEND_TIMEOUT_MS);

    // 点击发送按钮（X 的 button click 是原生事件，React 认）
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const btn = document.querySelector(
          'button[aria-label="问 Grok 问题"], button[aria-label="Ask Grok"]'
        ) as HTMLElement | null;
        if (btn) btn.click();
        return !!btn;
      },
    });

    // 等回复渲染：复制文本按钮出现 = 答案行已注入
    await waitForSelector(tabId, GROK_COPY_BTN, GROK_READY_TIMEOUT_MS);

    // 提取（走 content script → x-ai 提取器）
    const markdown = await extractFromTab(tabId, GROK_BASE);
    await reportResult(taskId, markdown);
  } catch (err) {
    console.error("web2md: openGrokAndAsk failed", taskId, err);
    await reportResult(taskId, null, "failed");
  } finally {
    if (tabId !== undefined) {
      await chrome.tabs.remove(tabId).catch(() => {});
      await forgetOrphanTab(tabId);
    }
  }
}