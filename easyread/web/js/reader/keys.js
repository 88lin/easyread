/* 快捷键：每个操作一个键，可以改、可以关。存在 prefs.json（keys），浏览器里留一份缓存。
   选中文字后的 1–4 划线、N 笔记、Q 提问，和 Esc 关闭是固定的。 */
(function (PR) {
  "use strict";
  const ACTIONS = [
    ["next", "下一段", "j", "阅读"], ["prev", "上一段", "k", "阅读"],
    ["mode", "译文 / 对照原文", "b", "阅读"], ["toc", "目录", "t", "阅读"],
    ["fontUp", "字号变大", "=", "阅读"], ["fontDown", "字号变小", "-", "阅读"], ["fontReset", "恢复默认字号", "0", "阅读"],
    ["pages", "原页面板", "o", "面板"], ["notes", "笔记面板", "m", "面板"], ["chat", "问 AI（带当前段）", "a", "面板"],
    ["pagePrev", "原页上一页", "[", "面板"], ["pageNext", "原页下一页", "]", "面板"],
    ["note", "给当前段写笔记", "n", "当前段"], ["question", "给当前段提问", "q", "当前段"],
    ["en", "展开这段英文", "y", "当前段"], ["edit", "改译文", "e", "当前段"], ["redo", "让模型重译这段", "r", "当前段"],
    ["page", "看这段的原页", "p", "当前段"], ["copy", "复制这段译文", "c", "当前段"],
  ];
  const DEF = Object.fromEntries(ACTIONS.map(([id, , k]) => [id, k]));
  PR.keymap = Object.assign({}, DEF, PR.ls.get("easyread-keys", {}));
  PR.keyActions = ACTIONS;

  const show = (k) => (!k ? "" : k === " " ? "空格" : k.length === 1 ? k.toUpperCase() : k);
  PR.keyOf = (id) => show(PR.keymap[id]);
  PR.keyAction = function (k) {
    if (k === "+") k = "=";
    if (k === "_") k = "-";
    return Object.keys(PR.keymap).find((id) => PR.keymap[id] === k) || null;
  };
  PR.setKeymap = function (map) {
    PR.keymap = Object.assign({}, DEF, map);
    const diff = Object.fromEntries(Object.entries(PR.keymap).filter(([id, k]) => DEF[id] !== k));
    PR.ls.set("easyread-keys", diff);
    PR.savePrefs && PR.savePrefs("keys", Object.assign(Object.fromEntries(Object.keys(DEF).map((id) => [id, null])), diff));
  };

  PR.runAction = function (id) {
    const g = {
      mode: () => PR.setPref("mode", PR.prefs.mode === "bi" ? "zh" : "bi"),
      toc: () => PR.toggleDrawer(null, "toc"),
      fontUp: () => PR.bumpFont(1), fontDown: () => PR.bumpFont(-1), fontReset: () => PR.resetType(),
      pages: () => PR.togglePages(), notes: () => PR.toggleNotesPanel(),
      chat: () => { const id2 = (PR.currentBlock && PR.currentBlock()) || PR.readingBlock(); PR.blockById[id2] ? PR.chatAsk({ anchor: id2 }) : PR.toggleChat(); },
      pagePrev: () => PR.pageStep(-1), pageNext: () => PR.pageStep(1),
    }[id];
    if (g) { g(); return true; }
    return PR.blockAction(id);
  };

  /* ---------- 设置界面 ---------- */
  let recording = null;
  PR.openKeys = function () {
    const dlg = PR.$("#readerDlg");
    let h = "<h2>快捷键</h2><p class=\"hint\" style=\"margin:-8px 0 12px\">点右边的键，再按新的键；点“关”停用。选中文字后的 1–4 划线、N、Q 和 Esc 固定不变。</p><div class=\"keys-list\">";
    let grp = "";
    for (const [id, label, , group] of ACTIONS) {
      if (group !== grp) { h += '<div class="grp">' + group + "</div>"; grp = group; }
      const k = PR.keymap[id];
      h += "<span>" + label + '</span><button class="kcap' + (recording === id ? " rec" : k ? "" : " off") + '" data-krec="' + id + '">' + (recording === id ? "按一个键…" : k ? PR.esc(show(k)) : "未设置") + "</button>" +
        '<button class="kx" data-koff="' + id + '">关</button>';
    }
    h += '</div><div class="actions"><button class="btn" data-kreset>恢复默认</button><span class="grow" style="flex:1"></span><button class="btn primary" data-kclose>完成</button></div>';
    dlg.querySelector(".dialog").innerHTML = h;
    dlg.classList.add("open");
  };
  PR.$("#readerDlg").addEventListener("click", (e) => {
    const dlg = PR.$("#readerDlg");
    if (e.target === dlg || e.target.closest("[data-kclose]")) { recording = null; dlg.classList.remove("open"); PR.renderDrawer && document.body.classList.contains("drawer-open") && PR.renderDrawer(); return; }
    const r = e.target.closest("[data-krec]"), off = e.target.closest("[data-koff]");
    if (r) { recording = r.dataset.krec; PR.openKeys(); }
    if (off) { PR.setKeymap(Object.assign({}, PR.keymap, { [off.dataset.koff]: "" })); recording = null; PR.openKeys(); }
    if (e.target.closest("[data-kreset]")) { PR.setKeymap({}); recording = null; PR.openKeys(); }
  });
  document.addEventListener("keydown", (e) => {
    if (!recording) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.key === "Escape") { recording = null; return PR.openKeys(); }
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (/^[1-4]$/.test(k)) { PR.toast("1–4 留给选中文字后的划线"); return; }
    const taken = PR.keyAction(k);
    const map = Object.assign({}, PR.keymap, { [recording]: k });
    if (taken && taken !== recording) { map[taken] = ""; PR.toast("「" + ACTIONS.find((a) => a[0] === taken)[1] + "」原来的键让给了这个操作"); }
    PR.setKeymap(map);
    recording = null;
    PR.openKeys();
  }, true);
})(window.PR);
