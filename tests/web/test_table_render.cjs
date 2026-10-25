const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function render(blocks, options = {}) {
  const paperEl = { innerHTML: "" };
  const bodyClass = new Set();
  const PR = {
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s,
    titleOf: (m) => m.title_en || "",
    state: {
      paper: { meta: { title_en: "Table test", pages: [{ n: 1, img: "pages/page-001.webp" }] }, translation: { done_pages: [1] }, blocks },
      reader: { edits: {} },
      discussion: { entries: [] },
      layout: {},
      item: {},
      job: {},
    },
    $: (sel) => sel === "#paper" ? paperEl : null,
    $$: () => [],
    esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    md: (s) => String(s == null ? "" : s),
    plain: (s) => String(s == null ? "" : s),
    textFor: (key) => {
      const [id, field] = String(key).split("#");
      const b = blocks.find(x => x.id === id) || {};
      return field === "caption" ? (b.caption_zh || b.caption_en || "") : (b.zh || b.en || "");
    },
    agentText: (key) => PR.textFor(key),
    editOf: () => null,
    isEnKey: () => false,
    hasZh: (b) => !!(b && (b.zh || b.caption_zh)),
    blockKeys: (b) => b.type === "table" || b.type === "figure" ? [b.id + "#caption"] : [b.id],
    imageUrl: (rel) => rel,
    canAsk: () => false,
    store: { mode: "file" },
    usageShort: () => "",
    emit() {},
    on() {},
    fitWide() {},
  };
  if (options.pages) PR.state.paper.meta.pages = options.pages;
  if (options.job) PR.state.job = options.job;
  if (options.mode) PR.store.mode = options.mode;
  PR.pageCapHtml = () => "";
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/common/markup.js"), "utf8"), { window: { PR }, URL });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/render.js"), "utf8"), {
    window: { PR },
    document: {
      documentElement: { dataset: {} },
      body: { classList: { toggle() {} } },
      getElementById: () => null,
      createElement: () => ({ innerHTML: "", firstChild: null, classList: { contains: () => false, add() {} }, querySelector: () => null }),
    },
    console,
  });
  PR.renderPaper();
  return paperEl.innerHTML;
}

test("flat table head renders as one header row and does not hide later blocks", () => {
  const html = render([
    { id: "tab1", type: "table", page: 1, head: ["Method", "Score"], rows: [["A", "0.8"]] },
    { id: "p1", type: "para", page: 1, zh: "AFTER_TABLE" },
  ]);
  assert.match(html, /<thead><tr><th[^>]*>Method<\/th><th[^>]*>Score<\/th><\/tr><\/thead>/);
  assert.match(html, /AFTER_TABLE/);
});

test("one malformed block does not blank the rest of the reader", () => {
  const html = render([
    { id: "bad", type: "list", page: 1, items: "not-an-array" },
    { id: "p1", type: "para", page: 1, zh: "AFTER_MALFORMED_BLOCK" },
  ]);
  assert.match(html, /AFTER_MALFORMED_BLOCK/);
  assert.match(html, /bad/);
});

test("failed preparation shows escaped error and a model-free retry instead of a spinner", () => {
  const html = render([], { pages: [], mode: "server", job: { state: "error", error: 'MemoryError <script>bad()</script>' } });
  assert.match(html, /MemoryError &lt;script&gt;/);
  assert.match(html, /data-t="retry-prepare"/);
  assert.doesNotMatch(html, /class="spin"|<script>/);
  // main.js refreshes job-only updates only when this exact wrapper exists.
  assert.match(html, /class="pending-pages"><div class="pending"/);
});

test("only queued or running preparation shows a spinner", () => {
  for (const state of ["queued", "running", "cancelled", "done", ""]) {
    const html = render([], { pages: [], mode: "server", job: { state } });
    assert.equal(html.includes('class="spin"'), ["queued", "running"].includes(state));
    assert.equal(html.includes('data-t="retry-prepare"'), !["queued", "running"].includes(state));
  }
});

test("offline unprepared documents do not offer an unavailable retry API", () => {
  const html = render([], { pages: [], job: { state: "error", error: "MemoryError" } });
  assert.match(html, /MemoryError/);
  assert.doesNotMatch(html, /retry-prepare|class="spin"/);
});

