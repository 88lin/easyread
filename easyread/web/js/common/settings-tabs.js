/* 设置的另外三页：问 AI（常用模型名单）、阅读（功能开关、主题）、快捷键（总开关、改键）。 */
(function (PR) {
  "use strict";
  const T = PR.settingsTabs;

  /* ---------- 问 AI ---------- */
  const SOURCES = [["claude", "Claude Code（本机，不用 Key）"], ["codex", "Codex CLI（本机，不用 Key）"]];
  const SUGGEST = {
    claude: ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"],
    codex: [],
  };
  function sourceOf(m) { return m.engine === "openai" ? "api:" + (m.preset || "") : m.engine; }
  function formHtml(s, m) {
    const presets = (s.chat && s.chat.presets) || [];
    const src = sourceOf(m);
    const opts = SOURCES.concat(presets.map((p) => ["api:" + p.id, p.name + "（API）"]));
    const sugg = src.startsWith("api:") ? ((presets.find((p) => "api:" + p.id === src) || {}).models || []) : SUGGEST[src] || [];
    return '<div class="cm-form"><div class="grid3">' +
      '<label class="field"><span>来源</span><select class="input" id="cmSrc">' + PR.opt(opts, src) + "</select></label>" +
      '<label class="field"><span>模型</span><input class="input" id="cmModel" list="cmSugg" value="' + PR.esc(m.model || "") + '" placeholder="' + (src === "codex" ? "留空用 Codex 默认" : "模型名") + '">' +
      '<datalist id="cmSugg">' + sugg.map((x) => '<option value="' + PR.esc(x) + '">').join("") + "</datalist></label>" +
      '<label class="field"><span>显示的名字</span><input class="input" id="cmName" value="' + PR.esc(m.name || "") + '" placeholder="比如 DeepSeek V3"></label></div>' +
      '<div class="cm-form-acts"><span class="hint">' + (src.startsWith("api:") ? "Key 用“翻译 → API”里这家存的那个。" : "用本机已登录的账号。") + '</span><span class="grow"></span>' +
      '<button class="btn sm" data-cm="cancel">取消</button><button class="btn sm accent" data-cm="ok">' + (m.id ? "改好了" : "加进名单") + "</button></div></div>";
  }
  T.chat = {
    render(s) {
      if (!s.chat) return '<p class="hint">读不到模型名单。</p>';
      const rows = s.chat.models.map((m, i) => {
        if (s.editing === m.id) return formHtml(s, m);
        const def = s.chat.default === m.id;
        return '<div class="cm-row' + (m.ready === false ? " off" : "") + '"><button class="cm-radio' + (def ? " on" : "") + '" data-cm="default" data-i="' + i + '" title="设为默认"></button>' +
          '<div class="cm-main"><b>' + PR.esc(m.label || m.name) + "</b>" + (def ? '<span class="cm-def">默认</span>' : "") +
          '<div class="cm-sub">' + PR.esc([m.source, m.detail].filter(Boolean).join(" · ")) + (m.ready === false ? ' · <span class="bad">' + PR.esc(m.hint || "还不能用") + "</span>" : "") + "</div></div>" +
          '<button class="btn sm" data-cm="up" data-i="' + i + '" title="上移"' + (i ? "" : " disabled") + ">↑</button>" +
          '<button class="btn sm" data-cm="edit" data-i="' + i + '">改</button><button class="btn sm danger" data-cm="del" data-i="' + i + '">删</button></div>';
      }).join("");
      return '<p class="set-lead">阅读页右侧“问 AI”能选的模型。留几个常用的就好，圆点是新对话默认用的那个；每个对话里也能随时换。</p>' +
        '<div class="cm-list">' + rows + "</div>" +
        (s.editing === "new" ? formHtml(s, s._draft || { engine: "openai", preset: "deepseek", model: "" }) : '<button class="btn sm line" data-cm="add">' + PR.icon("plus", "sm") + "添加模型</button>") +
        '<p class="hint" style="margin-top:14px">回答时会带上：你正在读的段落和前后文、摘要、术语表，以及你做过的全部划线、笔记和问题（按颜色分组）。所以可以直接问“我标红的那些公式之间有什么联系”。</p>';
    },
    readForm(s) {
      const src = PR.$("#cmSrc").value, model = PR.$("#cmModel").value.trim(), name = PR.$("#cmName").value.trim();
      const m = src.startsWith("api:") ? { engine: "openai", preset: src.slice(4) } : { engine: src, preset: "" };
      const presetName = ((s.chat.presets || []).find((p) => p.id === m.preset) || {}).name;
      return Object.assign(m, { model, name: name || (m.engine === "codex" && !model ? "GPT" : model || presetName || "模型") });
    },
    click(e, s) {
      const b = e.target.closest("[data-cm]");
      if (!b) return false;
      const i = +b.dataset.i, list = s.chat.models, act = b.dataset.cm;
      if (act === "default") s.chat.default = list[i].id;
      if (act === "up" && i > 0) list.splice(i - 1, 0, list.splice(i, 1)[0]);
      if (act === "del") { if (list.length <= 1) { PR.toast("至少留一个模型"); return false; } const [x] = list.splice(i, 1); if (s.chat.default === x.id) s.chat.default = list[0].id; }
      if (act === "edit") s.editing = list[i].id;
      if (act === "add") { s.editing = "new"; s._draft = null; }
      if (act === "cancel") s.editing = null;
      if (act === "ok") {
        const m = this.readForm(s);
        if (m.engine === "openai" && !m.model) { PR.toast("填一个模型名"); return false; }
        if (s.editing === "new") list.push(Object.assign(m, { id: "m" + Date.now().toString(36), label: m.name, source: m.engine === "openai" ? "API" : m.engine === "claude" ? "Claude Code" : "Codex CLI", detail: m.model }));
        else Object.assign(list.find((x) => x.id === s.editing), m, { label: m.name, detail: m.model });
        s.editing = null;
      }
      return true;
    },
    change(e, s) {
      if (e.target.id !== "cmSrc") return false;
      const m = this.readForm(s);  // 换来源：模型名清空，给新的建议
      m.model = ""; m.name = "";
      const cur = s.editing === "new" ? null : s.chat.models.find((x) => x.id === s.editing);
      if (cur) Object.assign(cur, m); else s._draft = m;
      return true;
    },
  };

  /* ---------- 阅读 ---------- */
  T.reading = {
    render(s) {
      return '<p class="set-lead">阅读页上显示哪些功能。关掉的功能，按钮和快捷键都会一起消失。</p><div class="switch-list">' +
        PR.FEATURES.map(([id, name, , desc]) => '<label class="switch-row"><span><b>' + name + "</b><small>" + desc + '</small></span><input type="checkbox" class="switch" data-feat="' + id + '"' + (s.ui.features[id] !== false ? " checked" : "") + "></label>").join("") +
        "</div>" + '<div class="settings-sec grid2"><label class="field"><span>界面主题</span><select class="input" id="themeSel">' +
        PR.opt([["auto", "跟随系统"], ["light", "浅色"], ["dark", "深色"]], s.theme) + "</select></label></div>" +
        '<p class="hint">字号、版心、行距在阅读页右上角的 Aa 里调。</p>';
    },
    change(e, s) {
      if (e.target.dataset.feat) s.ui.features[e.target.dataset.feat] = e.target.checked;
      if (e.target.id === "themeSel") { s.theme = e.target.value; PR.applyTheme(s.theme); }
      return false;
    },
  };

  /* ---------- 快捷键 ---------- */
  T.keys = {
    render(s) {
      let h = '<label class="switch-row big"><span><b>启用快捷键</b><small>关掉后只剩 Esc。单个字母的快捷键打字时不会触发，但点着页面时按到会触发。</small></span><input type="checkbox" class="switch" id="keysOn"' + (s.ui.keys_on ? " checked" : "") + "></label>";
      h += '<div class="keys-list' + (s.ui.keys_on ? "" : " dim") + '">';
      let grp = "";
      for (const [id, label, , group, need] of PR.KEY_ACTIONS) {
        if (group !== grp) { h += '<div class="grp">' + group + "</div>"; grp = group; }
        const off = need && s.ui.features[need] === false;
        const k = s.ui.keys[id];
        h += "<span>" + label + (off ? ' <small class="hint">（功能已关）</small>' : "") + '</span><button class="kcap' + (s.recording === id ? " rec" : k ? "" : " off") + '" data-krec="' + id + '">' +
          (s.recording === id ? "按一个键…" : k ? PR.esc(PR.keyName(k)) : "未设置") + '</button><button class="kx" data-koff="' + id + '" title="不用这个快捷键">清除</button>';
      }
      return h + '</div><div class="keys-foot"><span class="hint">选中文字后 1–4 四色划线、N 笔记、Q 提问，跟着总开关。</span><button class="btn sm" data-kreset>恢复默认键位</button></div>';
    },
    click(e, s) {
      const r = e.target.closest("[data-krec]"), off = e.target.closest("[data-koff]");
      if (r) { s.recording = s.recording === r.dataset.krec ? null : r.dataset.krec; return true; }
      if (off) { s.ui.keys[off.dataset.koff] = ""; s.recording = null; return true; }
      if (e.target.closest("[data-kreset]")) { s.ui.keys = PR.defaultKeys(); s.recording = null; return true; }
      return false;
    },
    change(e, s) { if (e.target.id === "keysOn") { s.ui.keys_on = e.target.checked; return true; } return false; },
    key(e, s) {
      if (e.key === "Escape") { s.recording = null; return true; }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return false;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (/^[1-4]$/.test(k)) { PR.toast("1–4 留给选中文字后的划线"); return false; }
      const taken = Object.keys(s.ui.keys).find((id) => s.ui.keys[id] === k && id !== s.recording);
      if (taken) { s.ui.keys[taken] = ""; PR.toast("「" + PR.KEY_ACTIONS.find((a) => a[0] === taken)[1] + "」原来的键让给了这个操作"); }
      s.ui.keys[s.recording] = k;
      s.recording = null;
      return true;
    },
  };
})(window.PR);
