/* 设置 → 文献库：管理左侧栏的分类。内置分类可以显示 / 隐藏，自建分类可以新建、改名、排序、删除。
   这里的改动立刻生效（和在侧栏右键操作一样），不用等“保存”。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  const BUILTIN = [["reading", "在读"], ["unread", "未读"], ["done", "已读"], ["starred", "星标"]];

  PR.settingsTabs.library = {
    render(s) {
      const cats = L.cats();
      const pinned = (k) => (L.side.pinned.includes(k) ? '<span class="cm-def">已置顶</span>' : "");
      let h = '<p class="set-lead">左侧栏的分类。一篇论文可以放进好几个分类：在论文上右键，或者把它拖到侧栏的分类上。改动立刻生效。</p>' +
        '<h4 class="set-h">内置分类</h4><div class="switch-list">' +
        '<label class="switch-row"><span><b>全部</b><small>始终显示</small></span><input type="checkbox" class="switch" checked disabled></label>' +
        BUILTIN.map(([k, name]) => '<label class="switch-row"><span><b>' + name + pinned("v:" + k) + "</b></span>" +
          '<input type="checkbox" class="switch" data-libshow="' + k + '"' + (L.side.hidden.includes(k) ? "" : " checked") + "></label>").join("") + "</div>" +
        '<h4 class="set-h">我的分类</h4><div class="cm-list">';
      h += cats.map((c, i) => {
        const n = L.items.filter((x) => (x.tags || []).includes(c)).length;
        if (s.libRename === c) return '<div class="cm-row"><input class="input" id="libRenameInput" value="' + PR.esc(c) + '" maxlength="30"><button class="btn sm accent" data-lib="rename-ok" data-c="' + PR.esc(c) + '">好</button><button class="btn sm" data-lib="cancel">取消</button></div>';
        return '<div class="cm-row"><div class="cm-main"><b>' + PR.esc(c) + "</b>" + pinned("c:" + c) + '<div class="cm-sub">' + n + " 篇</div></div>" +
          '<button class="btn sm" data-lib="up" data-c="' + PR.esc(c) + '"' + (i ? "" : " disabled") + ' title="上移">↑</button>' +
          '<button class="btn sm" data-lib="pin" data-c="' + PR.esc(c) + '">' + (L.side.pinned.includes("c:" + c) ? "取消置顶" : "置顶") + "</button>" +
          '<button class="btn sm" data-lib="rename" data-c="' + PR.esc(c) + '">改名</button>' +
          '<button class="btn sm danger" data-lib="del" data-c="' + PR.esc(c) + '">删</button></div>';
      }).join("") || '<p class="hint">还没有自建分类。</p>';
      return h + '</div><div class="cm-form-acts" style="margin-top:4px"><input class="input" id="libNewInput" placeholder="新分类的名字" maxlength="30" style="max-width:240px"><button class="btn sm line" data-lib="add">' + PR.icon("plus", "sm") + "新建分类</button></div>";
    },
    click(e, s) {
      const b = e.target.closest("[data-lib]");
      if (!b) return false;
      const c = b.dataset.c, act = b.dataset.lib;
      if (act === "add") { L.addCat(PR.$("#libNewInput").value); }
      if (act === "up") L.moveCat(c, -1);
      if (act === "pin") L.togglePin("c:" + c);
      if (act === "rename") s.libRename = c;
      if (act === "cancel") s.libRename = null;
      if (act === "rename-ok") { L.renameCat(c, PR.$("#libRenameInput").value); s.libRename = null; }
      if (act === "del") L.deleteCat(c);
      return true;
    },
    change(e) {
      if (e.target.dataset.libshow) L.setHidden(e.target.dataset.libshow, !e.target.checked);
      return false;
    },
  };
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.target.id === "libNewInput") { e.preventDefault(); PR.$('[data-lib="add"]').click(); }
    if (e.target.id === "libRenameInput") { e.preventDefault(); PR.$('[data-lib="rename-ok"]').click(); }
  }, true);
})(window.PR);
