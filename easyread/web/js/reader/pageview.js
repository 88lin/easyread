/* 右侧面板：原文页（随阅读位置翻页、框出当前段）。和笔记面板共用右侧，一次开一个。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const body = document.body;
  let pvPage = 1, pvBlock = null;
  let syncRaf = 0, showSerial = 0;
  let panelDriveUntil = 0, panelProgrammaticUntil = 0, pageStepAt = 0;
  let panelLastTop = 0;
  const pages = () => (S.paper.meta || {}).pages || [];
  const scroller = () => PR.$(".pv-scroll");
  const followOn = () => { const input = PR.$(".pv-follow input"); return !!input && input.checked; };
  const layoutOf = (id) => {
    const loc = id && S.layout[id];
    return loc && Array.isArray(loc.box) && loc.box.length === 4 ? loc : null;
  };
  const blocksOnPage = (page) => (S.paper.blocks || []).filter((b) => +b.page === page && layoutOf(b.id));
  const edgeBlock = (page, last) => {
    const list = blocksOnPage(page);
    return list.length ? list[last ? list.length - 1 : 0].id : null;
  };

  /* 由右侧原页驱动左侧正文时，主滚动监听要暂时让出控制权，避免来回抢滚动位置。 */
  PR.panelDriven = () => performance.now() < panelDriveUntil;

  /* 右侧面板开关：pages | notes | null */
  /* 面板先滑出来（只动面板，不卡），滑完再让正文让位、重排一次。
     长论文有几万个节点，正文宽度一变就要整页重排（两三百毫秒），放在点击的当下会让人觉得按钮反应慢。 */
  PR.side = null;
  let sideT = null;
  PR.openSide = function (name) {
    PR.side = name;
    body.classList.toggle("pv-open", name === "pages");
    body.classList.toggle("np-open", name === "notes");
    body.classList.toggle("ch-open", name === "chat");
    PR.$('[data-act="chat"]').classList.toggle("on", name === "chat");
    PR.$('[data-act="pages"]').classList.toggle("on", name === "pages");
    PR.$('[data-act="notes"]').classList.toggle("on", name === "notes");
    clearTimeout(sideT);
    if (name) { const t = PR.$("#toast"); if (t) t.classList.remove("open"); }  // 提示条别挡住面板底部的输入框
    if (body.classList.contains("side-open") === !!name) return;  // 面板之间切换：正文宽度不变
    sideT = setTimeout(() => requestAnimationFrame(() => {
      const anchor = PR.readingBlock && PR.readingBlock();
      const node = anchor && document.getElementById("b-" + anchor);
      const before = node ? node.getBoundingClientRect().top : 0;
      body.classList.toggle("side-open", !!PR.side);
      PR.fitWide(); PR.renderMargin();
      if (node) window.scrollBy(0, node.getBoundingClientRect().top - before);  // 重排后还停在刚才读的地方
    }), 300);
  };

  PR.togglePages = function (force) {
    const open = force != null ? force : PR.side !== "pages";
    PR.openSide(open ? "pages" : null);
    if (open) PR.syncPage(true); else pair(null);
  };
  PR.openPage = function (page, blockId) {
    pvBlock = blockId || null;
    if (PR.side !== "pages") PR.openSide("pages");
    showPage(page, blockId);
  };

  /* 原图是 2.4 倍渲染（约 1500 像素宽、几百 KB），面板用不了那么大：要一张和面板一样宽的，服务端生成一次后缓存 */
  function srcOf(n) {
    const p = pages()[n - 1];
    if (!p) return "";
    const base = PR.imageUrl(p.img);
    if (PR.store.mode !== "server") return base;
    const need = (PR.$(".pv-scroll").clientWidth || 480) * (body.classList.contains("pv-zoom") ? 1.65 : 1) * (devicePixelRatio || 1);
    return need <= 1000 ? base + "?w=1000" : need <= 1600 ? base + "?w=1600" : base;  // 1000 宽的服务端已提前生成好
  }
  const preloaded = new Set();
  function preload(n) {
    const s = srcOf(n);
    if (s && !preloaded.has(s)) { preloaded.add(s); const im = new Image(); im.decoding = "async"; im.src = s; }
  }
  PR.preloadPage = () => { const b = PR.blockById[PR.readingBlock()]; if (b && b.page) preload(b.page); };

  function showPage(page, blockId, options) {
    const list = pages();
    if (!list.length) return;
    const opts = Object.assign({ center: true, smooth: true }, options || {});
    const oldPage = pvPage;
    pvPage = Math.min(list.length, Math.max(1, page));
    const serial = ++showSerial;
    const img = PR.$(".pv-page img");
    img.decoding = "async";
    const src = srcOf(pvPage);
    if (img.getAttribute("src") !== src) { img.setAttribute("src", src); PR.$(".pv-page").classList.add("loading"); img.onload = () => PR.$(".pv-page").classList.remove("loading"); }
    preload(pvPage + 1); preload(pvPage - 1);
    PR.$(".pv-label").textContent = "第 " + pvPage + " / " + list.length + " 页";
    const pdf = PR.$('[data-pv="pdf"]');
    const url = PR.pdfUrl(pvPage);
    pdf.style.display = url ? "" : "none";
    if (url) pdf.href = url;
    const hl = PR.$(".pv-hl");
    const loc = layoutOf(blockId);
    const pageLoc = loc && loc.page === pvPage ? loc : null;
    pair(pageLoc ? blockId : null);
    const scrollPanel = (top, smooth) => {
      const box = scroller();
      if (!box) return;
      panelProgrammaticUntil = performance.now() + (smooth ? 700 : 300);
      box.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
      panelLastTop = box.scrollTop;
    };
    const applyScroll = () => {
      if (serial !== showSerial) return;
      const box = scroller();
      if (!box) return;
      if (opts.edge) {
        scrollPanel(opts.edge === "end" ? box.scrollHeight : 0, opts.smooth);
      } else if (opts.center !== false && pageLoc) {
        const h = PR.$(".pv-page").offsetHeight;
        scrollPanel(Math.max(0, ((pageLoc.box[1] + pageLoc.box[3]) / 2) * h + 18 - box.clientHeight / 2), opts.smooth);
      } else if (oldPage !== pvPage && opts.center !== false) {
        scrollPanel(opts.direction === "prev" ? box.scrollHeight : 0, opts.smooth);
      }
    };
    if (pageLoc) {
      const [x0, y0, x1, y1] = pageLoc.box;
      Object.assign(hl.style, { left: (x0 * 100 - 0.8) + "%", top: (y0 * 100 - 0.4) + "%", width: ((x1 - x0) * 100 + 1.6) + "%", height: ((y1 - y0) * 100 + 0.8) + "%" });
      hl.classList.add("on");
      img.complete ? applyScroll() : img.addEventListener("load", applyScroll, { once: true });
    } else {
      hl.classList.remove("on");
      if (img.complete) applyScroll(); else img.addEventListener("load", applyScroll, { once: true });
    }
  }

  /* 译文里和原页框对应的那段也标出来（同一个颜色），一眼看出左右是哪两段 */
  let paired = null, holdUntil = 0;
  function pair(id) {
    if (paired === id) return;
    const old = paired && document.getElementById("b-" + paired);
    if (old) old.classList.remove("pv-pair");
    paired = id;
    const node = id && document.getElementById("b-" + id);
    if (node) node.classList.add("pv-pair");
  }
  PR.on("block-rendered", (id) => { if (id === paired) { paired = null; pair(id); } });  // 段落重画后补回标记
  PR.on("rendered", () => { const id = paired; paired = null; pair(id); });

  /* 点原页上的某一段 → 正文跳到那段译文（排版特殊、看不出语序时，从原文找回去） */
  function blockAt(x, y) {
    let best = null, area = Infinity;
    for (const id in S.layout) {
      const l = S.layout[id];
      if (l.page !== pvPage || !PR.blockById[id]) continue;
      const [x0, y0, x1, y1] = l.box;
      const a = (x1 - x0) * (y1 - y0);
      if (x >= x0 - 0.01 && x <= x1 + 0.01 && y >= y0 - 0.006 && y <= y1 + 0.006 && a < area) { best = id; area = a; }
    }
    return best;
  }
  PR.$(".pv-page").addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const id = blockAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    if (!id) return;
    pvBlock = id;
    holdUntil = Date.now() + 1500;  // 跳过去的滚动会触发“跟随阅读位置”，别让它把刚点的段换掉
    showPage(pvPage, id);
    PR.jumpTo("b-" + id);
  });
  PR.$(".pv-page").addEventListener("mousemove", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.classList.toggle("pickable", !!blockAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height));
  });

  PR.syncPage = function (force) {
    if (PR.side !== "pages") return;
    if (!force && (!PR.$(".pv-follow input").checked || Date.now() < holdUntil)) return;
    const id = (PR.currentBlock && PR.currentBlock()) || PR.readingBlock();
    const b = PR.blockById[id];
    if (!b) return;
    if (!force && id === pvBlock) return;
    pvBlock = id;
    const loc = layoutOf(id);
    showPage(loc ? loc.page : b.page, id, { center: true, smooth: false });
  };

  function blockAtPanelViewport() {
    const box = scroller(), page = PR.$(".pv-page");
    if (!box || !page || !page.offsetHeight) return null;
    const sr = box.getBoundingClientRect(), pr = page.getBoundingClientRect();
    const top = Math.max(sr.top, pr.top), bottom = Math.min(sr.bottom, pr.bottom);
    if (bottom <= top) return null;
    const y = Math.max(0, Math.min(1, ((top + bottom) / 2 - pr.top) / pr.height));
    let best = null, score = Infinity;
    for (const b of blocksOnPage(pvPage)) {
      const loc = layoutOf(b.id), center = (loc.box[1] + loc.box[3]) / 2;
      const distance = Math.abs(center - y);
      const candidate = y >= loc.box[1] && y <= loc.box[3] ? distance * .2 : distance + .05;
      if (candidate < score) { score = candidate; best = b.id; }
    }
    return best;
  }

  function driveLeft(id) {
    const el = document.getElementById("b-" + id);
    if (!el) return;
    panelDriveUntil = performance.now() + 450;
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const top = Math.max(0, Math.min(max, scrollY + el.getBoundingClientRect().top - innerHeight * .3));
    window.scrollTo({ top, behavior: "auto" });
  }

  function stepPage(delta) {
    const now = performance.now(), box = scroller();
    if (!box || now - pageStepAt < 350) return false;
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    const atEnd = delta > 0 && box.scrollTop >= max - 3;
    const atStart = delta < 0 && box.scrollTop <= 3;
    if ((!atEnd && !atStart) || (max === 0 && delta === 0)) return false;
    const page = atEnd ? pvPage + 1 : pvPage - 1;
    if (page < 1 || page > pages().length) return false;
    pageStepAt = now;
    const id = edgeBlock(page, !atEnd);
    pvBlock = id;
    showPage(page, id, { center: false, edge: atEnd ? "start" : "end", smooth: false, direction: atEnd ? "next" : "prev" });
    if (id) driveLeft(id);
    return true;
  }

  function syncFromPanel() {
    if (PR.side !== "pages" || !followOn()) return;
    if (Date.now() < holdUntil) return;
    const box = scroller();
    if (!box) return;
    const now = performance.now(), top = box.scrollTop, delta = top - panelLastTop;
    panelLastTop = top;
    if (now < panelProgrammaticUntil) return;
    if (stepPage(delta)) return;
    const id = blockAtPanelViewport();
    if (!id || id === pvBlock) return;
    pvBlock = id;
    showPage(pvPage, id, { center: false, smooth: false });
    driveLeft(id);
  }

  function schedulePanelSync() {
    if (syncRaf) return;
    syncRaf = requestAnimationFrame(() => { syncRaf = 0; syncFromPanel(); });
  }

  PR.$("#pageview").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pv]");
    if (!b) return;
    const act = b.dataset.pv;
    if (act === "close") { PR.togglePages(false); pair(null); }
    if (act === "prev") showPage(pvPage - 1, pvBlock, { direction: "prev" });
    if (act === "next") showPage(pvPage + 1, pvBlock, { direction: "next" });
    if (act === "zoom") { body.classList.toggle("pv-zoom"); b.textContent = body.classList.contains("pv-zoom") ? "适宽" : "放大"; showPage(pvPage, pvBlock); }
  });
  const panelScroller = scroller();
  panelScroller.addEventListener("scroll", schedulePanelSync, { passive: true });
  panelScroller.addEventListener("wheel", (e) => {
    if (PR.side !== "pages" || !followOn() || !e.deltaY) return;
    const box = scroller(), max = Math.max(0, box.scrollHeight - box.clientHeight);
    const atEnd = e.deltaY > 0 && box.scrollTop >= max - 3;
    const atStart = e.deltaY < 0 && box.scrollTop <= 3;
    if (!atEnd && !atStart) return;
    if (stepPage(e.deltaY > 0 ? 1 : -1)) e.preventDefault();
  }, { passive: false });
  PR.$(".pv-follow input").addEventListener("change", () => {
    panelLastTop = panelScroller.scrollTop;
    if (followOn()) PR.syncPage(true);
  });
  PR.pageStep = (d) => showPage(pvPage + d, pvBlock);
})(window.PR);
