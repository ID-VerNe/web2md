/** web2md — npm (npmjs.com) 包页提取器。

npm 包页是 React SPA，通用提取器会把导航栏、搜索框、右侧栏
（Dependencies / Dependents / Versions / 团队成员）全部抓进来，
README 正文淹没在噪声中。

结构（已确认）：
- README 正文：`#readme`（React 渲染的 markdown HTML 容器）
- 包名：`h1` 或 `[data-package-name]`
- 包描述：`p` 在 header 区域

只处理 npm 包页（www.npmjs.com/package/{name}），其他路径
（搜索、个人页、团队页等）交给通用提取器。
 */

import type { Extractor, ExtractOptions } from "./types";

export const npmExtractor: Extractor = {
  id: "npm",

  match(url: string): boolean {
    return /^https?:\/\/(?:www\.)?npmjs\.com\/package\/[^/?#]+\/?$/.test(url);
  },

  async extract(doc: Document, _opts?: ExtractOptions): Promise<string | null> {
    const readme = doc.querySelector("#readme") as HTMLElement | null;
    if (!readme) return null;

    // 包名
    const pkgName =
      doc.querySelector("h1")?.textContent?.trim()
      || doc.querySelector('[data-package-name]')?.textContent?.trim()
      || "";

    const markdown = await convertReadme(readme);
    if (!markdown) return null;

    if (pkgName) {
      return `# ${pkgName}\n\n${markdown}`;
    }
    return markdown;
  },
};

async function convertReadme(container: HTMLElement): Promise<string | null> {
  try {
    const mod = await import("dom-to-semantic-markdown");
    const converter = (mod as any).domToSemanticMarkdown || (mod as any).default;
    if (typeof converter === "function") {
      let result = converter(container, {});
      result = result.replace(/\n{4,}/g, "\n\n\n").trim();
      return result || null;
    }
  } catch {
    // fallback 到纯文本
  }
  return container.innerText?.trim() || null;
}