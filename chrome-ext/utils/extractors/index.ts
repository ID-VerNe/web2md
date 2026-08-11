/** web2md — 提取器注册入口。
注册所有站点专用提取器 + 通用兜底。 */

import { register } from "./registry";
import { xhsExtractor } from "./xhs";
import { genericExtractor } from "./generic";

export function registerAll(): void {
  register(xhsExtractor);
  register(genericExtractor); // 通用兜底必须最后注册
}

export { match } from "./registry";
export type { Extractor, ExtractOptions } from "./types";