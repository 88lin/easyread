/* 顶栏的问号：版本和检查更新、遇到问题去哪儿反馈、文献库和日志在哪。按 ? 也能打开。
   快捷键不在这里列：设置 → 快捷键 里能看也能改。版本那块由 update.js 画（PR.updatePanel）。 */
(function (PR) {
  "use strict";
  const REPO = "https://github.com/Edwardxlai/easyread";
  const dlg = PR.$("#textDlg");
  const btn = PR.$("#helpBtn");
  btn.innerHTML = PR.icon("question") + '<span class="help-dot"></span>';
  btn.title = PR.t("帮助与关于");
  btn.onclick = () => PR.openHelp();

  const tile = (inner, icon, title, desc) => inner.replace("%", PR.icon(icon) + "<span><b>" + title + "</b><small>" + desc + "</small></span>");
  const link = (href, ...rest) => tile('<a class="help-tile" href="' + href + '" target="_blank" rel="noopener">%</a>', ...rest);
  const action = (name, ...rest) => tile('<button class="help-tile" data-help-do="' + name + '">%</button>', ...rest);

  PR.openHelp = function () {
    dlg.querySelector(".dialog").innerHTML =
      '<div class="help-head">' + PR.logo("hero sm") + '<div><h2>EasyRead</h2><div class="hint">' + PR.t("本地运行，论文和笔记只存在你的电脑上") + "</div></div></div>" +
      (PR.updatePanel ? PR.updatePanel() : "") +
      '<h4 class="help-h">' + PR.t("遇到问题") + '</h4><div class="help-tiles">' +
      link(REPO + "/issues/new/choose", "edit", PR.t("反馈问题、提建议"), PR.t("在 GitHub 上开 issue，附上截图或日志更快查到原因")) +
      action("log", "log", PR.t("打开日志文件夹"), PR.t("翻译失败、打不开时，把里面的 easyread.log 附在反馈里")) +
      link(REPO + "#readme", "book", PR.t("使用说明"), PR.t("导入论文、换翻译引擎、网盘同步怎么设置")) +
      action("library", "folder", PR.t("打开文献库文件夹"), PR.t("论文、译文和笔记都存在这里，备份就复制它")) +
      "</div>" +
      '<p class="hint help-foot">' + PR.t("快捷键在 {link} 里查看和修改。", { link: '<a href="#" data-help-do="keys">' + PR.t("设置 → 快捷键") + "</a>" }) + "</p>" +
      '<div class="actions"><button class="btn" data-close>' + PR.t("关闭") + "</button></div>";
    dlg.classList.add("open");
  };

  dlg.addEventListener("click", (e) => {
    const b = e.target.closest("[data-help-do]");
    if (!b) return;
    e.preventDefault();
    const what = b.dataset.helpDo;
    if (what === "keys") { dlg.classList.remove("open"); PR.openSettings("keys"); return; }
    PR.api(what === "log" ? "/api/log/reveal" : "/api/library/reveal", { method: "POST", body: {} }).catch((err) => PR.toast(PR.esc(err.message)));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "?" || e.target.closest("input, textarea, select, [contenteditable]") || PR.$(".dialog-backdrop.open")) return;
    e.preventDefault();
    PR.openHelp();
  });
})(window.PR);
