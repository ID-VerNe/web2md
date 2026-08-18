/** web2md — 从 Markdown 文本中检测并清除 JS/CSS 代码行。

通用网页的 Markdown 输出中，有时混入内联在可见文本节点里的 JS/CSS
代码片段（如 function doLogout() { document.logoutForm.submit() } 等）。
这些代码不在 <script>/<style> 标签里，而是被页面 JS 动态写入文本节点，
无法通过 DOM 选择器过滤，只能在文本层面按语法特征筛查。

策略：检测每行的语法特征，按"代码行" vs "自然语言文本行"分类。
倾向于误杀（漏删一行代码损失不大，保留一行代码污染输出），
所以检测条件偏宽松。 */

const CODE_PATTERNS = [
  // 1. 行首明确的 JS 声明/控制流
  /^(function\b|function\s*\w*\s*\()/,
  /^(var\s+|let\s+|const\s+)/,
  /^(if\s*\(|for\s*\(|while\s*\(|do\s*\{|switch\s*\()/,
  /^(return\s|throw\s|try\s*\{|catch\s*\(|finally\s*\{)/,
  /^(async\s+function|async\s+\(|await\s+)/,
  /^(class\s+\w+|new\s+\w+\s*\(|import\s+|export\s+)/,
  /^(typeof\s+|delete\s+|void\s+|yield\s+)/,

  // 2. 行首明确的 JS API 调用或 DOM 操作
  /^(document\.|window\.|globalThis\.|self\.|console\.|location\.|history\.)/,
  /^(alert\(|confirm\(|prompt\(|fetch\(|setTimeout\(|setInterval\(|clearTimeout\(|clearInterval\()/,
  /^(JSON\.|Math\.|Date\.|Promise\.|Array\.|Object\.|String\.|Number\.|Boolean\.|RegExp\.|Error\.|Map\.|Set\.|WeakMap\.|WeakSet\.|Symbol\.)/,
  /^httpRequest\s*=/,
  /^httpRequest\.[a-zA-Z]+\(/,
  /^httpRequest\s*=/,

  // 3. jQuery / 常见库
  /^(\$\(|jQuery\(|\$\.(get|post|ajax|on|each|map|extend|when|Deferred)\(|_\$)/,

  // 4. 行中明确的 JS 特征（行首前可能有空格，但整行是代码）
  /(addEventListener\(|removeEventListener\(|querySelector\(|querySelectorAll\(|getElementById\(|getElementsBy|createElement\(|appendChild\(|insertBefore\(|setAttribute\(|getAttribute\()/,
  /(innerHTML\s*=|outerHTML\s*=|textContent\s*=|innerText\s*=)/,
  /(\.submit\(\)|\.click\(\)|\.focus\(\)|\.blur\(\)|\.preventDefault\(\)|\.stopPropagation\(\))/,
  /(\$\s*\(|\.css\s*\(|\.animate\s*\(|\.slide|\.fade|\.ajax)/,
  /(XMLHttpRequest|ActiveXObject|FormData|FileReader|Blob|ArrayBuffer)/,
  /(_satellite\[|_satellite\.|adobeDataLayer|dataLayer\.push)/,
  /httpRequest\.(open|send)/,

  // 5. CSS 声明行
  /^[a-zA-Z-]+\s*:\s*[^;{}]+;*$/,
  // 6. 注释行（// ... 或 /* ... */）
  /^\s*\/\/.*$/,
  /^\s*\/\*/,
  /^\s*\*\//,
  // 7. 独立的括号/闭包残行：} }); })(); }, 10); (function(){...})() 等
  /^\s*[}\])]\s*[;,\)\d\s]*\)*\s*;*\s*$/,
  /^\s*\}\)\s*\(\s*\)\s*;?\s*$/,
  /^\s*\}\s*\)\s*;?\s*$/,
  // 8. 函数调用语句（以 ; 结尾的调用）
  /^[a-z_]\w*\s*\([^)]*\)\s*;\s*$/,

  // 9. 行中 CSS 选择器：#id{...} 或 .class{...}
  /#[a-zA-Z][-\w]*\{/,
  /\.[a-zA-Z][-\w]*\{/,
  // CSS 特有属性
  /z-index:\s*\d+/,
  /box-sizing:\s*border-box/,
  /-webkit-/,
  /-moz-/,
];

export function isCodeLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;

  // 极短行只检查纯括号/分号
  if (t.length < 3) return /^[{}();)\]\[ ]+$/.test(t);

  // 跳过数字行、纯 URL 行、纯标点行
  if (/^[\d\s,.!?]+$/.test(t)) return false;
  if (/^https?:\/\/\S+$/.test(t)) return false;

  // 检查模式匹配
  for (const pattern of CODE_PATTERNS) {
    if (pattern.test(t)) return true;
  }

  // 高密度代码符号检测：{ } ( ) ; 占比超过字母数的 25%
  const codeChars = (t.match(/[{}();]/g) || []).length;
  const alphaChars = (t.match(/[a-zA-Z]/g) || []).length;
  if (codeChars >= 2 && alphaChars > 0 && codeChars > alphaChars * 0.25) return true;

  // 长行且行末为分号，前有括号结构（如闭包结尾）
  if (t.length > 30 && /;\s*$/.test(t) && /[{}()]/.test(t)) return true;

  return false;
}

/** 从 Markdown 文本中移除所有看起来像 JS/CSS 代码的行。
 * 不改变保留行的内容，只过滤掉检测为代码的行。
 * 最后合并连续空行。 */
export function cleanCodeLines(text: string): string {
  if (!text) return text;

  const lines = text.split("\n");
  const cleaned = lines.filter((line) => !isCodeLine(line));

  // 合并连续空行（最多 2 个）
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}