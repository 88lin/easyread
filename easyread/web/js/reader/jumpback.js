/* 跳转后能回去：点引用 [n]、“公式 (4)”、目录、笔记卡片这类跳到远处时，记下原来的位置，
   左下角出现“返回刚才读的地方”；浏览器的后退（Alt+←、鼠标侧键、手机返回手势）也能回去。跳了几次就能回几次。 */
(function (PR) {
  "use strict";
  const stack = [];
  let btn = null;

  /* 在跳转前调用：目标就在眼前（一屏以内）就不记 */
  PR.rememberSpot = function (target) {
    const r = target.getBoundingClientRect();
    if (r.top > -innerHeight * 0.5 && r.bottom < innerHeight * 1.5) return;
    const id = PR.readingBlock();
    const el = document.getElementById("b-" + id) || document.getElementById("b-head");
    stack.push({ id, off: el ? el.getBoundingClientRect().top : 0, y: scrollY });
    if (stack.length > 30) stack.shift();
    try { history.pushState({ easyreadBack: stack.length }, "", location.href); } catch (e) { /* file:// 下可能不让改历史 */ }
    show();
  };

  function label() {
    const s = stack[stack.length - 1];
    const sec = s && PR.blockById[s.id] && PR.sectionOf ? PR.sectionOf(s.id) : "";
    return "返回刚才读的地方" + (sec ? "：" + sec : "");
  }
  function show() {
    if (!btn) {
      btn = PR.el("button", { class: "jump-back", type: "button", title: "回到跳转前的位置（浏览器后退也可以）" });
      btn.onclick = () => (history.state && history.state.easyreadBack ? history.back() : goBack());
      document.body.appendChild(btn);
    }
    btn.innerHTML = PR.icon("back", "sm") + "<span>" + PR.esc(label()) + "</span>" + (stack.length > 1 ? "<em>" + stack.length + "</em>" : "");
    btn.hidden = false;
  }
  function goBack() {
    const s = stack.pop();
    if (!s) return;
    const el = document.getElementById("b-" + s.id);
    const top = el ? scrollY + el.getBoundingClientRect().top - s.off : s.y;  // 按段落找回去，版面变过也不偏
    window.scrollTo({ top, behavior: "smooth" });
    if (el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
    if (stack.length) show(); else btn.hidden = true;
  }
  window.addEventListener("popstate", () => { if (stack.length) goBack(); });

  /* 自己滚回原处了，按钮就收起来 */
  window.addEventListener("scroll", PR.debounce(() => {
    const s = stack[stack.length - 1];
    if (!s || !btn || btn.hidden) return;
    const el = document.getElementById("b-" + s.id);
    if (el && Math.abs(el.getBoundingClientRect().top - s.off) < innerHeight * 0.4) { stack.pop(); if (stack.length) show(); else btn.hidden = true; }
  }, 300), { passive: true });
})(window.PR);
