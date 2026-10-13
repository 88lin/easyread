const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

/* 版面用 document 坐标下的 top / height 表示，读到哪一块由 readingBlock 决定：
   视口 800 高，记的是 240（30%）那条线。 */
function reader({ mode = "server", progress = {}, scrollY = 0 } = {}) {
  const layout = new Map([["head", { top: 0, height: 200 }]]);
  const timers = [], toasts = [], scrolls = [], on = new Map();
  const sandbox = {
    scrollY, innerHeight: 800,
    document: {
      documentElement: { scrollHeight: 5000 },  // 可滚 4200
      fonts: null,
      getElementById: id => {
        const box = layout.get(id.replace(/^b-/, ""));
        return box ? { getBoundingClientRect: () => ({ top: box.top - sandbox.scrollY, height: box.height }) } : null;
      },
    },
    window: {
      scrollTo: ({ top }) => { scrolls.push(top); sandbox.scrollY = top; },
      addEventListener: (name, fn) => on.set(name, fn),
      removeEventListener: (name, fn) => { if (on.get(name) === fn) on.delete(name); },
    },
    setTimeout: fn => timers.push(fn),
    clearTimeout() {},
  };
  const PR = {
    state: { paper: { blocks: [] }, reader: { progress } },
    t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s),
    plain: s => s, textFor: id => "正文 " + id, readingLine: () => 240,
    throttle: fn => fn,  // 多久记一次由 util.js 的节流管，这里只看记了什么
    readingBlock: () => "head",
    blockById: {}, store: { mode },
    commit: op => { PR.committed.push(op); PR.state.reader.progress = { block: op.block, off: op.off, ratio: op.ratio }; },
    committed: [],
    toast: (text, opts) => toasts.push({ text, label: opts && opts.label }),
    flushPending: () => { PR.flushed = true; },
  };
  sandbox.PR = sandbox.window.PR = PR;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/progress.js"), "utf8"), sandbox);
  return {
    PR, sandbox, toasts, scrolls, on,
    block(id, top, height) { layout.set(id, { top, height }); },
    read(id) { PR.readingBlock = () => id; },
    settle: async () => { timers.splice(0).forEach(fn => fn()); await new Promise(r => setImmediate(r)); },
  };
}

test("progress records the block, the position inside it, and the document ratio", () => {
  const r = reader({ scrollY: 1400 });
  r.block("p2", 1000, 2000);  // 240 那条线落在块顶下 640，块高 2000
  r.read("p2");
  assert.deepEqual({ ...r.PR.progressOp() }, { op: "progress", block: "p2", off: 0.32, ratio: 0.33 });
});

test("nothing is recorded until the saved spot has been restored", async () => {
  const r = reader({ scrollY: 1400, progress: { block: "p2", off: 0.32, ratio: 0.33 } });
  r.block("p2", 1000, 2000);
  r.read("p2");
  await r.PR.flushProgress();
  assert.deepEqual(r.PR.committed, [], "还没回到上次的位置，不能拿现在的位置把记录盖掉");
  r.PR.watchProgress();
  await r.PR.flushProgress();
  assert.deepEqual(r.PR.committed, [], "回到原处没动，也不用写");
  r.sandbox.scrollY = 1600;
  await r.PR.flushProgress();
  assert.equal(r.PR.committed.length, 1, "之后往下读了才记");
});

test("the same spot is not written twice, a real move is", async () => {
  const r = reader({ scrollY: 1400 });
  r.block("p2", 1000, 2000);
  r.read("p2");
  r.PR.watchProgress();
  await r.PR.flushProgress();
  assert.equal(r.PR.committed.length, 1);
  assert.deepEqual({ ...r.PR.committed[0] }, { op: "progress", block: "p2", off: 0.32, ratio: 0.33 });
  assert.equal(r.PR.flushed, true, "退出前要把待发的操作发出去");
  await r.PR.flushProgress();
  assert.equal(r.PR.committed.length, 1, "没动就不重复记");
  r.block("p2", 1020, 2000);  // 挪一点，块内位置差 0.01
  await r.PR.flushProgress();
  assert.equal(r.PR.committed.length, 1);
  r.block("p2", 600, 2000);  // 块往上走一大截，块内位置差 0.2
  await r.PR.flushProgress();
  assert.equal(r.PR.committed.length, 2);
  assert.equal(r.PR.committed[1].off, 0.52);
});

test("opening a paper jumps straight to the saved spot", async () => {
  const r = reader({ progress: { block: "p2", off: 0.32, ratio: 0.33 } });
  r.block("p2", 1000, 2000);
  r.PR.blockById = { p2: { id: "p2", page: 3 } };
  assert.equal(r.PR.restoreProgress(), true);
  assert.deepEqual(r.scrolls, [1400], "块顶 + 块内位置 - 30% 那条线");
  assert.deepEqual(r.toasts, [{ text: "已回到上次读到第 3 页", label: "回到顶部" }]);
});

test("the jump is corrected once the page has laid out", async () => {
  const r = reader({ progress: { block: "p2", off: 0.32, ratio: 0.33 } });
  r.block("p2", 1000, 2000);
  r.PR.restoreProgress();
  r.block("p2", 1600, 2000);  // 上面的段落排过版，比占位高度高
  await r.settle();
  assert.deepEqual(r.scrolls, [1400, 2000], "排好版后再对一次");
});

test("the correction is skipped once the user has scrolled", async () => {
  const r = reader({ progress: { block: "p2", off: 0.32, ratio: 0.33 } });
  r.block("p2", 1000, 2000);
  r.PR.restoreProgress();
  r.block("p2", 1600, 2000);
  r.on.get("wheel")();
  await r.settle();
  assert.deepEqual(r.scrolls, [1400], "用户自己动了就不打扰");
});

test("a paper left at the top is left alone", () => {
  const r = reader({ progress: { block: "head", off: 0, ratio: 0 } });
  assert.equal(r.PR.restoreProgress(), false);
  assert.deepEqual(r.scrolls, []);
  assert.deepEqual(r.toasts, []);
});

test("a block that is gone falls back to the document ratio", () => {
  const r = reader({ progress: { block: "p9", off: 0.5, ratio: 0.5 } });
  assert.equal(r.PR.restoreProgress(), true);
  assert.deepEqual(r.scrolls, [2100]);
  assert.equal(r.toasts[0].label, "回到顶部");
});

test("the offline single-file build still asks before moving", () => {
  const r = reader({ mode: "static", progress: { block: "p2", off: 0.32, ratio: 0.33 } });
  r.block("p2", 1000, 2000);
  r.PR.blockById = { p2: { id: "p2", page: 3 } };
  assert.equal(r.PR.restoreProgress(), true);
  assert.deepEqual(r.scrolls, [], "导出的单文件版不替人决定");
  assert.deepEqual(r.toasts, [{ text: "上次读到第 3 页", label: "接着读" }]);
});
