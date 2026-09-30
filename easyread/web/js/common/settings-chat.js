/* 设置 → 问 AI：阅读页右侧能选的模型名单。
   加一项和“翻译”页一样：先选来源卡片（Claude Code / Codex / 免费模型 / 付费 API），再选模型；API 的 Key 和翻译共用。 */
(function (PR) {
  "use strict";
  const T = PR.settingsTabs;
  const CLAUDE = [["opus", "Opus（最强，最新版）"], ["sonnet", "Sonnet（快、省）"], ["haiku", "Haiku（最快）"]];
  const KIND_OF = { local: "free", free: "free", paid: "paid" };
  const kindOf = (s, m) => (m.engine === "openai" ? KIND_OF[((s.presets.find((p) => p.id === m.preset) || {}).group) || "local"] || "free" : m.engine);
  const hasKey = (s, preset) => (s.cfg.openai.saved_keys || []).includes(preset) || !!(s.chatKeys || {})[preset];
  const isApi = (k) => k === "free" || k === "paid";

  function formHtml(s) {
    const f = s.form;
    const card = (k, title, text) => '<button data-cmk="' + k + '" class="' + (f.kind === k ? "on" : "") + '"><b>' + title + "</b>" + text + "</button>";
    let h = '<div class="cm-form"><div class="engine-cards small">' +
      card("claude", "Claude Code", "本机账号，不用 Key") + card("codex", "Codex CLI", "本机 ChatGPT 账号") +
      card("free", "免费模型", "本机 Ollama、智谱等") + card("paid", "付费 API", "DeepSeek、通义等") + "</div>";
    if (f.kind === "claude") {
      h += '<label class="field"><span>模型</span><select class="input" id="cmModel">' + PR.opt(CLAUDE.concat(CLAUDE.some(([v]) => v === f.model) ? [] : [[f.model, f.model]]), f.model || "opus") + "</select></label>" +
        '<p class="hint">Claude Code 会用它支持的最新版（现在是 Opus 5.5 / Sonnet 5.5）；新模型出来后运行 <code>claude update</code>。</p>';
    } else if (f.kind === "codex") {
      h += '<label class="field"><span>模型</span><input class="input" id="cmModel" value="' + PR.esc(f.model) + '" placeholder="留空用 Codex 自己的默认模型"></label>';
    } else {
      const groups = s.groups.filter(([g]) => (KIND_OF[g] || "free") === f.kind);
      h += '<div class="preset-tiles grouped">' + groups.map(([g, label]) => '<div class="preset-group"><span>' + PR.esc(label) + "</span>" +
        s.presets.filter((p) => p.group === g).map((p) => '<button data-cmp="' + p.id + '" class="' + (f.preset === p.id ? "on" : "") + '">' + PR.esc(p.name) +
          (hasKey(s, p.id) ? ' <span class="ok-dot" title="已存 Key"></span>' : "") + "</button>").join("") + "</div>").join("") + "</div>";
      const p = s.presets.find((x) => x.id === f.preset);
      if (p) {
        h += (p.note ? '<p class="hint preset-note">' + PR.esc(p.note) + (p.key_url ? ' <a href="' + p.key_url + '" target="_blank" rel="noopener">' + (p.key ? "获取 Key ↗" : "下载 ↗") + "</a>" : "") + "</p>" : "") +
          '<div class="grid2"><label class="field"><span>模型</span><input class="input" id="cmModel" list="cmSugg" value="' + PR.esc(f.model) + '"><datalist id="cmSugg">' +
          (p.models || []).map((x) => '<option value="' + PR.esc(x) + '">').join("") + "</datalist></label>" +
          (p.key ? '<label class="field"><span>API Key' + (hasKey(s, p.id) ? "（已保存，留空不改）" : "") + '</span><input class="input" type="password" id="cmKey" value="' + PR.esc(f.key || "") + '" placeholder="sk-…" autocomplete="off"></label>' : "<span></span>") + "</div>";
      }
    }
    return h + '<label class="field"><span>显示的名字（可不填）</span><input class="input" id="cmName" value="' + PR.esc(f.name) + '" placeholder="' + PR.esc(autoName(s, f)) + '"></label>' +
      '<div class="cm-form-acts"><span class="hint">' + (isApi(f.kind) ? "Key 和“翻译”页共用，每家只填一次。" : "") + '</span><span class="grow"></span>' +
      '<button class="btn sm" data-cm="cancel">取消</button><button class="btn sm accent" data-cm="ok">' + (s.editing === "new" ? "加进名单" : "改好了") + "</button></div></div>";
  }
  function autoName(s, f) {
    if (f.kind === "claude") { const m = f.model || "opus"; return "Claude " + m.charAt(0).toUpperCase() + m.slice(1); }
    if (f.kind === "codex") return f.model || "GPT";
    const p = s.presets.find((x) => x.id === f.preset);
    return f.model || (p ? p.name : "模型");
  }
  function readForm(s) {
    const f = s.form;
    if (!f) return;
    const v = (id) => { const el = PR.$("#" + id); return el ? el.value.trim() : null; };
    if (v("cmModel") !== null) f.model = v("cmModel");
    if (v("cmName") !== null) f.name = v("cmName");
    if (v("cmKey") !== null) f.key = v("cmKey");
  }
  function startForm(s, m) {
    s.form = m ? { kind: kindOf(s, m), model: m.model || "", preset: m.preset || "", name: m.name || "", key: "" }
      : { kind: "claude", model: "opus", preset: "", name: "", key: "" };
  }

  T.chat = {
    render(s) {
      if (!s.chat) return '<p class="hint">读不到模型名单。</p>';
      const rows = s.chat.models.map((m, i) => {
        if (s.editing === m.id) return formHtml(s);
        const def = s.chat.default === m.id;
        return '<div class="cm-row' + (m.ready === false ? " off" : "") + '"><button class="cm-radio' + (def ? " on" : "") + '" data-cm="default" data-i="' + i + '" title="设为默认"></button>' +
          '<div class="cm-main"><b>' + PR.esc(m.label || m.name) + "</b>" + (def ? '<span class="cm-def">默认</span>' : "") +
          '<div class="cm-sub">' + PR.esc([m.source, m.detail].filter(Boolean).join(" · ")) + (m.ready === false ? ' · <span class="bad">' + PR.esc(m.hint || "还不能用") + "</span>" : "") + "</div></div>" +
          '<button class="btn sm" data-cm="up" data-i="' + i + '" title="上移"' + (i ? "" : " disabled") + ">↑</button>" +
          '<button class="btn sm" data-cm="edit" data-i="' + i + '">改</button><button class="btn sm danger" data-cm="del" data-i="' + i + '">删</button></div>';
      }).join("");
      return '<p class="set-lead">阅读页右侧“问 AI”能选的模型。圆点是新对话默认用的；对话框左下角可以随时换。</p>' +
        '<div class="cm-list">' + rows + "</div>" +
        (s.editing === "new" ? formHtml(s) : '<button class="btn sm line" data-cm="add">' + PR.icon("plus", "sm") + "添加模型</button>") +
        '<p class="hint" style="margin-top:14px">每次提问会带上：你正在读的段落、你引用的几段、摘要和术语表。问到“标红的”“划线”“我的笔记”时，才会找出对应颜色的标记一起发过去。</p>';
    },
    sync(s) { readForm(s); },
    click(e, s) {
      const k = e.target.closest("[data-cmk]");
      if (k && s.form) {
        readForm(s);
        const f = s.form, kind = k.dataset.cmk;
        if (kind === f.kind) return false;
        Object.assign(f, { kind, model: kind === "claude" ? "opus" : "", name: "", key: "" });
        if (isApi(kind)) {
          const ol = s.found && s.found.ollama && s.found.ollama.running;
          f.preset = kind === "paid" ? "deepseek" : ol ? "ollama" : "zhipu";
          f.model = (s.presets.find((p) => p.id === f.preset) || {}).model || "";
        }
        return true;
      }
      const pb = e.target.closest("[data-cmp]");
      if (pb && s.form) { readForm(s); Object.assign(s.form, { preset: pb.dataset.cmp, model: (s.presets.find((p) => p.id === pb.dataset.cmp) || {}).model || "", key: "", name: "" }); return true; }
      const b = e.target.closest("[data-cm]");
      if (!b) return false;
      const i = +b.dataset.i, list = s.chat.models, act = b.dataset.cm;
      if (act === "default") s.chat.default = list[i].id;
      if (act === "up" && i > 0) list.splice(i - 1, 0, list.splice(i, 1)[0]);
      if (act === "del") { if (list.length <= 1) { PR.toast("至少留一个模型"); return false; } const [x] = list.splice(i, 1); if (s.chat.default === x.id) s.chat.default = list[0].id; }
      if (act === "edit") { s.editing = list[i].id; startForm(s, list[i]); }
      if (act === "add") { s.editing = "new"; startForm(s); }
      if (act === "cancel") { s.editing = null; s.form = null; }
      if (act === "ok") {
        readForm(s);
        const f = s.form, api = isApi(f.kind);
        const p = s.presets.find((x) => x.id === f.preset);
        if (api && !f.model) { PR.toast("填一个模型名"); return false; }
        if (api && p && p.key && !hasKey(s, f.preset) && !f.key) { PR.toast("这家要填 API Key"); return false; }
        if (api && f.key) (s.chatKeys = s.chatKeys || {})[f.preset] = f.key;
        const name = f.name || autoName(s, f);
        const m = { engine: api ? "openai" : f.kind, preset: api ? f.preset : "", model: f.model, name, label: name,
          source: api ? (p ? p.name : "API") : f.kind === "claude" ? "Claude Code" : "Codex CLI", detail: f.model, ready: true };
        if (s.editing === "new") list.push(Object.assign(m, { id: "m" + Date.now().toString(36) }));
        else Object.assign(list.find((x) => x.id === s.editing), m);
        s.editing = null; s.form = null;
      }
      return true;
    },
  };
})(window.PR);
