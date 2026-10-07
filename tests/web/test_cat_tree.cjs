const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const WEB = path.join(__dirname, "..", "..", "easyread", "web", "js");
const tree = () => {
  const window = { PR: {} };
  vm.runInNewContext(fs.readFileSync(path.join(WEB, "library", "cat-tree.js"), "utf8"), { window });
  return window.PR.catTree;
};

test("paths: leaf, parent, depth, under", () => {
  const T = tree();
  assert.equal(T.leaf("ML/Transformer"), "Transformer");
  assert.equal(T.parent("ML/Transformer"), "ML");
  assert.equal(T.parent("ML"), "");
  assert.equal(T.depth("A/B/C"), 2);
  assert.ok(T.under("ML/Transformer", "ML"));
  assert.ok(T.under("ML", "ML"));
  assert.ok(!T.under("MLOps", "ML"), "同前缀的兄弟不算子分类");
  assert.equal(T.label("A/B"), "A › B");
});

test("clean trims each level and drops empty ones", () => {
  const T = tree();
  assert.equal(T.clean(" A / /B "), "A/B");
  assert.equal(T.clean("/A/"), "A");
  assert.equal(T.clean("x".repeat(40)), "x".repeat(30));
});

test("ordered fills in ancestors and keeps children right after their parent", () => {
  const T = tree();
  assert.deepEqual(Array.from(T.ordered(["B", "A/x", "B/y", "A"])), ["B", "B/y", "A", "A/x"]);
  assert.deepEqual(Array.from(T.ordered(["A/B/C"])), ["A", "A/B", "A/B/C"]);
});

test("move renames a whole subtree and leaves look-alike siblings alone", () => {
  const T = tree();
  assert.equal(T.move("A/B", "A", "Z"), "Z/B");
  assert.equal(T.move("AB", "A", "Z"), "AB");
  assert.equal(T.move("A/B/C", "A/B", "X/B"), "X/B/C");
});

test("shift swaps a category with its sibling, children travel along", () => {
  const T = tree();
  const list = ["A", "A/1", "B", "B/1", "C"];
  assert.deepEqual(Array.from(T.shift(list, "B", -1)), ["B", "B/1", "A", "A/1", "C"]);
  assert.deepEqual(Array.from(T.shift(list, "A", 1)), ["B", "B/1", "A", "A/1", "C"]);
  assert.deepEqual(Array.from(T.shift(["P", "P/a", "P/b", "Q"], "P/b", -1)), ["P", "P/b", "P/a", "Q"]);
  assert.deepEqual(Array.from(T.shift(list, "A", -1)), list, "已经在最前面");
});
