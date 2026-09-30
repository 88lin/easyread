/* 右侧“问 AI”面板：边读边和模型实时对话，回答逐字流出来。
   问题会带上你正在读的段落（或选中的原话）当上下文；页边笔记里的问题也从这里回答，答案同时写成那条笔记的回复。
   对话记录存在论文目录的 chat.json。模型在面板顶部选（和翻译引擎分开配置）。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const panel = () => PR.$("#chatpanel");
  let messages = [], loaded = false, options = null, current = null;
  let ctx = null;          // { anchor, quote, auto }：这次提问指着哪段
  let streaming = null;    // { ctrl, msg }

  PR.canChat = () => PR.store.mode === "server";
  PR.chatOpen = () => PR.side === "chat";
  PR.toggleChat = function (force) {
    const open = force != null ? force : PR.side !== "chat";
    PR.openSide(open ? "chat" : null);
    if (open) { if (!ctx || ctx.auto) autoContext(); render(); load(); setTimeout(() => { const t = PR.$("#chatInput"); t && t.focus(); }, 320); }
  };

  function autoContext() {
    const id = (PR.currentBlock && PR.currentBlock()) || PR.readingBlock();
    ctx = PR.blockById[id] ? { anchor: id, quote: "", auto: true } : null;
  }

  /* 外部入口：段落操作条、选中文字、笔记卡片上的“问 AI” */
  PR.chatAsk = function (opts) {
    ctx = { anchor: opts.anchor, quote: opts.quote || "", auto: false };
    if (PR.side !== "chat") PR.openSide("chat");
    load().then(() => {
      render();
      if (opts.text) send(opts.text, opts.note);
      else setTimeout(() => { const t = PR.$("#chatInput"); if (t) { t.value = opts.draft || ""; t.focus(); } }, 320);
    });
  };

  async function load() {
    if (loaded) return;
    try {
      const [h, o] = await Promise.all([PR.api("/api/p/" + PR.pid + "/chat"), PR.api("/api/chat/options")]);
      messages = h.messages || []; options = o.options; current = o.current;
      loaded = true;
      render();
    } catch (e) { PR.toast("读不到对话记录：" + PR.esc(e.message)); }
  }

  function ctxLabel(c) {
    if (!c || !PR.blockById[c.anchor]) return "";
    const b = PR.blockById[c.anchor];
    const sec = PR.sectionOf ? PR.sectionOf(c.anchor) : "";
    const text = (c.quote || PR.plain(PR.textFor(PR.blockKeys(b)[0] || b.id) || b.caption_zh || b.tex || ""))
      .replace(/\$\$?([^$]*)\$\$?/g, (m, t) => t.replace(/\\([a-zA-Z]+)\s*/g, (x, name) => ({ mu: "μ", sigma: "σ", epsilon: "ε", alpha: "α", beta: "β" })[name] || "").replace(/[{}\\^_]/g, ""));
    return (sec ? sec + " · " : "") + "「" + text.slice(0, 40) + (text.length > 40 ? "…" : "") + "」";
  }

  function optionIndex() {
    if (!options || !current) return 0;
    const i = options.findIndex((o) => o.engine === (current.engine || "same") && (o.engine !== "openai" || o.preset === current.preset) && (o.engine !== "claude" || o.model === current.model));
    return i < 0 ? 0 : i;
  }

  function msgHtml(m) {
    if (m.role === "user") {
      return '<div class="cm user"><div class="bubble">' + PR.esc(m.content).replace(/\n/g, "<br>") + "</div>" +
        (m.anchor ? '<button class="cm-ctx" data-c="go" data-anchor="' + PR.esc(m.anchor) + '">' + PR.esc(ctxLabel(m)) + "</button>" : "") + "</div>";
    }
    const live = streaming && streaming.msg === m;
    return '<div class="cm ai' + (m.error ? " err" : "") + '" data-id="' + PR.esc(m.id || "") + '"><div class="who">' + PR.icon("sparkle", "sm") + PR.esc(m.model || "AI") + (live ? ' <span class="spin"></span>' : "") + "</div>" +
      '<div class="body">' + (m.error ? PR.esc(m.error) : m.content ? PR.mdBlocks(m.content) : '<p class="hint">正在想…</p>') + "</div>" +
      (!live && !m.error && m.id ? '<div class="acts"><button data-c="copy">复制</button><button data-c="pin" title="作为 AI 讨论放到这段旁边">放到页边</button></div>' : "") + "</div>";
  }

  function render() {
    const el = panel();
    if (!el) return;
    const draft = PR.$("#chatInput") ? PR.$("#chatInput").value : "";
    const opts = (options || []).map((o, i) => '<option value="' + i + '"' + (i === optionIndex() ? " selected" : "") + (o.ready ? "" : " disabled") + ">" + PR.esc(o.label + (o.ready ? "" : "（未配置）")) + "</option>").join("");
    const list = messages.length ? messages.map(msgHtml).join("")
      : '<div class="chat-empty"><b>边读边问</b><p>不懂的概念、公式怎么推、这段和前面什么关系、作者为什么这么做……直接问。</p>' +
        '<p>问题会带上你正在读的段落；选中一句话再点“问 AI”，就只问那句。</p>' +
        '<div class="chips">' + ["这段在说什么？用大白话讲一遍", "这个公式每一项是什么意思？", "这里的结论靠得住吗？有什么前提？"].map((q) => '<button data-c="suggest">' + q + "</button>").join("") + "</div></div>";
    el.innerHTML = '<div class="np-head"><b class="chat-title">' + PR.icon("sparkle", "sm") + "问 AI</b>" +
      '<select class="input chat-model" id="chatModel" title="回答用的模型">' + (opts || "<option>加载中…</option>") + "</select>" +
      '<span class="grow"></span><button class="btn icon" data-c="clear" title="清空对话">' + PR.icon("trash", "sm") + '</button><button class="btn icon" data-c="close" title="关闭">×</button></div>' +
      '<div class="chat-list" id="chatList">' + list + "</div>" +
      '<div class="chat-compose">' + (ctx && ctx.anchor ? '<div class="chat-ctx"><span>' + (ctx.quote ? "问这句：" : "关于：") + PR.esc(ctxLabel(ctx)) + '</span><button data-c="noctx" title="不带这段">×</button></div>' : "") +
      '<textarea id="chatInput" rows="2" placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"></textarea>' +
      '<div class="chat-send"><span class="hint">' + (ctx && ctx.anchor ? "" : "没带段落，按整篇论文回答") + "</span>" +
      (streaming ? '<button class="btn sm line" data-c="stop">停止</button>' : '<button class="btn sm accent" data-c="send">发送</button>') + "</div></div>";
    PR.$("#chatInput").value = draft;
    const box = PR.$("#chatList");
    box.scrollTop = box.scrollHeight;
  }

  function renderLive() {
    const node = streaming && PR.$('#chatList .cm.ai:last-child .body');
    if (!node) return;
    node.innerHTML = streaming.msg.content ? PR.mdBlocks(streaming.msg.content) : '<p class="hint">正在想…</p>';
    const box = PR.$("#chatList");
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
  }
  const renderLiveSoon = PR.throttle(renderLive, 60);

  async function send(text, noteId) {
    text = (text || "").trim();
    if (!text || streaming) return;
    const c = ctx && ctx.anchor ? ctx : null;
    const user = { role: "user", content: text, anchor: c ? c.anchor : null, quote: c ? c.quote : "", note: noteId || null };
    const msg = { role: "assistant", content: "", model: "" };
    messages.push(user, msg);
    const ctrl = new AbortController();
    streaming = { ctrl, msg };
    if (PR.$("#chatInput")) PR.$("#chatInput").value = "";
    if (noteId) { PR.asking.add(noteId); PR.renderMargin(); }
    render();
    try {
      const res = await fetch("/api/p/" + PR.pid + "/chat", {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ text, anchor: user.anchor, quote: user.quote, note: noteId || null }),
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
          if (ev.model) { msg.model = ev.model; const w = PR.$('#chatList .cm.ai:last-child .who'); if (w) w.innerHTML = PR.icon("sparkle", "sm") + PR.esc(ev.model) + ' <span class="spin"></span>'; }
          if (ev.t) { msg.content += ev.t; renderLiveSoon(); }
          if (ev.done) msg.id = ev.id;
          if (ev.error) msg.error = ev.error;
        }
      }
    } catch (e) {
      if (e.name === "AbortError") msg.content += "\n\n（已停止）";
      else msg.error = "没能回答：" + e.message;
    }
    streaming = null;
    if (noteId) { PR.asking.delete(noteId); setTimeout(() => PR.poll && PR.poll(), 300); }
    if (ctx && ctx.anchor) ctx = { anchor: ctx.anchor, quote: "", auto: true };  // 问完一句，之后跟着阅读位置走
    render();
  }

  /* ---------- 事件 ---------- */
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("#chatpanel [data-c]");
    if (!b) return;
    const c = b.dataset.c;
    if (c === "close") PR.toggleChat(false);
    if (c === "send") send(PR.$("#chatInput").value);
    if (c === "stop" && streaming) streaming.ctrl.abort();
    if (c === "suggest") send(b.textContent);
    if (c === "noctx") { ctx = { anchor: null, quote: "", auto: false }; render(); }
    if (c === "go") PR.jumpTo("b-" + b.dataset.anchor);
    if (c === "clear") {
      if (!messages.length || !confirm("清空这篇论文的对话记录？（已经放到页边的讨论不受影响）")) return;
      await PR.api("/api/p/" + PR.pid + "/chat/clear", { method: "POST", body: {} });
      messages = []; render();
    }
    const card = b.closest(".cm.ai");
    const m = card && messages.find((x) => x.id === card.dataset.id);
    if (c === "copy" && m) navigator.clipboard.writeText(m.content).then(() => PR.toast("已复制"));
    if (c === "pin" && m) {
      try {
        await PR.api("/api/p/" + PR.pid + "/chat/pin", { method: "POST", body: { id: m.id } });
        PR.toast("已放到页边"); setTimeout(() => PR.poll && PR.poll(), 200);
      } catch (err) { PR.toast("没放成：" + PR.esc(err.message)); }
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.id !== "chatInput") return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(e.target.value); }
    if (e.key === "Escape") e.target.blur();
  });
  document.addEventListener("change", async (e) => {
    if (e.target.id !== "chatModel" || !options) return;
    const o = options[+e.target.value];
    try { current = (await PR.api("/api/chat/model", { method: "POST", body: { engine: o.engine, model: o.model, preset: o.preset } })).current; PR.toast("回答改用 " + PR.esc(o.label)); }
    catch (err) { PR.toast("没改成：" + PR.esc(err.message)); }
  });
  /* 读到别处时，“关于”跟着换成当前段（手动指定的不动） */
  window.addEventListener("scroll", PR.debounce(() => {
    if (!PR.chatOpen() || streaming || (ctx && !ctx.auto)) return;
    const before = ctx && ctx.anchor;
    autoContext();
    if ((ctx && ctx.anchor) !== before) { const el = PR.$(".chat-ctx span"); if (el && ctx) el.textContent = "关于：" + ctxLabel(ctx); else render(); }
  }, 400), { passive: true });
})(window.PR);
