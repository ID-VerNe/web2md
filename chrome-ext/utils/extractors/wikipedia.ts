/** web2md — Wikipedia ( *.wikipedia.org/wiki/* ) 专用提取器。

Wikipedia 正文在 .mw-content-ltr.mw-parser-output（注意页面上可能有多个
.mw-parser-output，只有带 mw-content-ltr/rtl 的才是正文，其余是空壳）。

MediaWiki 有两种 HTML 结构，都要兼容：
1. Parsoid 新结构（en.wiki 等）：正文用 <section data-mw-section-id="0..N">
   分节，每节含标题(h2/h3/h4，可能包在 <div class="mw-heading"> 里)和段落(p)。
2. 旧结构（zh.wiki 等）：直接在 .mw-parser-output 下平铺 p 和
   <div class="mw-heading mw-heading2"><h2>...</h2></div>，无 section 包裹。

噪声（infobox/navbox/references/hatnote/metadata/figure 等）逐个剔除。
通用提取器会把左侧导航、页脚、语言切换都转进来，噪声多；专用提取器只走正文容器。
仅处理条目页，特殊页（Special:、Help: 等）交给通用提取器。
 */

import type { Extractor, ExtractOptions } from "./types";

export const wikipediaExtractor: Extractor = {
  id: "wikipedia",
  match(url: string): boolean {
    return /\/\/[a-z-]+\.wikipedia\.org\/wiki\//.test(url)
      && !/\/wiki\/(Special|Help|Wikipedia|File|Template|Category|Portal|Talk):/i.test(url);
  },

  async extract(doc: Document, _opts?: ExtractOptions): Promise<string | null> {
    const main = doc.querySelector(".mw-content-ltr.mw-parser-output")
      || doc.querySelector(".mw-content-rtl.mw-parser-output")
      || doc.querySelector(".mw-parser-output");
    if (!main) return null;

    const clone = main.cloneNode(true) as Element;
    stripNoise(clone);

    const lines: string[] = [];
    // Parsoid 新结构：有 section 就按 section 边界遍历；旧结构无 section，
    // 直接平铺遍历 main 的直接子节点。两种情况下都按节点顺序处理标题与正文。
    const sections = [...clone.querySelectorAll("section[data-mw-section-id]")];
    const roots = sections.length > 0
      ? sections.map((s) => [...s.childNodes])
      : [[...clone.childNodes]];

    for (const nodes of roots) {
      for (const node of nodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        appendNode(node as Element, lines);
      }
    }

    const result = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return result || null;
  },
};

// 把一个节点转成 Markdown 追加到 lines
function appendNode(el: Element, lines: string[]): void {
  const tag = el.tagName;

  // 标题可能在 .mw-heading 包装里，也可能是裸 h2/h3/h4
  let heading: HTMLHeadingElement | null = null;
  if (tag === "H2" || tag === "H3" || tag === "H4") {
    heading = el as HTMLHeadingElement;
  } else if (tag === "DIV" && el.classList.contains("mw-heading")) {
    heading = el.querySelector("h2, h3, h4");
  }
  if (heading) {
    const level = "#".repeat(parseInt(heading.tagName.slice(1), 10));
    const text = cleanText(heading.textContent);
    if (text) lines.push(`\n${level} ${text}`);
    return;
  }

  if (tag === "P") {
    const text = cleanText(el.textContent);
    if (text) lines.push(text + "\n");
  } else if (tag === "UL" || tag === "OL") {
    const md = listToMarkdown(el);
    if (md) lines.push(md);
  } else if (tag === "PRE") {
    const code = cleanText(el.textContent);
    if (code) lines.push("```\n" + code + "\n```");
  } else if (tag === "TABLE") {
    const md = tableToMarkdown(el);
    if (md) lines.push(md);
  }
  // DIV 等：跳过（mw-heading 已处理，其余 wrapper 不展开，避免噪声泄漏）
}

const NOISE_SELECTORS = [
  ".infobox", ".vertical-navbox", ".navbox", ".sistersitebox", ".side-box",
  ".mw-references-wrap", ".reflist", ".mw-editsection", ".mw-empty-elt",
  ".hatnote", ".ambox", ".tmbox", ".ombox", ".cmbox", ".fmbox",
  ".metadata", ".shortdescription", ".noprint", ".noexcerpt",
  "figure", ".thumb", "table.infobox", "style", "script",
  ".mw-cite-backlink", ".reference", ".mw-ref",
  ".mw-jump-link", ".noteTA", ".mw-popups-media",
];

function stripNoise(root: Element): void {
  for (const sel of NOISE_SELECTORS) {
    for (const el of root.querySelectorAll(sel)) {
      el.remove();
    }
  }
}

function cleanText(text: string | null): string {
  return (text || "")
    .replace(/\s+/g, " ")
    .replace(/\[\d+\]/g, "") // 去掉引用编号 [1] [2]
    .trim();
}

function listToMarkdown(el: Element): string {
  const items = [...el.querySelectorAll(":scope > li")];
  if (items.length === 0) return "";
  const isOrdered = el.tagName === "OL";
  return items
    .map((li, i) => `${isOrdered ? `${i + 1}.` : "-"} ${cleanText(li.textContent)}`)
    .join("\n");
}

function tableToMarkdown(el: Element): string {
  const rows = [...el.querySelectorAll("tr")];
  if (rows.length === 0) return "";
  const lines: string[] = [];
  rows.forEach((row, idx) => {
    const cells = [...row.querySelectorAll("th, td")]
      .map((c) => cleanText(c.textContent).replace(/\|/g, "\\|"));
    if (cells.length === 0) return;
    lines.push(`| ${cells.join(" | ")} |`);
    if (idx === 0 && row.querySelector("th")) {
      lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
    }
  });
  return lines.length > 1 ? lines.join("\n") : "";
}
