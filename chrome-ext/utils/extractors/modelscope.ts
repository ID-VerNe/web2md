/** web2md — ModelScope (modelscope.cn) 模型页提取器。

ModelScope 页面正文（README/模型卡片）在 .ms-markdown-wrapper 容器里，
含 h1/h2/h3/p/pre/code/img。通用提取器会把左侧栏、模型文件列表、
评论区都抓进来，噪声大；专用提取器只走 .ms-markdown-wrapper。

匹配 /models/{org}/{model}，其他路径（/datasets、/spaces、/api 等）
交给通用提取器。
 */

import type { Extractor, ExtractOptions } from "./types";

export const modelscopeExtractor: Extractor = {
  id: "modelscope",
  match(url: string): boolean {
    return /^https?:\/\/(?:www\.)?modelscope\.cn\/models\/[^/]+\/[^/]+/.test(url);
  },

  async extract(doc: Document, _opts?: ExtractOptions): Promise<string | null> {
    const card = doc.querySelector(".ms-markdown-wrapper") as HTMLElement | null;
    if (!card) return null;

    const markdown = await convertCard(card);
    return markdown || null;
  },
};

async function convertCard(card: HTMLElement): Promise<string | null> {
  try {
    const mod = await import("dom-to-semantic-markdown");
    const converter = (mod as any).domToSemanticMarkdown || (mod as any).default;
    if (typeof converter === "function") {
      let result = converter(card, {});
      result = result.replace(/\n{4,}/g, "\n\n\n").trim();
      return result || null;
    }
  } catch {
    // fallback 到纯文本
  }
  return card.innerText?.trim() || null;
}
