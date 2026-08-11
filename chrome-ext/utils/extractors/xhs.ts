/** web2md — 小红书 (xiaohongshu.com) 专用提取器。
笔记详情以侧边栏覆盖层 (overlay) 形式渲染，通用 extractMainContent 无法定位。 */

import type { Extractor, ExtractOptions } from "./types";

export const xhsExtractor: Extractor = {
  id: "xiaohongshu",
  match(url: string): boolean {
    // 笔记详情: /explore/{id}；从搜索结果点开: /search_result/{id}（SPA 会改写地址栏）
    return /xiaohongshu\.com\/(explore|search_result)\/[a-f0-9]{24}/.test(url);
  },

  async extract(doc: Document, _opts?: ExtractOptions): Promise<string | null> {
    const noteContainer = doc.querySelector(".note-detail-mask") ||
      doc.querySelector("#noteContainer");

    if (!noteContainer) return null;

    const parts: string[] = [];

    // 标题
    const titleEl = noteContainer.querySelector("#detail-title");
    const title = titleEl?.textContent?.trim();
    if (title) parts.push(`# ${title}\n`);

    // 作者
    const authorEl = noteContainer.querySelector(".author .username, .author-wrapper .name");
    const author = authorEl?.textContent?.trim();
    if (author) parts.push(`> 作者: ${author}\n`);

    // 正文
    const descEl = noteContainer.querySelector("#detail-desc .note-text");
    if (descEl) {
      const descClone = descEl.cloneNode(true) as HTMLElement;
      for (const img of descClone.querySelectorAll("img.note-content-emoji")) {
        const alt = img.getAttribute("alt") || "";
        img.replaceWith(alt);
      }
      const text = descClone.textContent?.trim();
      if (text) parts.push(`${text}\n`);
    }

    // 图片数量
    const images = noteContainer.querySelectorAll(".swiper-slide .img-container img");
    if (images.length > 0) {
      parts.push(`\n> [共 ${images.length} 张图片]`);
    }

    // 发布时间
    const dateEl = noteContainer.querySelector(".date");
    const date = dateEl?.textContent?.trim();
    if (date) parts.push(`\n> 发布时间: ${date}`);

    // 互动数据（点赞/收藏/评论）
    const likeCount =
      noteContainer.querySelector(".interact-container .buttons .left .like-wrapper .count")?.textContent?.trim() || "";
    const collectCount =
      noteContainer.querySelector(".interact-container .buttons .left .collect-wrapper .count")?.textContent?.trim() || "";
    const commentCount =
      noteContainer.querySelector(".interact-container .buttons .left .chat-wrapper .count")?.textContent?.trim() || "";

    const stats: string[] = [];
    if (/\d/.test(likeCount)) stats.push(`点赞 ${likeCount}`);
    if (/\d/.test(collectCount)) stats.push(`收藏 ${collectCount}`);
    if (/\d/.test(commentCount)) stats.push(`评论 ${commentCount}`);
    if (stats.length) parts.push(`> ${stats.join(" · ")}`);

    // 评论
    const commentItems = noteContainer.querySelectorAll(".comment-item");
    if (commentItems.length > 0) {
      parts.push("\n---\n## 评论\n");
      for (const item of commentItems) {
        const commentAuthor = item.querySelector(".name, .username")?.textContent?.trim() || "";
        const commentText = item.querySelector(".note-text")?.textContent?.trim() || "";
        const countEl = item.querySelector(".count[selected-disabled-search]");
        const commentLikes = countEl?.textContent?.trim() || "";
        const likeNum = commentLikes.match(/\d+/) ? `${commentLikes} 赞` : "";
        if (commentText) {
          const likeSuffix = likeNum ? ` (${likeNum})` : "";
          parts.push(`**${commentAuthor}**${likeSuffix}: ${commentText}\n`);
        }
      }
    }

    return parts.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
  },
};