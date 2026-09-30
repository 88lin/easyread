/* 右侧“问 AI”面板：边读边和模型实时对话，回答逐字流出来。
   - 多个对话：顶部点标题展开对话列表，可以新建、切换、改名、删除（存在论文目录的 chat.json）。
   - 模型：输入框左下角切换，名单在“设置 → 问 AI”里配（默认 Claude Opus 5.5 / Sonnet 5.5 / GPT）。
   - 上下文：自动带上你正在读的段落（或选中的那句话），以及你的全部划线、笔记、问题（按颜色分组）。
   - 页边笔记里的问题也从这里回答，答案同时写成那条笔记的回复。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const panel = () => PR.$("#chatpanel");
  const st = { loaded: false, threads: [], cur: null, models: [], def: "", model: "", listOpen: false, menuOpen: false, ctx: null, streaming: null, draft: "" };

  PR.canChat = () => PR.store.mode === "server";
  PR.chatOpen = () => PR.side === "chat";
  PR.toggleChat = function (force) {
    const open = force != null ? force : PR.side !== "chat";
    PR.openSide(open ? "chat" : null);
    if (open) { if (!st.ctx || st.ctx.auto) autoContext(); load().then(() => { render(); focusInput(); }); render(); }
  };
  const focusInput = () => setTimeout(() => { const t = PR.$("#chatInput"); t && t.focus(); }, 300);

  function autoContext() {
    const id = (PR.currentBlock && PR.currentBlock()) || PR.readingBlock();
    st.ctx = PR.blockById[id] ? { anchor: id, quote: "", auto: true } : null;
  }

  /* 外部入口：段落操作条、选中文字、笔记卡片 */
  PR.chatAsk = function (opts) {
    st.ctx = { anchor: opts.anchor, quote: opts.quote || "", auto: false };
    if (PR.side !== "chat") PR.openSide("chat");
    load().then(() => {
      render();
      if (opts.text) send(opts.text, opts.note);
      else { st.draft = opts.draft || ""; render(); focusInput(); }
    });
  };

  async function load(force) {
    if (st.loaded && !force) return;
    try {
      const d = await PR.api("/api/p/" + PR.pid + "/chat");
      st.threads = d.threads || []; st.models = d.models || []; st.def = d.default;
      if (!st.model || !st.models.some((m) => m.id === st.model)) st.model = st.def;
      if (st.cur && !st.threads.some((t) => t.id === st.cur)) st.cur = null;
      st.loaded = true;
    } catch (e) { PR.toast("读不到对话记录：" + PR.esc(e.message)); }
  }
  PR.on("settings-saved", () => { if (st.loaded) load(true).then(render); });

  const thread = () => st.threads.find((t) => t.id === st.cur) || null;
  const modelOf = (id) => st.models.find((m) => m.id === id) || st.models[0] || { label: "模型" };

  function plainTex(t) {
    return (t || "").replace(/\$\$?([^$]*)\$\$?/g, (m, x) => x.replace(/\\([a-zA-Z]+)\s*/g, (y, name) => ({ mu: "μ", sigma: "σ", epsilon: "ε", alpha: "α", beta: "β" })[name] || "").replace(/[{}\\^_]/g, ""));
  }
  function ctxLabel(c) {
    if (!c || !PR.blockById[c.anchor]) return "";
    const b = PR.blockById[c.anchor];
    const text = plainTex(c.quote || PR.plain(PR.textFor(PR.blockKeys(b)[0] || b.id) || b.caption_zh || b.tex || ""));
    const sec = PR.sectionOf ? PR.sectionOf(c.anchor) : "";
    return (sec ? sec + " · " : "") + "「" + text.slice(0, 36) + (text.length > 36 ? "…" : "") + "」";
  }
  function markCounts() {
    const out = {};
    PR.myNotes().forEach((n) => { if (n.quote) out[n.color || "yellow"] = (out[n.color || "yellow"] || 0) + 1; });
    return out;
  }
  const colorName = (c) => (PR.HL_COLORS.find(([k]) => k === c) || [c, c])[1];
  const when = (iso) => (iso ? PR.shortTime(iso) : "");

  /* ---------- 画面 ---------- */
  function headHtml() {
    const t = thread();
    return '<div class="ch-head"><button class="ch-title" data-c="list" title="全部对话">' + PR.icon("menu", "sm") + "<span>" + PR.esc(t ? t.title : "新对话") + "</span>" + PR.icon("chevron", "sm") + "</button>" +
      '<span class="grow"></span><button class="btn icon" data-c="new" title="新对话">' + PR.icon("plus", "sm") + '</button><button class="btn icon" data-c="close" title="关闭">×</button></div>' +
      (st.listOpen ? listHtml() : "");
  }
  function listHtml() {
    const rows = st.threads.map((t) => '<div class="ch-thread' + (t.id === st.cur ? " on" : "") + '" data-t="' + PR.esc(t.id) + '"><div class="tt">' + PR.esc(t.title) + "</div>" +
      '<div class="tm">' + Math.round((t.messages || []).length / 2) + " 问 · " + PR.esc(when(t.updated)) + "</div>" +
      '<button class="tx" data-c="rename" title="改名">' + PR.icon("edit", "sm") + '</button><button class="tx" data-c="del" title="删除">' + PR.icon("trash", "sm") + "</button></div>").join("");
    return '<div class="ch-list"><button class="ch-thread newt" data-c="new">' + PR.icon("plus", "sm") + "新对话</button>" + (rows || '<div class="hint" style="padding:10px 12px">还没有对话。</div>') + "</div>";
  }
  function msgHtml(m) {
    if (m.role === "user") {
      return '<div class="cm user"><div class="bubble">' + PR.esc(m.content).replace(/\n/g, "<br>") + "</div>" +
        (m.anchor && PR.blockById[m.anchor] ? '<button class="cm-ctx" data-c="go" data-anchor="' + PR.esc(m.anchor) + '">' + PR.icon("link", "sm") + PR.esc(ctxLabel(m)) + "</button>" : "") + "</div>";
    }
    const live = st.streaming && st.streaming.msg === m;
    return '<div class="cm ai' + (m.error ? " err" : "") + '" data-id="' + PR.esc(m.id || "") + '"><div class="who"><span class="av">' + PR.icon("sparkle", "sm") + "</span>" + PR.esc(m.model || "AI") + (live ? ' <span class="spin"></span>' : "") + "</div>" +
      '<div class="body">' + (m.error ? PR.esc(m.error) : m.content ? PR.mdBlocks(m.content) : '<p class="thinking"><i></i><i></i><i></i></p>') + "</div>" +
      (!live && !m.error && m.id ? '<div class="acts"><button data-c="copy">' + PR.icon("copy", "sm") + '复制</button><button data-c="pin" title="作为 AI 讨论放到这段旁边">' + PR.icon("note", "sm") + "放到页边</button></div>" : "") + "</div>";
  }
  function emptyHtml() {
    const counts = markCounts();
    const colors = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const sug = ["这段在说什么？用大白话讲一遍", "这个公式每一项是什么意思？怎么推出来的？", "这里的结论靠得住吗？有什么前提？"];
    if (colors.length) sug.unshift("我标" + colorName(colors[0]) + "的那些地方，彼此有什么联系？", "把我划过线的内容串成一条主线讲讲");
    return '<div class="ch-empty">' + PR.logo("hero") + "<b>边读边问</b><p>问题会带上你正在读的段落" + (colors.length ? "，以及你的 " + Object.values(counts).reduce((a, b) => a + b, 0) + " 处划线（" + colors.map((c) => colorName(c) + " " + counts[c]).join("、") + "）" : "和你的全部标记") + "。</p>" +
      '<div class="chips">' + sug.map((q) => '<button data-c="suggest">' + PR.esc(q) + "</button>").join("") + "</div></div>";
  }
  function composerHtml() {
    const counts = markCounts(), n = Object.values(counts).reduce((a, b) => a + b, 0);
    const m = modelOf(st.model);
    const chips = (st.ctx && st.ctx.anchor ? '<span class="chip-ctx" title="' + PR.esc(ctxLabel(st.ctx)) + '">' + PR.icon("link", "sm") + "<span>" + (st.ctx.quote ? "这句：" : "") + PR.esc(ctxLabel(st.ctx)) + '</span><button data-c="noctx" title="不带这段">×</button></span>' : "") +
      (n ? '<span class="chip-marks" title="你的全部划线、笔记、问题都会带上，按颜色分组">' + PR.HL_COLORS.filter(([c]) => counts[c]).map(([c]) => '<i class="dot-' + c + '"></i>').join("") + n + " 处标记</span>" : "");
    const menu = st.menuOpen ? '<div class="ch-menu">' + st.models.map((x) => '<button data-c="model" data-m="' + PR.esc(x.id) + '" class="' + (x.id === st.model ? "on" : "") + '"' + (x.ready === false ? ' disabled title="' + PR.esc(x.hint) + '"' : "") + ">" +
      "<b>" + PR.esc(x.label) + "</b><small>" + PR.esc(x.ready === false ? x.hint : [x.source, x.id === st.def ? "默认" : ""].filter(Boolean).join(" · ")) + "</small></button>").join("") +
      '<hr><button data-c="manage">' + PR.icon("gear", "sm") + "管理模型…</button></div>" : "";
    return '<div class="ch-compose">' + (chips ? '<div class="ch-chips">' + chips + "</div>" : "") +
      '<textarea id="chatInput" rows="1" placeholder="问点什么…（Enter 发送，Shift+Enter 换行）">' + PR.esc(st.draft) + "</textarea>" +
      '<div class="ch-bar"><button class="ch-model" data-c="menu" title="换模型">' + PR.esc(m.label) + PR.icon("chevron", "sm") + "</button>" + menu +
      '<span class="grow"></span>' + (st.streaming ? '<button class="ch-send stop" data-c="stop" title="停止">' + PR.icon("stop", "sm") + "</button>"
        : '<button class="ch-send" data-c="send" title="发送（Enter）">' + PR.icon("arrowUp", "sm") + "</button>") + "</div></div>";
  }
  function render() {
    const el = panel();
    if (!el) return;
    const ta = PR.$("#chatInput");
    if (ta) st.draft = ta.value;
    const t = thread();
    const msgs = t ? t.messages || [] : [];
    el.innerHTML = headHtml() + '<div class="ch-scroll" id="chatList">' + (msgs.length ? msgs.map(msgHtml).join("") : st.loaded ? emptyHtml() : '<p class="hint" style="padding:20px">加载中…</p>') + "</div>" + composerHtml();
    const box = PR.$("#chatList");
    box.scrollTop = box.scrollHeight;
    const input = PR.$("#chatInput");
    if (input) PR.autosize(input);
  }
  function renderLive() {
    const node = st.streaming && PR.$("#chatList .cm.ai:last-child .body");
    if (!node) return;
    node.innerHTML = st.streaming.msg.content ? PR.mdBlocks(st.streaming.msg.content) : '<p class="thinking"><i></i><i></i><i></i></p>';
    const box = PR.$("#chatList");
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
  }
  const renderLiveSoon = PR.throttle(renderLive, 60);

  /* ---------- 发送 ---------- */
  async function send(text, noteId) {
    text = (text || "").trim();
    if (!text || st.streaming) return;
    const c = st.ctx && st.ctx.anchor ? st.ctx : null;
    let t = thread();
    if (!t) { t = { id: null, title: text.slice(0, 22), messages: [], updated: PR.nowIso() }; st.threads.unshift(t); }
    const user = { role: "user", content: text, anchor: c ? c.anchor : null, quote: c ? c.quote : "", note: noteId || null };
    const msg = { role: "assistant", content: "", model: modelOf(st.model).label };
    t.messages.push(user, msg);
    const ctrl = new AbortController();
    st.streaming = { ctrl, msg };
    st.draft = ""; st.listOpen = false; st.menuOpen = false;
    if (PR.$("#chatInput")) PR.$("#chatInput").value = "";
    if (noteId) { PR.asking.add(noteId); PR.renderMargin(); }
    render();
    try {
      const res = await fetch("/api/p/" + PR.pid + "/chat", {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ thread: t.id, text, anchor: user.anchor, quote: user.quote, note: noteId || null, model: st.model }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.thread && !t.id) { t.id = ev.thread; st.cur = ev.thread; }
          if (ev.model) msg.model = ev.model;
          if (ev.t) { msg.content += ev.t; renderLiveSoon(); }
          if (ev.done) msg.id = ev.id;
          if (ev.error) msg.error = ev.error;
        }
      }
    } catch (e) {
      if (e.name === "AbortError") msg.content += "\n\n（已停止）";
      else msg.error = "没能回答：" + e.message;
    }
    st.streaming = null;
    t.updated = PR.nowIso();
    if (noteId) { PR.asking.delete(noteId); setTimeout(() => PR.poll && PR.poll(), 300); }
    if (st.ctx && st.ctx.anchor) st.ctx = { anchor: st.ctx.anchor, quote: "", auto: true };  // 问完之后跟着阅读位置走
    render();
  }

  /* ---------- 事件 ---------- */
  document.addEventListener("click", async (e) => {
    if (!e.target.closest("#chatpanel")) return;
    const b = e.target.closest("[data-c]");
    if (!b) { if (st.menuOpen && !e.target.closest(".ch-menu")) { st.menuOpen = false; render(); } return; }
    const c = b.dataset.c;
    const row = b.closest(".ch-thread[data-t]");
    if (c === "close") return PR.toggleChat(false);
    if (c === "list") { st.listOpen = !st.listOpen; st.menuOpen = false; return render(); }
    if (c === "new") { if (st.streaming) return; st.cur = null; st.listOpen = false; st.model = st.def; autoContext(); render(); return focusInput(); }
    if (c === "menu") { st.menuOpen = !st.menuOpen; st.listOpen = false; return render(); }
    if (c === "model") { st.model = b.dataset.m; st.menuOpen = false; return render(); }
    if (c === "manage") { st.menuOpen = false; render(); return PR.openSettings("chat"); }
    if (c === "send") return send(PR.$("#chatInput").value);
    if (c === "stop" && st.streaming) return st.streaming.ctrl.abort();
    if (c === "suggest") return send(b.textContent);
    if (c === "noctx") { st.ctx = { anchor: null, quote: "", auto: false }; return render(); }
    if (c === "go") return PR.jumpTo("b-" + b.dataset.anchor);
    if (c === "rename" && row) {
      const t = st.threads.find((x) => x.id === row.dataset.t);
      const title = prompt("对话改名", t.title);
      if (title && title.trim()) { t.title = title.trim(); await PR.api("/api/p/" + PR.pid + "/chat/rename", { method: "POST", body: { thread: t.id, title: t.title } }); render(); }
      return;
    }
    if (c === "del" && row) {
      const t = st.threads.find((x) => x.id === row.dataset.t);
      if (!confirm("删除对话「" + t.title + "」？（已经放到页边的讨论不受影响）")) return;
      await PR.api("/api/p/" + PR.pid + "/chat/delete", { method: "POST", body: { thread: t.id } });
      st.threads = st.threads.filter((x) => x !== t);
      if (st.cur === t.id) st.cur = null;
      return render();
    }
    const card = b.closest(".cm.ai");
    const m = card && thread() && thread().messages.find((x) => x.id === card.dataset.id);
    if (c === "copy" && m) navigator.clipboard.writeText(m.content).then(() => PR.toast("已复制"));
    if (c === "pin" && m) {
      try {
        await PR.api("/api/p/" + PR.pid + "/chat/pin", { method: "POST", body: { thread: st.cur, id: m.id } });
        PR.toast("已放到页边"); setTimeout(() => PR.poll && PR.poll(), 200);
      } catch (err) { PR.toast("没放成：" + PR.esc(err.message)); }
    }
  });
  document.addEventListener("click", (e) => {  // 点对话列表里的一行：切过去
    const row = e.target.closest("#chatpanel .ch-thread[data-t]");
    if (!row || e.target.closest("[data-c]")) return;
    st.cur = row.dataset.t; st.listOpen = false;
    const t = thread();
    if (t && t.model && st.models.some((m) => m.id === t.model)) st.model = t.model;
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.id !== "chatInput") return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(e.target.value); }
    if (e.key === "Escape") e.target.blur();
  });
  document.addEventListener("input", (e) => { if (e.target.id === "chatInput") PR.autosize(e.target); });
  /* 读到别处时，上下文跟着换成当前段（手动指定的不动） */
  window.addEventListener("scroll", PR.debounce(() => {
    if (!PR.chatOpen() || st.streaming || (st.ctx && !st.ctx.auto)) return;
    const before = st.ctx && st.ctx.anchor;
    autoContext();
    if ((st.ctx && st.ctx.anchor) === before) return;
    const el = PR.$(".chip-ctx > span");
    if (el && st.ctx) { el.textContent = ctxLabel(st.ctx); el.parentElement.title = ctxLabel(st.ctx); } else render();
  }, 400), { passive: true });
})(window.PR);
