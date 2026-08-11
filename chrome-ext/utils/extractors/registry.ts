/** web2md — 提取器注册表。 */

import type { Extractor } from "./types";

let extractors: Extractor[] = [];

/** 注册一个提取器（先注册优先匹配） */
export function register(ex: Extractor): void {
  extractors.push(ex);
}

/** 重置注册表（测试用） */
export function reset(): void {
  extractors = [];
}

/**
 * 按注册顺序匹配 URL，返回第一个匹配的提取器。
 * 都没有匹配则返回 null（由通用提取器兜底）。
 */
export function match(url: string): Extractor | null {
  for (const ex of extractors) {
    if (ex.match(url)) return ex;
  }
  return null;
}