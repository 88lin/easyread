/* 设置：翻译引擎（本机 Claude Code / Codex CLI、各家 API、不翻译）、翻译速度、主题。
   打开时顺手检测本机装了什么，能直接用的标出来。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  const dlg = PR.$("#settingsDlg");
  let cfg = null, presets = [], groups = [], found = null, chatOpts = null;

  const CLAUDE_MODELS = [["", "跟随 Claude Code 默认"], ["opus", "Opus（最好）"], ["sonnet", "Sonnet（快、省，推荐）"], ["haiku", "Haiku（最省）"]];

  PR.openSettings = async function () {
    const d = await PR.api("/api/config");
    cfg = d.config; presets = d.presets; groups = d.groups || [];
    render();
    dlg.classList.add("open");
    PR.api("/api/chat/options").then((o) => { chatOpts = o; if (dlg.classList.contains("open")) { keep(); render(); } }).catch(() => {});
    if (!found) {
      found = (await PR.api("/api/engines").catch(() => ({ found: {} }))).found;
      if (dlg.classList.contains("open")) { Object.assign(cfg, deep(collect())); render(); }
    }
  };
  PR.$("#settingsBtn").onclick = PR.openSettings;

  function opt(list, val) { return list.map(([v, l]) => '<option value="' + PR.esc(v) + '"' + (String(v) === String(val) ? " selected" : "") + ">" + PR.esc(l) + "</option>").join(""); }

  function badge(name) {
    if (!found) return '<span class="badge"><span class="spin"></span>检测中</span>';
    const f = found[name] || {};
    return f.found ? '<span class="badge ok">已安装' + (f.version ? " " + PR.esc((f.version.match(/\d+(\.\d+)+/) || [""])[0]) : "") + "</span>" : '<span class="badge">本机没找到</span>';
  }

  function engineCards() {
    const e = cfg.engine;
    const card = (k, title, text, extra) => '<button data-engine="' + k + '" class="' + (e === k ? "on" : "") + '"><b>' + title + "</b>" + text + (extra || "") + "</button>";
    return '<div class="engine-cards">' +
      card("claude", "Claude Code", "用本机已登录的 Claude Code，不用 Key。会看原页图核对公式，译文最好。", badge("claude")) +
      card("codex", "Codex CLI", "用本机已登录的 Codex（ChatGPT 账号），不用 Key。", badge("codex")) +
      card("openai", "API", "DeepSeek、智谱、通义、Kimi、Gemini、OpenAI、本机 Ollama……填个 Key 就行。") +
      card("none", "不自动翻译", "只导入。之后在对话里让 agent 译，或再开引擎。") + "</div>";
  }

  function cliFields(name) {
    const c = cfg[name];
    const model = name === "claude"
      ? '<select class="input" data-k="claude.model">' + opt(CLAUDE_MODELS, c.model) + "</select>"
      : '<input class="input" data-k="codex.model" value="' + PR.esc(c.model) + '" placeholder="留空用 Codex 默认模型">';
    const how = name === "claude"
      ? '还没装？<a href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank" rel="noopener">安装 Claude Code</a>，在终端里运行一次 <code>claude</code> 登录。翻译用的是你订阅里的额度。'
      : '还没装？<code>npm i -g @openai/codex</code>，再运行一次 <code>codex</code> 登录。';
    return '<div class="grid2"><label class="field"><span>模型</span>' + model + "</label>" +
      '<label class="field"><span>命令</span><input class="input" data-k="' + name + '.command" value="' + PR.esc(c.command) + '"></label></div>' +
      '<p class="hint">' + how + "</p>";
  }

  function apiFields() {
    const o = cfg.openai;
    const p = presets.find((x) => x.id === o.preset);
    const ollama = found && found.ollama;
    let model = '<input class="input" data-k="openai.model" value="' + PR.esc(o.model) + '" list="modelList" placeholder="模型名">' +
      '<datalist id="modelList">' + ((p && p.models) || []).map((m) => '<option value="' + PR.esc(m) + '">').join("") + "</datalist>";
    if (o.preset === "ollama" && ollama && ollama.models.length) {
      model = '<select class="input" data-k="openai.model">' + opt(ollama.models.map((m) => [m, m]).concat(ollama.models.includes(o.model) || !o.model ? [] : [[o.model, o.model + "（没下载）"]]), o.model) + "</select>";
    }
    const saved = o.saved_keys || [];
    const tile = (x) => '<button data-preset="' + x.id + '" class="' + (o.preset === x.id ? "on" : "") + '">' + PR.esc(x.name) + (saved.includes(x.id) ? ' <span class="ok-dot" title="已存 Key"></span>' : "") + "</button>";
    const tiles = groups.map(([g, label]) => '<div class="preset-group"><span>' + PR.esc(label) + "</span>" + presets.filter((x) => x.group === g).map(tile).join("") +
      (g === "local" ? '<button data-preset="" class="' + (!o.preset ? "on" : "") + '">自定义地址</button>' : "") + "</div>").join("");
    let note = p && p.note ? PR.esc(p.note) : "";
    if (o.preset === "ollama" && found) note = (ollama && ollama.running ? "Ollama 在运行，已下载 " + ollama.models.length + " 个模型。" : '<span class="bad">没检测到 Ollama（127.0.0.1:11434）。</span>') + note;
    return '<div class="preset-tiles grouped">' + tiles + "</div>" +
      (note || (p && p.key_url) ? '<p class="hint preset-note">' + note + (p && p.key_url ? ' <a href="' + p.key_url + '" target="_blank" rel="noopener">' + (p.key ? "获取 Key ↗" : "下载 ↗") + "</a>" : "") + "</p>" : "") +
      '<div class="grid2"><label class="field"><span>接口地址（base URL）</span><input class="input" data-k="openai.base_url" value="' + PR.esc(o.base_url) + '" placeholder="https://…/v1"></label>' +
      '<label class="field"><span>模型</span>' + model + "</label></div>" +
      (p && !p.key ? "" : '<label class="field"><span>API Key' + (o.has_key ? "（已保存，留空不改）" : "") + '</span><input class="input" type="password" data-k="openai.api_key" value="' + PR.esc(o.api_key) + '" placeholder="sk-…" autocomplete="off"></label>') +
      '<label class="check" style="margin:0 0 10px"><input type="checkbox" data-k="openai.vision"' + (o.vision ? " checked" : "") + ">模型能看图（把原页图一起发过去，公式和表格更准）</label>" +
      '<p class="hint">Key 只存在本机的 config.json 里，只发给你填的这个地址。</p>';
  }

  function render() {
    const e = cfg.engine;
    const theme = PR.ls.get("easyread-prefs", {}).theme || "auto";
    let h = "<h2>设置</h2><div class=\"field\"><span>翻译引擎</span></div>" + engineCards();
    if (e === "claude" || e === "codex") h += cliFields(e);
    else if (e === "openai") h += apiFields();
    h += '<div class="test-line"><button class="btn sm line" id="testBtn">' + PR.icon("sparkle", "sm") + '试译一句</button><span class="test-result" id="testRes"></span></div>' +
      '<div class="settings-sec grid3">' +
      '<label class="field"><span>每次交给模型的页数</span><select class="input" data-k="batch_pages">' +
      opt([[1, "1 页（最稳）"], [2, "2 页（推荐）"], [3, "3 页"], [4, "4 页"]], cfg.batch_pages) + "</select></label>" +
      '<label class="field"><span>同时翻译几批</span><select class="input" data-k="concurrency">' +
      opt([[1, "1（本机 CLI 推荐）"], [2, "2"], [3, "3（API 推荐）"], [4, "4"], [6, "6（最快）"]], cfg.concurrency) + "</select></label>" +
      '<label class="field"><span>界面主题</span><select class="input" id="themeSel">' + opt([["auto", "跟随系统"], ["light", "浅色"], ["dark", "深色"]], theme) + "</select></label></div>" +
      chatField() +
      '<label class="check" style="margin-top:0"><input type="checkbox" data-k="auto_translate"' + (cfg.auto_translate ? " checked" : "") + ">导入后自动开始翻译</label>" +
      '<p class="hint" style="margin-top:12px">文献库位置：' + PR.esc(cfg.library_dir) + ' · <button class="linkish" id="showLog">查看运行日志</button></p>' +
      '<div class="actions"><button class="btn" id="setCancel">取消</button><button class="btn primary" id="setSave">保存</button></div>';
    dlg.querySelector(".dialog").innerHTML = h;
  }

  function chatField() {
    if (!chatOpts) return "";
    const cur = chatOpts.current || {};
    const idx = Math.max(0, chatOpts.options.findIndex((x) => x.engine === (cur.engine || "same") && (x.engine !== "openai" || x.preset === cur.preset) && (x.engine !== "claude" || x.model === cur.model)));
    return '<label class="field"><span>“问 AI”用的模型（阅读页右侧边读边问；和翻译引擎分开选）</span><select class="input" id="chatSel">' +
      chatOpts.options.map((x, i) => '<option value="' + i + '"' + (i === idx ? " selected" : "") + (x.ready ? "" : " disabled") + ">" + PR.esc(x.label + (x.ready ? "" : "（未配置）")) + "</option>").join("") + "</select></label>";
  }

  function collect() {
    const patch = { engine: cfg.engine, claude: {}, codex: {}, openai: { preset: cfg.openai.preset } };
    PR.$$("[data-k]", dlg).forEach((el) => {
      const [a, b] = el.dataset.k.split(".");
      const v = el.type === "checkbox" ? el.checked : el.value;
      if (b) patch[a][b] = v; else patch[a] = ["batch_pages", "concurrency"].includes(a) ? +v : v;
    });
    return patch;
  }
  function deep(p) {
    return { engine: p.engine, batch_pages: p.batch_pages, concurrency: p.concurrency, auto_translate: p.auto_translate,
      claude: Object.assign({}, cfg.claude, p.claude), codex: Object.assign({}, cfg.codex, p.codex), openai: Object.assign({}, cfg.openai, p.openai) };
  }
  const keep = () => Object.assign(cfg, deep(collect()));

  PR.showText = function (title, text) {
    const d = PR.$("#textDlg");
    d.querySelector(".dialog").innerHTML = "<h2>" + PR.esc(title) + '</h2><pre class="logview">' + PR.esc(text || "（还没有记录）") + '</pre><div class="actions"><button class="btn" data-close>关闭</button></div>';
    d.classList.add("open");
    const pre = d.querySelector("pre"); pre.scrollTop = pre.scrollHeight;
  };
  PR.$("#textDlg").addEventListener("click", (e) => { if (e.target.id === "textDlg" || e.target.closest("[data-close]")) PR.$("#textDlg").classList.remove("open"); });

  dlg.addEventListener("click", async (e) => {
    if (e.target === dlg || e.target.closest("#setCancel")) return dlg.classList.remove("open");
    const card = e.target.closest("[data-engine]");
    if (card) { keep(); cfg.engine = card.dataset.engine; if (cfg.engine === "openai" && cfg.concurrency < 2) cfg.concurrency = 3; if (cfg.engine !== "openai" && cfg.concurrency > 2) cfg.concurrency = 1; render(); return; }
    const pre = e.target.closest("[data-preset]");
    if (pre) {
      keep();
      const p = presets.find((x) => x.id === pre.dataset.preset);
      cfg.openai.preset = pre.dataset.preset;
      if (p) {
        cfg.openai.base_url = p.base_url;
        const om = found && found.ollama && found.ollama.models;
        cfg.openai.model = p.id === "ollama" && om && om.length && !om.includes(p.model) ? om[0] : p.model;
        cfg.openai.vision = ["gemini", "openai", "anthropic"].includes(p.id);
      }
      { // 每家的 Key 分开存，换回来不用重填
        const saved = (cfg.openai.saved_keys || []).includes(cfg.openai.preset);
        cfg.openai.api_key = saved ? "••••" : "";
        cfg.openai.has_key = saved;
      }
      render();
      return;
    }
    if (e.target.closest("#showLog")) { const r = await PR.api("/api/log"); PR.showText("运行日志", r.text + "\n\n（完整日志：" + r.path + "）"); return; }
    if (e.target.closest("#testBtn")) {
      const res = PR.$("#testRes");
      res.className = "test-result"; res.innerHTML = '<span class="spin"></span> 正在让模型回一句话…';
      try {
        await PR.api("/api/config", { method: "POST", body: collect() });
        const r = await PR.api("/api/config/test", { method: "POST", body: { engine: cfg.engine } });
        res.className = "test-result " + (r.ok ? "ok" : "bad"); res.textContent = (r.ok ? "✓ " : "✗ ") + r.message;
      } catch (err) { res.className = "test-result bad"; res.textContent = err.message; }
      return;
    }
    if (e.target.closest("#setSave")) {
      try {
        const r = await PR.api("/api/config", { method: "POST", body: collect() });
        cfg = r.config;
        const cs = PR.$("#chatSel");
        if (cs && chatOpts) { const x = chatOpts.options[+cs.value]; await PR.api("/api/chat/model", { method: "POST", body: { engine: x.engine, model: x.model, preset: x.preset } }); }
        PR.ls.set("easyread-auto-translate", !!cfg.auto_translate);
        dlg.classList.remove("open");
        PR.toast("设置已保存");
        L.load();
      } catch (err) { PR.toast("保存失败：" + PR.esc(err.message)); }
    }
  });
  dlg.addEventListener("change", (e) => {
    if (e.target.id === "themeSel") {
      const prefs = PR.ls.get("easyread-prefs", {});
      prefs.theme = e.target.value;
      PR.ls.set("easyread-prefs", prefs);
      PR.applyTheme(prefs.theme);
      PR.savePrefs("reader", { theme: prefs.theme });
    }
  });
  dlg.addEventListener("keydown", (e) => { if (e.key === "Escape") dlg.classList.remove("open"); });
})(window.PR);
