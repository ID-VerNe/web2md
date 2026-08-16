/** web2md — Markdown 转换工具。

封装 dom-to-semantic-markdown，在浏览器 DOM 环境中执行转换。
优先使用库内置的 extractMainContent 提取正文，辅以额外的噪声清理。
*/
import type { ConversionOptions } from "dom-to-semantic-markdown";

/** 补充的噪声元素选择器（库已自动跳过 script/style/noscript/aside/footer/header/nav 标签） */
const EXTRA_NOISE_SELECTORS = [
  '[class*="cookie"]', '[class*="consent"]', '[class*="banner"]',
  '[class*="popup"]', '[class*="modal"]', '[class*="overlay"]',
  '[class*="social"]', '[class*="share"]', '[class*="sharing"]',
  '[class*="breadcrumb"]', '[class*="toolbar"]',
  '[class*="hidden"]', '[class*="visually-hidden"]', '[class*="sr-only"]',
  '[class*="print"]', '[class*="back-to-top"]',
  '[class*="related"]', '[class*="recommend"]',
  '[class*="comment"]', '[class*="comments"]',
  '[role="contentinfo"]', '[role="banner"]',
  '[role="complementary"]', '[role="alert"]',
  '[style*="display:none"]', '[style*="display: none"]',
  '[hidden]', '[aria-hidden="true"]',
];

function removeNoise(doc: Document): void {
  for (const selector of EXTRA_NOISE_SELECTORS) {
    try {
      for (const el of doc.querySelectorAll(selector)) {
        if (el.tagName === "BODY" || el.tagName === "HTML") continue;
        el.parentNode?.removeChild(el);
      }
    } catch {
      // 跳过非法选择器
    }
  }
}

/** 将原始文档的 shadow DOM 内容展平进克隆文档的对应宿主元素中。

cloneNode(true) 不克隆 shadowRoot，导致基于 querySelector 的提取
漏掉 SPA（小红书、YouTube 等）放在自定义元素 shadowRoot 里的内容。
利用原始文档与克隆文档树结构完全一致的特性，并行遍历两棵树，
把原始文档中每个 shadowRoot 的内容复制到克隆文档的对应元素下。 */
function flattenShadowDom(originalDoc: Document, clonedDoc: Document): void {
  const walk = (original: Element, cloned: Element): void => {
    if (original.shadowRoot) {
      // 某些 ShadowRoot 在隐藏标签页/特定时机不可克隆（NotSupportedError）。
      // 单个 shadowRoot 克隆失败不应让整个提取失败 → 跳过它。
      try {
        const wrapper = clonedDoc.createElement("div");
        wrapper.dataset.web2mdShadow = "true";
        const shadowClone = original.shadowRoot.cloneNode(true) as ShadowRoot;
        while (shadowClone.firstChild) wrapper.appendChild(shadowClone.firstChild);
        cloned.appendChild(wrapper);
      } catch {
        // 跳过不可克隆的 shadowRoot
      }
    }

    const origLen = original.children.length;
    const cloneLen = cloned.children.length;
    const len = Math.min(origLen, cloneLen);
    for (let i = 0; i < len; i++) {
      walk(original.children[i] as Element, cloned.children[i] as Element);
    }
  };

  // 整棵树遍历的兜底：根节点异常时不要让 domToMarkdown 整体失败
  try {
    walk(originalDoc.documentElement, clonedDoc.documentElement);
  } catch {
    // 跳过整个 shadow 展平（极少见）
  }
}

/**
 * 将 DOM 转为语义化 Markdown。
 * 专为 LLM 阅读优化。
 *
 * article 模式：
 * 1. 先移除页面噪声元素
 * 2. 用库的 extractMainContent 提取正文容器
 * 3. 自动清理多余空行
 */
export async function domToMarkdown(
  doc: Document = document,
  options?: { contentMode?: "article" | "full" }
): Promise<string> {
  const isArticle = options?.contentMode !== "full";

  // 克隆文档，避免改变用户看到的页面
  const workingDoc = doc.cloneNode(true) as Document;

  // 展平 Shadow DOM：把原始文档中每个 shadowRoot 的内容复制到克隆文档的对应元素下
  flattenShadowDom(doc, workingDoc);

  // 先移除噪声
  if (isArticle) {
    removeNoise(workingDoc);
  }

  try {
    const mod = await import("dom-to-semantic-markdown");
    const converter = (mod as any).domToSemanticMarkdown || (mod as any).default;
    if (typeof converter === "function") {
      const opts: ConversionOptions = isArticle
        ? { extractMainContent: true }
        : {};

      let result = converter(workingDoc, opts);

      // extractMainContent 返回空 → 降级为全页模式。
      // 库的 findMainContent 对无 <main>/<article>/<section>/<p> 的
      // 页面（如 HN 的 <table> 布局、GitHub 的 SPA 壳）可能返回空。
      // removeNoise 已先跑过，降级后结果仍是去噪后的完整页面。
      if (isArticle && (!result || !result.trim())) {
        result = converter(workingDoc, { ...opts, extractMainContent: false });
      }

      result = result.replace(/\n{4,}/g, "\n\n\n").trim();
      return result;
    }
  } catch {
    // fallback 到纯文本
  }

  return workingDoc.body?.innerText?.trim() || "";
}

// ── DOM 结构分析 ──────────────────────────────────

interface DomNodeInfo {
  tag: string;
  id?: string;
  classes: string[];
  textLength: number;
  childCount: number;
  children: DomNodeInfo[];
}

/** 提取 DOM 骨架结构（用于分析页面布局，不含实际文本内容） */
export function debugDomStructure(
  doc: Document = document,
  maxDepth = 6,
  maxChildren = 20
): DomNodeInfo[] {
  const results: DomNodeInfo[] = [];

  function walk(node: Element, depth: number): DomNodeInfo | null {
    if (depth > maxDepth) return null;
    const tag = node.tagName.toLowerCase();
    // 跳过无意义的标签
    if (["script", "style", "noscript", "svg", "path", "use"].includes(tag)) return null;

    const children: DomNodeInfo[] = [];
    let childCount = 0;
    for (const child of node.children) {
      if (childCount >= maxChildren) {
        children.push({ tag: "...", classes: [], textLength: 0, childCount: 0, children: [] });
        break;
      }
      const info = walk(child, depth + 1);
      if (info) {
        children.push(info);
        childCount++;
      }
    }

    const text = node.textContent?.trim() || "";
    return {
      tag,
      id: node.id || undefined,
      classes: Array.from(node.classList),
      textLength: text.length,
      childCount: children.length,
      children,
    };
  }

  const body = doc.body;
  if (body) {
    for (const child of body.children) {
      const info = walk(child, 0);
      if (info) results.push(info);
    }
  }
  return results;
}