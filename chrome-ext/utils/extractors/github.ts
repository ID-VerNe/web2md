/** web2md — GitHub (github.com) 仓库页提取器。

GitHub 仓库页是 React SPA，通用提取器抓到的是导航壳（header、tabs、
sidebar），README 内容埋在 article.markdown-body 里。

结构（已确认）：
- 仓库名：strong a[itemprop=name] 或 h1 strong a
- README 正文：article.markdown-body（单一容器，含 h1/h2/p/ul/code 等）
- 无 README / 404 页面 → 无 article.markdown-body → 返回 null 交通用提取器

只处理仓库主页（github.com/{owner}/{repo}），其他路径（/orgs、/settings、
/blob、/pulls 等）交给通用提取器。
 */

import type { Extractor, ExtractOptions } from "./types";

export const githubExtractor: Extractor = {
  id: "github",
  match(url: string): boolean {
    return /^https?:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(url)
      || /^https?:\/\/github\.com\/[^/]+\/[^/]+\??/.test(url) && !/\/(orgs|settings|notifications|pulls|issues|search|explore|topics|trending|marketplace|codespaces|features|sponsors|about|pricing|enterprise|collections|events)/.test(url);
  },

  async extract(doc: Document, _opts?: ExtractOptions): Promise<string | null> {
    const article = doc.querySelector("article.markdown-body") as HTMLElement | null;
    if (!article) return null;

    // 仓库名
    const repoName =
      doc.querySelector('strong a[itemprop="name"]')?.textContent?.trim()
      || doc.querySelector("h1 strong a")?.textContent?.trim()
      || "";

    // article.markdown-body 已是 README 正文容器，直接用库转 Markdown，
    // 跳过 domToMarkdown 的完整管道（clone/flattenShadowDom/removeNoise）。
    const markdown = await convertArticle(article);
    if (!markdown) return null;

    if (repoName) {
      return `# ${repoName}\n\n${markdown}`;
    }
    return markdown;
  },
};

async function convertArticle(article: HTMLElement): Promise<string | null> {
  try {
    const mod = await import("dom-to-semantic-markdown");
    const converter = (mod as any).domToSemanticMarkdown || (mod as any).default;
    if (typeof converter === "function") {
      let result = converter(article, {});
      result = result.replace(/\n{4,}/g, "\n\n\n").trim();
      return result || null;
    }
  } catch {
    // fallback 到纯文本
  }
  return article.innerText?.trim() || null;
}
