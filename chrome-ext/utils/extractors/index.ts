/** web2md — 提取器注册入口。
注册所有站点专用提取器 + 通用兜底。 */

import { register } from "./registry";
import { xhsExtractor } from "./xhs";
import { xAiExtractor } from "./x-ai";
import { xExtractor } from "./x";
import { hnExtractor } from "./hn";
import { wikipediaExtractor } from "./wikipedia";
import { githubExtractor } from "./github";
import { huggingfaceExtractor } from "./huggingface";
import { modelscopeExtractor } from "./modelscope";
import { npmExtractor } from "./npm";
import { stackexchangeExtractor } from "./stackexchange";
import { googleAiExtractor } from "./google-ai";
import { genericExtractor } from "./generic";

export function registerAll(): void {
  register(xhsExtractor);
  register(xAiExtractor); // 必须在 xExtractor 之前：x.ts 的 match 会吞掉 /i/grok URL
  register(xExtractor);
  register(hnExtractor);
  register(wikipediaExtractor);
  register(githubExtractor);
  register(huggingfaceExtractor);
  register(modelscopeExtractor);
  register(npmExtractor);
  register(stackexchangeExtractor);
  register(googleAiExtractor);
  register(genericExtractor); // 通用兜底必须最后注册
}

export { match } from "./registry";
export type { Extractor, ExtractOptions } from "./types";