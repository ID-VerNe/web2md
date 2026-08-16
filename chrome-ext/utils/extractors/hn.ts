/** web2md — Hacker News (news.ycombinator.com) 专用提取器。

HN 首页/列表页是 1990s 风格的 <table> 布局：
1. 每个帖子占两行：<tr class="athing">（标题）+ 紧邻 <tr>（分数/作者/评论）
2. 通用提取器对这种无 <main>/<article>/<p> 的结构会返回空 → 走 body.innerText，
   混入导航/footer/第三方扩展注入的 CSS（如 #rwl-iqxin）。
3. 专用提取器只抓 .athing 行，输出结构化的帖子列表。

item 页（item?id=）是评论页，结构不同，留给通用提取器处理。
 */

import type { Extractor, ExtractOptions } from "./types";

export const hnExtractor: Extractor = {
  id: "hn",
  match(url: string): boolean {
    return /news\.ycombinator\.com\/(news|newest|front|ask|show|jobs)?(\?|$)/.test(url)
      || /news\.ycombinator\.com\/$/.test(url);
  },

  async extract(doc: Document, _opts?: ExtractOptions): Promise<string | null> {
    const rows = [...doc.querySelectorAll(".athing")];
    if (rows.length === 0) return null;

    const posts: string[] = [];
    for (const row of rows) {
      const post = formatPost(row);
      if (post) posts.push(post);
    }

    if (posts.length === 0) return null;
    return posts.join("\n\n");
  },
};

interface Post {
  rank: string;
  title: string;
  link: string;
  site: string;
  score: string;
  user: string;
  age: string;
  comments: string;
}

function parsePost(row: Element): Post | null {
  const titleLink = row.querySelector(".titleline > a") as HTMLAnchorElement | null;
  if (!titleLink) return null;

  const sub = row.nextElementSibling;

  // 评论数：subtext 里包含 "comments"/"discuss" 的链接
  let comments = "";
  if (sub) {
    const commentLinks = [...sub.querySelectorAll("a")]
      .filter((a) => /comments?|discuss/.test(a.textContent || ""));
    comments = commentLinks.length
      ? commentLinks[commentLinks.length - 1].textContent?.trim() || ""
      : "";
  }

  return {
    rank: row.querySelector(".rank")?.textContent?.trim() || "",
    title: titleLink.textContent?.trim() || "",
    link: titleLink.href || "",
    site: row.querySelector(".sitebit a")?.textContent?.trim() || "",
    score: sub?.querySelector(".score")?.textContent?.trim() || "",
    user: sub?.querySelector(".hnuser")?.textContent?.trim() || "",
    age: sub?.querySelector(".age a")?.textContent?.trim() || "",
    comments,
  };
}

function formatPost(row: Element): string | null {
  const p = parsePost(row);
  if (!p || !p.title) return null;

  const lines: string[] = [];

  // 标题行：序号 + 标题（带链接）
  const rank = p.rank ? `${p.rank} ` : "";
  lines.push(`${rank}## [${p.title}](${p.link})`);

  // 元信息行
  const meta: string[] = [];
  if (p.site) meta.push(`来源: ${p.site}`);
  if (p.score) meta.push(p.score);
  if (p.user) meta.push(`by ${p.user}`);
  if (p.age) meta.push(p.age);
  if (p.comments) meta.push(p.comments);
  if (meta.length) lines.push(`> ${meta.join(" · ")}`);

  return lines.join("\n");
}
