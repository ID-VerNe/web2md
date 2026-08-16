/** web2md — 提取器注册入口。
注册所有站点专用提取器 + 通用兜底。 */

import { register } from "./registry";
import { xhsExtractor } from "./xhs";
import { xExtractor } from "./x";
import { hnExtractor } from "./hn";
import { wikipediaExtractor } from "./wikipedia";
import { githubExtractor } from "./github";
import { huggingfaceExtractor } from "./huggingface";
import { modelscopeExtractor } from "./modelscope";
import { genericExtractor } from "./generic";

export function registerAll(): void {
  register(xhsExtractor);
  register(xExtractor);
  register(hnExtractor);
  register(wikipediaExtractor);
  register(githubExtractor);
  register(huggingfaceExtractor);
  register(modelscopeExtractor);
  register(genericExtractor); // 通用兜底必须最后注册
}

export { match } from "./registry";
export type { Extractor, ExtractOptions } from "./types";