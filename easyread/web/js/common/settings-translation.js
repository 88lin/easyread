/* Translation preferences stay visible beside the existing model controls. */
(function (PR) {
  "use strict";
  PR.translationSettingsHtml = function (s) {
    const c = s.cfg;
    const select = (key, label, options, value, title = "") => '<label class="field"' + (title ? ' title="' + PR.esc(title) + '"' : '') + '><span>' + PR.t(label) + '</span><select class="input" data-k="' + key + '">' + PR.opt(options, value) + '</select></label>';
    return '<div class="translation-heading"><h4 class="set-h">' + PR.t("翻译设置") + '</h4><button class="btn sm line" id="testBtn">' + PR.t("试译一句") + '</button></div>' +
      '<div class="test-result" id="testRes" role="status"></div><div class="grid2 translation-limits">' +
      select('batch_pages', PR.t("每批页数"), [1,2,3,4].map(n => [n, PR.t("{n} 页", {n})]), c.batch_pages) +
      select('concurrency', PR.t("每篇同时译几段"), [[0, PR.t("自动")], ...[1,2,3,4,5,6,7,8].map(n => [n,n])], c.concurrency || 0, PR.t("把全文切成几段同时译，段内按顺序译；自动按篇幅每段约 2 批、最多 4 段；手动最多 8 段")) +
      select('paper_concurrency', PR.t("同时翻译几篇"), [1,2,3,4].map(n => [n, PR.t("{n} 篇", {n})]), c.paper_concurrency || 1, PR.t("修改后重启生效；多篇并行可能触发模型限流")) +
      select('page_cap', PR.t("超过多少页先问我"), [30,60,100,200].map(n => [n, PR.t("{n} 页", {n})]).concat([[0,PR.t("不限")]]), c.page_cap ?? 60) +
      '</div><div class="translation-options"><label class="check" title="' + PR.t("仅影响之后的翻译；图片题注照常翻译") + '"><input type="checkbox" data-k="translate_figure_text"' + (c.translate_figure_text !== false ? ' checked' : '') + '>' + PR.t("翻译图内文字") + '</label>' +
      (c.engine === 'openai' ? '<label class="check"><input type="checkbox" data-k="openai.vision"' + (c.openai.vision ? ' checked' : '') + '>' + PR.t("模型能看图") + '</label>' : '') + '</div>' +
      '<div class="translation-prompt-row"><span>' + PR.t("翻译提示词") + '</span><button class="btn sm line" data-edit-translation-prompt>' + PR.t("编辑提示词") + '</button></div>';
  };
})(window.PR);
