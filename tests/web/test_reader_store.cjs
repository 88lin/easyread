const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

async function offlineReader() {
  const storage = new Map();
  const PR = {
    t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s),
    uid: () => "client", nowIso: () => "2026-10-01T00:00:00Z", emit() {},
    ls: { get: (key, fallback) => storage.get(key) || fallback, set: (key, value) => { storage.set(key, value); return true; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/store.js"), "utf8"), {
    window: { PR, addEventListener() {} }, location: { pathname: "" },
    document: { getElementById: () => ({ textContent: JSON.stringify({ paper: { meta: { source_sha256: "paper0001" } }, reader: {} }) }) },
    setTimeout() {}, clearTimeout() {},
  });
  await PR.load();
  return PR;
}

test("progress keeps the block, the position inside it and the ratio", async () => {
  const PR = await offlineReader();
  PR.commit({ op: "progress", block: "p2", off: 0.32, ratio: 0.43 });
  assert.equal(PR.state.reader.progress.block, "p2");
  assert.equal(PR.state.reader.progress.off, 0.32);
  assert.equal(PR.state.reader.progress.ratio, 0.43);
  PR.commit({ op: "progress", block: "p9", off: 0.1, ratio: 0.8 });  // 后到的位置说了算
  assert.equal(PR.state.reader.progress.block, "p9");
  assert.equal(PR.state.reader.progress.off, 0.1);
});

test("offline deletes survive delayed note creation and export/import", async () => {
  const note = { op: "note", note: { id: "n1", body: "old", updated: "2026-10-01T00:01:00Z" } };
  const remove = { op: "note_del", id: "n1", at: "2026-10-01T00:02:00Z" };
  for (const ops of [[note, remove], [remove, note]]) {
    const PR = await offlineReader();
    ops.forEach(op => PR.commit(op));
    assert.equal(PR.state.reader.notes.n1.deleted, true);
    assert.equal(PR.exportOps().ops.find(op => op.op === "note").note.deleted, true);
    PR.commit({ ...note, note: { ...note.note, updated: "2026-10-01T00:03:00Z" } });
    assert.ok(!PR.state.reader.notes.n1.deleted);
  }
});
