/** web2md — X/Twitter (x.com, twitter.com) 专用提取器。

X/Twitter timeline 是虚拟滚动列表：
1. 滚动到底部时，上方 DOM 节点会被回收 → 必须边滚边抓，按推文 permalink 去重
2. 侧边栏（导航、趋势、推荐关注、页脚）是独立列 → 只抓 [data-testid="tweet"] 推文元素
3. 引用推文是嵌套的 [data-testid="tweet"] → 遍历时跳过被嵌套的（只取最外层）
 */

import type { Extractor, ExtractOptions } from "./types";

export const xExtractor: Extractor = {
  id: "x",
  match(url: string): boolean {
    return /(x\.com|twitter\.com)\//.test(url);
  },

  async extract(doc: Document, _opts?: ExtractOptions): Promise<string | null> {
    // 判断是否是单条推文页面（/status/ 即具体推文），不需要滚动
    const isSingleTweet = /\/status\/\d+/.test(window.location.href);

    // 1. 个人资料（必须在滚动前提取，滚动后顶部 DOM 可能被回收）
    const profile = isSingleTweet ? null : extractProfile(doc);

    // 2. 等首屏推文渲染。隐藏后台标签页渲染优先级低，固定等待
    //    往往不够：不等到首屏推文就开滚，IntersectionObserver 无目标，
    //    触发不了懒加载 → 0 条推文。前台标签页几乎立即满足。
    if (!isSingleTweet) {
      await waitForFirstTweet(doc, 15000);
    }

    // 3. 滚动加载并收集推文
    const tweets = await scrollAndCollect(isSingleTweet);

    if (tweets.length === 0) return null;

    const parts: string[] = [];
    if (profile) parts.push(profile);

    for (const t of tweets) {
      const text = formatTweet(t);
      if (text) parts.push(text);
    }

    return parts.join("\n\n").replace(/\n{4,}/g, "\n\n\n").trim();
  },
};

// ── 滚动加载 + 收集 ─────────────────────────────

interface CollectedTweet {
  permalink: string;
  name: string;
  handle: string;
  time: string;
  text: string;
  quoted: string;
  stats: string[];
}

const SCROLL_DELAY_MS = 900;

// 等首屏推文出现（最多 timeoutMs）。隐藏后台标签页渲染慢，不等
// 到首屏推文就滚动会错过 IntersectionObserver 懒加载触发，导致 0 条。
async function waitForFirstTweet(doc: Document, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const hasTweets = () =>
    doc.querySelector('[data-testid="primaryColumn"] [data-testid="tweet"]');
  // 已有首屏推文 → 不等
  if (hasTweets()) return;
  while (Date.now() < deadline) {
    await sleep(300);
    if (hasTweets()) return;
  }
}

async function getScrollSteps(): Promise<number> {
  return new Promise((resolve) => {
    chrome.storage.local.get("scrollSteps", (result) => {
      const v = Number(result.scrollSteps);
      resolve(v > 0 ? v : 10);
    });
  });
}

async function scrollAndCollect(singleTweet: boolean): Promise<CollectedTweet[]> {
  const seen = new Set<string>();
  const collected: CollectedTweet[] = [];
  const steps = singleTweet ? 0 : await getScrollSteps();

  const collect = () => {
    const primaryCol = document.querySelector('[data-testid="primaryColumn"]');
    if (!primaryCol) return;
    for (const el of primaryCol.querySelectorAll('[data-testid="tweet"]')) {
      // 跳过被引用的嵌套推文（其祖先也是 tweet）
      if (el.closest('[data-testid="tweet"]') !== el) continue;

      const permalink = extractPermalink(el);
      if (!permalink || seen.has(permalink)) continue;

      seen.add(permalink);
      collected.push(extractTweetData(el));
    }
  };

  collect(); // 先抓首屏

  for (let i = 0; i < steps; i++) {
    window.scrollBy(0, window.innerHeight * 2);
    await sleep(SCROLL_DELAY_MS);
    collect();
  }

  return collected;
}

function extractPermalink(el: Element): string {
  const link = el.querySelector('a[href*="/status/"]');
  const href = link?.getAttribute("href") || "";
  const m = href.match(/\/status\/(\d+)/);
  return m ? m[1] : "";
}

function extractTweetData(el: Element): CollectedTweet {
  // 作者名 + @handle
  const userEl = el.querySelector('[data-testid="User-Name"]');
  const spans = userEl ? Array.from(userEl.querySelectorAll("span")) : [];
  const name = spans[0]?.textContent?.trim() || "";
  const handleSpan = spans.find((s) => s.textContent?.trim().startsWith("@"));
  const handle = handleSpan?.textContent?.trim() || "";

  // 时间
  const time = el.querySelector("time")?.textContent?.trim() || "";

  // 正文
  const text = el.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || "";

  // 引用推文（嵌套的引用卡片，在 aria-labelledby 容器内用 div[role="link"]）
  let quoted = "";
  // 引用卡片容器：在 aria-labelledby 的 div 里，有一个 role="link" 的元素
  const quotedContainer = el.querySelector('div[aria-labelledby] div[role="link"][tabindex="0"]');
  if (quotedContainer) {
    const quotedText = quotedContainer.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || "";
    const quotedAuthor = quotedContainer.querySelector('[data-testid="User-Name"]')?.textContent?.trim() || "";
    if (quotedText) {
      quoted = quotedAuthor ? `[${quotedAuthor}] ${quotedText}` : quotedText;
    } else {
      quoted = quotedContainer.textContent?.trim()?.slice(0, 200) || "";
    }
  }

  // 互动数据（回复/转推/赞/收藏）
  const stats: string[] = [];
  for (const [testId, label] of Object.entries(STAT_MAP)) {
    const count = el.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() || "";
    if (/\d/.test(count)) stats.push(`${label} ${count}`);
  }

  return { permalink: "", name, handle, time, text, quoted, stats };
}

const STAT_MAP: Record<string, string> = {
  reply: "回复",
  retweet: "转推",
  like: "赞",
  bookmark: "收藏",
};

// ── 格式化 ──────────────────────────────────────

function formatTweet(t: CollectedTweet): string {
  const lines: string[] = [];

  const who = [t.name, t.handle].filter(Boolean).join(" ");
  const meta = [who, t.time].filter(Boolean).join(" · ");
  if (meta) lines.push(`**${meta}**`);

  if (t.text) lines.push(t.text);
  if (t.quoted) {
    const q = t.quoted.length > 200 ? t.quoted.slice(0, 200) + "..." : t.quoted;
    lines.push(`> 引用: ${q}`);
  }
  if (t.stats.length) lines.push(`  ${t.stats.join("  ")}`);

  return lines.join("\n");
}

// ── 个人资料 ────────────────────────────────────

function extractProfile(doc: Document): string | null {
  const lines: string[] = [];
  const col = doc.querySelector('[data-testid="primaryColumn"]');
  if (!col) return null;

  const nameEl = col.querySelector('[data-testid="UserName"]');
  const displayName = nameEl?.textContent?.trim();
  if (displayName) lines.push(`# ${displayName}`);

  const handleEl = col.querySelector('[data-testid="UserName"] [dir="ltr"]');
  const handle = handleEl?.textContent?.trim();
  if (handle) lines.push(`> ${handle}`);

  const bio = col.querySelector('[data-testid="UserDescription"]')?.textContent?.trim();
  if (bio) lines.push(`> ${bio}`);

  // 关注/粉丝数
  const links = Array.from(col.querySelectorAll('a[href*="/following"], a[href*="/verified_followers"]'));
  const counts: string[] = [];
  for (const a of links) {
    const t = a.textContent?.trim();
    if (t && /\d/.test(t)) counts.push(t);
  }
  if (counts.length) lines.push(`  ${counts.join("  ")}`);

  return lines.length > 1 ? lines.join("\n") : null;
}

// ── 工具 ────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}