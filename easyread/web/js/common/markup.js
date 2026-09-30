/* 行内标记：$TeX$、**粗体**、*斜体*、`代码`、[n] 引用，以及“公式 (1) / 表 2 / 第 2.2 节 / 附录 A”这类交叉引用。
   译文、讨论、笔记都用同一套，用户编辑时看到的就是这套原始标记。 */
(function (PR) {
  "use strict";
  const MATH = /(?<!\\)\$((?:\\\$|[^$])+?)(?<!\\)\$/g;
  const mathCache = new Map();

  PR.tex = function (tex, display) {
    const key = (display ? "D" : "I") + tex;
    if (mathCache.has(key)) return mathCache.get(key);
    let html;
    try {
      html = katex.renderToString(tex, { displayMode: !!display, throwOnError: false, strict: "ignore", trust: false });
    } catch (e) {
      html = '<code title="公式渲染失败">' + PR.esc(tex) + "</code>";
    }
    mathCache.set(key, html);
    return html;
  };

  function citeLinks(s) {
    return s.replace(/\[(\d+(?:\s*[,，–-]\s*\d+)*)\]/g, (m, inner) => {
      const parts = inner.split(/(\s*[,，–-]\s*)/);
      const linked = parts.map((p) => (/^\d+$/.test(p) && PR.refById && PR.refById[p])
        ? '<a class="cite" data-ref="' + p + '">' + p + "</a>" : p).join("");
      return "[" + linked + "]";
    });
  }

  function xref(kind, key, label) {
    const ix = PR.xindex && PR.xindex[kind];
    if (!ix || !ix[key]) return label;
    return '<a class="xref" data-kind="' + kind + '" data-key="' + PR.esc(key) + '">' + label + "</a>";
  }

  function xrefLinks(s) {
    // 公式 (9) 和 (10)：把这一串里每个编号都链上
    s = s.replace(/公式\s*[（(]\d+[）)](?:\s*(?:和|与|及|、|或|,|，)\s*[（(]\d+[）)])*/g,
      (m) => m.replace(/[（(](\d+)[）)]/g, (mm, n) => xref("eq", n, mm)));
    s = s.replace(/公式\s*(\d+)(?![\d.）)])/g, (m, n) => xref("eq", n, m));
    s = s.replace(/表\s*(\d+)/g, (m, n) => xref("tab", n, m));
    s = s.replace(/图\s*(\d+)/g, (m, n) => xref("fig", n, m));
    s = s.replace(/第\s*(\d+(?:\.\d+)*)\s*节/g, (m, n) => xref("sec", n, m));
    s = s.replace(/附录\s*([A-Z])(?![a-zA-Z])/g, (m, n) => xref("sec", n, m));
    // 英文原文里的
    s = s.replace(/\b(Equations?)\s+(\d+)(?:\s+(and)\s+(\d+))?/g, (m, w, a, and, b) =>
      w + " " + xref("eq", a, a) + (b ? " " + and + " " + xref("eq", b, b) : ""));
    s = s.replace(/\bTable\s+(\d+)/g, (m, n) => xref("tab", n, m));
    s = s.replace(/\bFigure\s+(\d+)/g, (m, n) => xref("fig", n, m));
    s = s.replace(/\bSection\s+(\d+(?:\.\d+)*)/g, (m, n) => xref("sec", n, m));
    s = s.replace(/\bAppendix\s+([A-Z])\b/g, (m, n) => xref("sec", n, m));
    return s;
  }

  function inline(text, opts) {
    let s = PR.esc(text).replace(/\\\$/g, "$");
    s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    if (opts.cite !== false) s = citeLinks(s);
    if (opts.xref !== false) s = xrefLinks(s);
    return s.replace(/\n/g, "<br>");
  }

  /* 一行/一段文字 -> HTML */
  PR.md = function (text, opts) {
    opts = opts || {};
    text = String(text == null ? "" : text);
    let out = "", last = 0;
    MATH.lastIndex = 0;
    for (let m; (m = MATH.exec(text));) {
      out += inline(text.slice(last, m.index), opts) + PR.tex(m[1].replace(/\\\$/g, "\\$"), false);
      last = m.index + m[0].length;
    }
    return out + inline(text.slice(last), opts);
  };

  /* 多段文字（讨论、笔记正文）：空行分段；单独一行的 $$...$$ 是行间公式 */
  PR.mdBlocks = function (text, opts) {
    return String(text || "").trim().split(/\n\s*\n/).map((p) => {
      const d = p.trim().match(/^\$\$([\s\S]+)\$\$$/);
      if (d) return '<div class="eq">' + PR.tex(d[1], true) + "</div>";
      return "<p>" + PR.md(p, opts) + "</p>";
    }).join("");
  };

  /* 去掉标记的纯文字，给目录、列表摘要用 */
  PR.plain = (text) => String(text || "").replace(MATH, (m, t) => t).replace(/\*\*|`/g, "");
})(window.PR);
