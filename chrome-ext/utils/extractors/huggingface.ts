/** web2md — Hugging Face (huggingface.co) 模型/数据集页提取器。

HF 页面是 SvelteKit SSR + hydration，正文（model card）由 SVELTE_HYDRATER
容器异步渲染。结构（已确认 model 页）：
- 正文容器：.model-card-content.prose（含 h1/h2/h3/p/ul/pre/code/table，
  是 README/卡片的标准 Markdown 渲染输出）
- 首标题：容器内 h1（模型/数据集名）

通用提取器会把左侧导航、右侧 metadata（tags、downloads）、header 都抓进来，
噪声大；专用提取器只走 .model-card-content.prose。

dataset 页理论上共用同一渲染器（同 .model-card-content.prose），
但因网络问题未能实测验证 —— 若选择器不命中会返回 null 交通用提取器兜底，
不会误删内容。
 */

import type { Extractor, ExtractOptions } from "./types";

export const huggingfaceExtractor: Extractor = {
  id: "huggingface",
  match(url: string): boolean {
    return /^https?:\/\/huggingface\.co\/(models|datasets)?\/?[^/?#]+\/[^/?##]+/.test(url);
  },

  async extract(doc: Document, _opts?: ExtractOptions): Promise<string | null> {
    // 正文容器：model/dataset card 共用 .model-card-content.prose
    const card = doc.querySelector(".model-card-content.prose") as HTMLElement | null;
    if (!card) return null;

    // 卡片本身是已渲染的 Markdown HTML，直接转 Markdown，跳过完整管道
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
