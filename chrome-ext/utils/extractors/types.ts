/** web2md — 提取器类型定义。 */

import type { ConversionOptions } from "dom-to-semantic-markdown";

/** 提取选项（与消息/库兼容） */
export interface ExtractOptions {
  contentMode?: "article" | "full";
}

/**
 * 站点专用提取器接口。
 * - match(url)：是否适用于当前页面
 * - extract(doc, opts)：提取 Markdown，返回 null 表示"放弃，交给下一个"
 */
export interface Extractor {
  id: string;
  match(url: string): boolean;
  extract(doc: Document, opts?: ExtractOptions): Promise<string | null>;
}

export type { ConversionOptions };