/* 阅读位置：记住读到哪儿，下次打开回到那儿。
   - 记的是视口上部那条线穿过的块（和顶栏显示的小节同一处）加上线在块里的位置，
     段落有几屏高时也能落回原来的地方；块已经不在了就退回用全文比例。
   - 滚动中每两秒记一次，离开页面、退出软件前再补记一次，不等人停手。
   - 打开时直接回到上次的位置；刚打开时远处的段落还没排过版，位置是拿占位高度估的，
     所以等字体和图片排好后再对一次（#段落 链接那套办法）。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const EVERY = 2000;  // 滚动中最多两秒记一次
  const SETTLE = 900;  // 版面排好后再对一次位置

  const moved = () => Math.max(0, document.documentElement.scrollHeight - innerHeight);

  /* 现在读到哪儿，写成一条 progress 操作 */
  PR.progressOp = function () {
    const block = PR.readingBlock();
    const el = document.getElementById("b-" + block);
    const box = el ? el.getBoundingClientRect() : null;
    const off = box && box.height > 0 ? (PR.readingLine() - box.top) / box.height : 0;
    const max = moved();
    return {
      op: "progress", block,
      off: Math.round(Math.min(1, Math.max(0, off)) * 100) / 100,
      ratio: max > 0 ? Math.round((scrollY / max) * 100) / 100 : 0,
    };
  };

  function save() {
    if (!watching) return;  // 还没回到上次的位置，不能拿现在的位置把记录盖掉
    const op = PR.progressOp(), was = S.reader.progress || {};
    if (op.block === was.block && Math.abs((was.ratio || 0) - op.ratio) <= 0.02 && Math.abs((was.off || 0) - op.off) <= 0.05) return;
    PR.commit(op);
  }

  let watching = false;
  /* 打开时先把上次的位置还原了，再开始记新的（顺序由 main.js 的启动流程保证） */
  PR.watchProgress = () => { watching = true; };

  PR.saveProgress = PR.throttle(save, EVERY);
  /* 离开页面、退出软件前补记一次，并让待发的操作立刻发出去（keepalive：页面走掉后请求也能发完） */
  PR.flushProgress = function () {
    save();
    return PR.flushPending ? PR.flushPending() : Promise.resolve();
  };
  PR.flushPage = PR.flushProgress;  // 桌面版退出前会来调这个（见 common/util.js）

  /* 记下的位置换算成 scrollTop */
  function target(p) {
    const el = p.block && document.getElementById("b-" + p.block);
    if (el && p.off != null) {
      const box = el.getBoundingClientRect();
      if (box.height > 0) return Math.max(0, Math.round(scrollY + box.top + box.height * p.off - PR.readingLine()));
    }
    return p.ratio != null ? Math.round(moved() * p.ratio) : null;
  }

  /* 上次读到哪儿，给用户看的一句话；back：已经回到那儿了（还是只是问一句要不要去） */
  function lastRead(p, back) {
    let h = null;
    for (const x of S.paper.blocks || []) { if (x.type === "heading") h = x; if (x.id === p.block) break; }
    const b = PR.blockById[p.block];
    if (h) {
      const sec = (h.num ? h.num + " " : "") + PR.plain(PR.textFor(h.id));
      return back ? PR.t("已回到上次读到「{sec}」", { sec }) : PR.t("上次读到「{sec}」", { sec });
    }
    if (b) return back ? PR.t("已回到上次读到第 {page} 页", { page: b.page }) : PR.t("上次读到第 {page} 页", { page: b.page });
    return PR.t("已回到上次读到的地方");
  }

  PR.restoreProgress = function () {
    const p = S.reader.progress || {};
    if (scrollY > 50) return false;  // 浏览器恢复过滚动位置，或者用户已经动了
    const at = target(p);
    if (at == null) return false;
    /* 导出的单文件版没有服务，读到哪儿只存在这个浏览器里：照旧问一句，不替人决定 */
    if (PR.store.mode !== "server") {
      if (!PR.blockById[p.block]) return false;
      PR.toast(lastRead(p, false), { label: PR.t("接着读"), fn: () => window.scrollTo({ top: at, behavior: "smooth" }) }, 8000);
      return true;
    }
    if (at <= 0) return false;  // 上次就停在最上面，不用回，也不用说
    anchor(p, at);
    PR.toast(lastRead(p, true), { label: PR.t("回到顶部"), fn: () => window.scrollTo({ top: 0, behavior: "smooth" }) }, 8000);
    return true;
  };

  /* 先落在记下的位置，等版面排好再对一次；中间用户自己动了手就不打扰 */
  function anchor(p, at) {
    window.scrollTo({ top: at, behavior: "auto" });
    const names = ["wheel", "touchstart", "keydown", "mousedown"];
    let left = false;
    const leave = () => { left = true; };
    names.forEach((n) => window.addEventListener(n, leave, { passive: true }));
    Promise.all([document.fonts ? document.fonts.ready : null, new Promise((r) => setTimeout(r, SETTLE))]).then(() => {
      names.forEach((n) => window.removeEventListener(n, leave));
      if (left) return;
      const again = target(p);
      if (again != null && Math.abs(again - scrollY) > 2) window.scrollTo({ top: again, behavior: "auto" });
    });
  }
})(window.PR);
