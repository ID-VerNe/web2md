/// <reference types="wxt-vite-plugin" />

/** web2md — Google AI Mode 提问任务（多轮追问）。

打开 google.com/search?udm=50 页面，在"尽情提问"输入框填入 prompt，
点击发送按钮，等回答渲染后提取对话。

与 grok_ask 不同：Google 不需要前台标签（无 X 的反自动化检测），
但保持 active:false 隐藏标签提取（SPA 惰性渲染，需 waitForContent）。
多轮追问依赖第一轮任务回写的 tab_url（含 mstk 会话参数）——重新打开
该 URL 即恢复 context。

流程：tabs.create(url) → waitForSelector(textarea) → value setter +
input 事件 → 寻找发送按钮 / Enter 键 → 轮询内容变化 → extractFromTab
→ 回写（含最终 tabUrl）→ 关标签。
*/

import { validateUrl, UnsafeUrlError } from "@/utils/url-validator";
import { isBlacklisted } from "./blacklist";
import { trackOrphanTab, forgetOrphanTab } from "./orphan-tabs";
import { waitForSelector, waitTabComplete, waitForContent } from "./tab-utils";
import { extractFromTab } from "./extract-from-tab";
import {
  GOOGLE_AI_TEXTAREA,
  GOOGLE_AI_READY_TIMEOUT_MS,
  GOOGLE_AI_TEXTAREA_TIMEOUT_MS,
  GOOGLE_AI_SEND_TIMEOUT_MS,
} from "./constants";

export async function openGoogleAiAsk(
  taskId: string,
  params: any,
  reportResult: (
    taskId: string,
    markdown: string | null,
    status?: string,
    tabUrl?: string
  ) => Promise<void>
): Promise<void> {
  const prompt = params?.prompt;
  if (!prompt || !String(prompt).trim()) {
    console.log("web2md: google_ai_ask missing prompt, task failed", taskId);
    await reportResult(taskId, null, "failed");
    return;
  }

  // 目标 URL：优先用第一轮回写的 tab_url（恢复 context），否则用任务 URL
  const requestedUrl = params?.tab_url || params?.url;
  if (!requestedUrl) {
    console.log("web2md: google_ai_ask missing url, task failed", taskId);
    await reportResult(taskId, null, "failed");
    return;
  }

  // URL 安全检查
  try {
    validateUrl(requestedUrl);
  } catch (e) {
    console.log(
      "web2md: url rejected, task failed",
      taskId,
      (e as UnsafeUrlError).message
    );
    await reportResult(taskId, null, "failed");
    return;
  }
  if (await isBlacklisted(requestedUrl)) {
    console.log("web2md: blacklisted, task failed", taskId, requestedUrl);
    await reportResult(taskId, null, "failed");
    return;
  }

  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: requestedUrl, active: false });
    tabId = tab.id;
    if (!tabId) throw new Error("no tab id");
    await trackOrphanTab(tabId, taskId, requestedUrl);

    // 等页面加载完 + 内容就绪（SPA 惰性渲染）
    await waitTabComplete(tabId, 2000);
    await waitForContent(tabId, requestedUrl, 15000);

    // 等输入框渲染
    await waitForSelector(tabId, GOOGLE_AI_TEXTAREA, GOOGLE_AI_TEXTAREA_TIMEOUT_MS);

    // 填入 prompt（value setter + input 事件触发 React 检测）
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (text) => {
        const ta = document.querySelector(
          'textarea[placeholder="尽情提问"], textarea[role="textbox"]'
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

    // 等输入被识别
    await new Promise((r) => setTimeout(r, 1000));

    // 点击发送按钮或发送 Enter 键
    const sent = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // 方案 1: 找显式发送按钮。Google AI Mode (udm=50) 的输入区是
        // .o8Wipc 内按钮组（uMMzHc），发送按钮有 aria-label="发送" 或
        // "Send"（带输入时会解除 disabled，无文本内容）。
        const composeButtons = Array.from(
          document.querySelectorAll(
            'button[uMMzHc], button[aria-label="发送"], button[aria-label="Send"]'
          )
        );
        for (const btn of composeButtons) {
          if ((btn as HTMLButtonElement).disabled) continue;
          (btn as HTMLButtonElement).click();
          return "clicked_send_btn";
        }

        // 方案 2: Enter 键发送
        const ta = document.querySelector(
          'textarea[placeholder="尽情提问"], textarea[role="textbox"]'
        ) as HTMLTextAreaElement | null;
        if (ta) {
          ta.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          }));
          return "sent_enter_key";
        }

        return "no_send_method_found";
      },
    });
    console.log("[web2md-diag] google-ai-task send method:", sent?.[0]?.result);

    // 先等一小段时间让页面处理输入
    await new Promise((r) => setTimeout(r, 2000));

    // 检查输入框是否被清空（消息已发送）
    const cleared = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const ta = document.querySelector(
          'textarea[placeholder="尽情提问"], textarea[role="textbox"]'
        ) as HTMLTextAreaElement | null;
        return ta ? ta.value === "" : false;
      },
    });

    // 如果输入框没被清空，再试一次发送
    if (!cleared?.[0]?.result) {
      console.log("[web2md-diag] google-ai-task: input not cleared, retrying send");
      // 再试一次点击
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const composeButtons = Array.from(
            document.querySelectorAll(
              'button[aria-label="发送"], button[aria-label="Send"]'
            )
          );
          for (const btn of composeButtons) {
            if ((btn as HTMLButtonElement).disabled) continue;
            (btn as HTMLButtonElement).click();
            return true;
          }
          return false;
        },
      });
      await new Promise((r) => setTimeout(r, 3000));
    }

    // 等新回答渲染：轮询 turn 容器数量变化
    // 不能用 waitForSelector 因为 [data-xid="aim-mars-turn-root"] 在第一轮已存在。
    // 也不能用总内容长度（多轮时第一轮内容已占大头，变化率 <10% 误判为稳定）。
    // 正确做法：记录发送前的 turn 数量，等新 turn 出现且 data-complete="true"。
    console.log("[web2md-diag] google-ai-task: waiting for answer...");
    const answerDeadline = Date.now() + GOOGLE_AI_READY_TIMEOUT_MS;

    // 记录发送前的 turn 数量
    const beforeCount = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return document.querySelectorAll(
          '[data-xid="aim-mars-turn-root"] [data-scope-id="turn"]'
        ).length;
      },
    });
    const initialTurnCount = beforeCount?.[0]?.result || 0;
    console.log("[web2md-diag] google-ai-task: initialTurnCount:", initialTurnCount);

    while (Date.now() < answerDeadline) {
      const turnState = await chrome.scripting.executeScript({
        target: { tabId },
        func: (minCount) => {
          const turns = document.querySelectorAll(
            '[data-xid="aim-mars-turn-root"] [data-scope-id="turn"]'
          );
          if (turns.length <= minCount) return { count: turns.length, ready: false };
          // 新 turn 出现，检查最后一个 turn 是否 complete
          const lastTurn = turns[turns.length - 1];
          const complete = lastTurn.getAttribute("data-complete") === "true";
          // 同时也检查内容是否 >200（确保有实际文本）
          const textLen = lastTurn.textContent?.trim().length || 0;
          return { count: turns.length, ready: complete && textLen > 200 };
        },
        args: [initialTurnCount],
      });
      const state = turnState?.[0]?.result;
      if (state?.ready) {
        console.log("[web2md-diag] google-ai-task: new turn ready, count:", state.count);
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log("[web2md-diag] google-ai-task: answer ready, contentLen:", lastLen);

    // 提取（content script → google-ai 提取器）
    const markdown = await extractFromTab(tabId, requestedUrl);

    // 获取实际 tab URL（含会话参数，供后续轮次复用）
    const finalTab = await chrome.tabs.get(tabId);
    const tabUrl = finalTab?.url || requestedUrl;

    await reportResult(taskId, markdown, "done", tabUrl);
  } catch (err) {
    console.error("web2md: openGoogleAiAsk failed", taskId, err);
    await reportResult(taskId, null, "failed");
  } finally {
    if (tabId !== undefined) {
      await chrome.tabs.remove(tabId).catch(() => {});
      await forgetOrphanTab(tabId);
    }
  }
}