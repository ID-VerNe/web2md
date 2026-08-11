/** web2md — 通用提取器。
包装 dom-to-semantic-markdown 库，作为注册表兜底。 */

import type { Extractor, ExtractOptions } from "./types";
import { domToMarkdown } from "@/utils/converter";

export const genericExtractor: Extractor = {
  id: "generic",
  match(_url: string): boolean {
    return true; // 兜底，永远匹配
  },

  async extract(doc: Document, opts?: ExtractOptions): Promise<string | null> {
    return domToMarkdown(doc, opts);
  },
};