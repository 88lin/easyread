const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function reader(block, edits = {}) {
  let html = '';
  const node = { classList: { contains: () => false }, querySelector: () => null, replaceWith() {} };
  const PR = {
    state: { reader: { edits }, paper: { blocks: [block] } },
    on() {}, emit() {}, esc: String, md: String, t: s => s, imageUrl: s => '/p/test/' + s, hashText: s => s,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../easyread/web/js/reader/render.js'), 'utf8'), {
    window: { PR }, document: {
      getElementById: () => node,
      createElement: () => ({ set innerHTML(value) { html = value; }, firstChild: {} }),
    },
  });
  PR.blockById[block.id] = block;
  PR.renderBlock(block.id);
  return { PR, html };
}

test('read-first figure displays source labels without requiring a translation', () => {
  const { PR, html } = reader({ id: 'fig1', type: 'figure', src: 'figures/a.webp', image_en: 'Accuracy', caption_en: 'Figure 1' });
  assert.match(html, /src="\/p\/test\/figures\/a.webp"/);
  assert.match(html, /class="zh en-main" lang="en" data-key="fig1#image">Accuracy/);
  assert.equal((html.match(/Accuracy/g) || []).length, 1);
  assert.equal(PR.hasZh(PR.blockById.fig1), false);
});

test('translated figure preserves original labels and reader edits', () => {
  const { PR, html } = reader({ id: 'fig1', type: 'figure', image_en: 'Accuracy', image_zh: 'translated', caption_en: 'Figure 1' }, {
    'fig1#image': { zh: 'my wording', base: 'old translation' },
  });
  assert.match(html, /data-key="fig1#image">my wording/);
  assert.match(html, /class="en" lang="en">Accuracy/);
  assert.match(html, /stale-tag/);
  assert.deepEqual(Array.from(PR.blockKeys(PR.blockById.fig1)), ['fig1#caption', 'fig1#image']);
});

test('legacy figure without image text retains its page fallback', () => {
  const { html } = reader({ id: 'fig1', type: 'figure', page: 2, caption_zh: 'caption' });
  assert.match(html, /fig-missing/);
  assert.doesNotMatch(html, /figure-translation/);
});

test('figure with box renders at the original PDF physical size', () => {
  // 需要 meta.pages 提供 pt 宽度：改用带 meta 的 paper
  let html = '';
  const node = { classList: { contains: () => false }, querySelector: () => null, replaceWith() {} };
  const block = { id: 'fig1', type: 'figure', page: 3, src: 'figures/a.webp', box: [0.1, 0.2, 0.9, 0.5], caption_zh: 'c' };
  const PR = {
    state: { reader: { edits: {} }, paper: { blocks: [block], meta: { pages: [{ n: 3, w: 612, h: 792, img: 'pages/page-003.webp' }] } } },
    on() {}, emit() {}, esc: String, md: String, t: s => s, imageUrl: s => '/p/test/' + s, hashText: s => s,
  };
  const vm = require('node:vm');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../easyread/web/js/reader/render.js'), 'utf8'), {
    window: { PR }, document: {
      getElementById: () => node,
      createElement: () => ({ set innerHTML(value) { html = value; }, firstChild: {} }),
    },
  });
  PR.blockById[block.id] = block;
  PR.renderBlock(block.id);
  // 0.8 页宽 × 612pt × 4/3 = 652.8 → 653px
  assert.match(html, /width:\s*653px/);
});

test('figure without box or page data stays unsized', () => {
  const { html } = reader({ id: 'fig1', type: 'figure', src: 'figures/a.webp', caption_zh: 'c' });
  assert.match(html, /<img src="\/p\/test\/figures\/a.webp" alt="" loading="lazy">/);
});

test('malformed box is ignored', () => {
  const { html } = reader({ id: 'fig1', type: 'figure', src: 'figures/a.webp', box: [0.9, 0.5, 0.1, 0.2], caption_zh: 'c' });
  assert.match(html, /<img src="\/p\/test\/figures\/a.webp" alt="" loading="lazy">/);
});
