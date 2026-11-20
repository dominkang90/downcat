'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const settingsHtml = fs.readFileSync(path.join(root, 'settings.html'), 'utf8');
const rendererHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parts = {}; this.style = {};
    this.value = ''; this.textContent = ''; this.classList = { toggle() {}, add() {}, remove() {} };
  }
  addEventListener() {}
  appendChild(el) { this.children.push(el); return el; }
  querySelector(selector) { return this.parts[selector] ||= new Element(); }
  set innerHTML(value) { this.children = []; this.parts = {}; this._html = value; }
  get innerHTML() { return this._html || ''; }
}
function harness(file, overrides = {}) {
  const html = file === 'settings.js' ? settingsHtml : rendererHtml;
  const elements = new Map();
  for (const m of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(m[2], new Element(m[1]));
  if (elements.has('sort')) elements.get('sort').value = 'recent';
  const callbacks = {}; const patches = []; const alerts = [];
  const api = {
    getSettings: async () => ({ parallel: 1 }), setSettings: patch => patches.push(patch),
    getCookieFile: async () => '', getTasks: async () => [], toolsStatus: async () => [],
    onToolsChanged() {}, onJobEvent: cb => { callbacks.job = cb; }, onClipboardUrl() {}, onBridgeJob() {},
    download: async () => ({ ok: true, count: 1, bytes: 1 }), ...overrides,
  };
  const document = { getElementById: id => elements.get(id), createElement: tag => new Element(tag), addEventListener() {} };
  const context = vm.createContext({ window: { api }, document, URL, console, setTimeout() {},
    localStorage: { getItem: () => null, setItem() {} }, crypto: { randomUUID: () => 'new' }, alert: message => alerts.push(message), confirm: () => false });
  const evaluate = source => vm.runInContext(source, context);
  evaluate(fs.readFileSync(path.join(root, file), 'utf8'));
  return { elements, callbacks, patches, alerts, evaluate };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

const savedTask = { id: 'content', url: 'https://www.threads.com/@example/post/abc', status: 'done', count: 3, bytes: 10,
  documentFile: 'C:\\downloads\\body.txt', textCount: 1, mediaCount: 2 };
async function restored(task = savedTask, overrides = {}) {
  const h = harness('renderer.js', { getTasks: async () => [task], ...overrides }); await settle(); return h;
}
const card = h => h.elements.get('tasks').children[0];
const bodyButton = h => card(h).querySelector('.right').children.find(b => b.textContent === '본문');
for (const state of ['done', 'partial', 'canceled']) {
  test(state + ' 복원 카드의 본문 버튼은 저장 경로를 열고 파일 수를 분리한다', async () => {
    const opened = []; const h = await restored({ ...savedTask, status: state }, { openPostText: async file => opened.push(file) });
    const button = bodyButton(h); assert.ok(button, '본문 버튼'); await button.onclick();
    assert.deepEqual(opened, [savedTask.documentFile]);
    assert.equal(card(h).querySelector('.cnt').textContent, '미디어 2 · 본문 1');
    assert.equal(h.evaluate('taskList[0].documentFile'), savedTask.documentFile);
    assert.equal(h.evaluate('taskList[0].textCount'), 1); assert.equal(h.evaluate('taskList[0].mediaCount'), 2);
  });
}
test('여러 본문은 첫 본문 안내와 기존 폴더 버튼을 함께 제공한다', async () => {
  const shown = []; const h = await restored({ ...savedTask, textCount: 5, count: 7, file: 'C:/downloads/media.jpg' }, { showItem: file => shown.push(file) });
  assert.match(bodyButton(h)?.title || '', /첫.*본문/);
  const folder = card(h).querySelector('.right').children.find(b => b.title === '폴더 열기');
  assert.ok(folder); folder.onclick(); assert.deepEqual(shown, ['C:/downloads/media.jpg']);
});
test('문서 없는 기존 기록은 본문 버튼 없이 종전 미디어 카운트를 유지한다', async () => {
  const h = await restored({ id: 'old', url: savedTask.url, status: 'done', count: 2 });
  assert.equal(bodyButton(h), undefined); assert.match(card(h).querySelector('.cnt').textContent, /2p/);
});
test('본문 0도 명확히 표시하며 미디어 수가 없으면 전체 파일 수에서 본문을 뺀다', async () => {
  const h = await restored({ ...savedTask, textCount: 0 });
  assert.equal(card(h).querySelector('.cnt').textContent, '미디어 2 · 본문 0');
  const h2 = await restored({ ...savedTask, mediaCount: undefined });
  assert.equal(card(h2).querySelector('.cnt').textContent, '미디어 2 · 본문 1');
});

for (const result of [{ ok: true }, { ok: false }, { ok: false, canceled: true }]) {
  test('다운로드 결과 본문 메타데이터를 보존한다: ' + JSON.stringify(result), async () => {
    const h = await restored({ id: 'content', url: savedTask.url, status: 'downloading', count: 0 }, {
      download: async () => ({ ...result, count: 3, bytes: 10, documentFile: savedTask.documentFile, textCount: 1, mediaCount: 2 }),
    });
    await h.evaluate('runOne(taskList[0])');
    assert.equal(h.evaluate('taskList[0].documentFile'), savedTask.documentFile);
    assert.equal(h.evaluate('taskList[0].textCount'), 1); assert.equal(h.evaluate('taskList[0].mediaCount'), 2);
    assert.ok(bodyButton(h)); assert.equal(card(h).querySelector('.cnt').textContent, '미디어 2 · 본문 1');
  });
}
test('재시도 대기부터 이전 문서와 카운터를 비우며 실패해도 되살리지 않는다', async () => {
  let settings;
  const h = await restored(savedTask, { getSettings: () => new Promise(resolve => { settings = resolve; }), download: async () => ({ ok: false, count: 0, bytes: 0 }) });
  h.evaluate('startOne(taskList[0])');
  assert.ok(!h.evaluate('taskList[0].documentFile')); assert.ok(!h.evaluate('taskList[0].textCount')); assert.ok(!h.evaluate('taskList[0].mediaCount'));
  assert.equal(bodyButton(h), undefined);
  settings({ parallel: 1 }); await settle(); await settle();
  assert.equal(bodyButton(h), undefined); assert.equal(h.evaluate('taskList[0].status'), 'fail');
});
for (const failure of ['reject', 'throw', 'result', 'missing']) {
  test('본문 열기 ' + failure + ' 실패는 알림으로 처리한다', async () => {
    const overrides = failure === 'missing' ? {} : { openPostText: failure === 'reject' ? async () => { throw Error('거부'); }
      : failure === 'throw' ? () => { throw Error('동기 오류'); } : async () => ({ ok: false, error: '파일 없음' }) };
    const h = await restored(savedTask, overrides); assert.ok(bodyButton(h));
    await assert.doesNotReject(async () => bodyButton(h).onclick());
    assert.equal(h.alerts.length, 1); assert.match(h.alerts[0], /본문.*열지 못/);
  });
}

test('갤러리 본문은 img 대신 안전한 텍스트 타일이며 클릭하면 본문을 연다', async () => {
  const opened = []; const name = '<img src=x onerror=bad()>.txt';
  const h = await restored(savedTask, { listGallery: async () => [{ path: savedTask.documentFile, name, isText: true }], openPostText: async p => opened.push(p) });
  await h.evaluate('renderGallery()'); const tile = h.elements.get('grid').children[0];
  assert.doesNotMatch(tile.innerHTML, /<img/); assert.match(tile.innerHTML, /본문/);
  assert.equal(tile.querySelector('.cap').textContent, name); assert.ok(!tile.innerHTML.includes(name));
  await tile.onclick(); assert.deepEqual(opened, [savedTask.documentFile]);
  assert.equal(h.elements.get('gallery-count').textContent, '1개');
});
test('갤러리 기존 이미지와 영상은 썸네일 및 showItem 동작을 유지한다', async () => {
  const shown = []; const h = await restored(savedTask, { listGallery: async () => [
    { path: 'C:/downloads/photo.jpg', name: 'photo.jpg' }, { path: 'C:/downloads/video.mp4', name: 'video.mp4', isVideo: true },
  ], showItem: p => shown.push(p) });
  await h.evaluate('renderGallery()'); const tiles = h.elements.get('grid').children;
  assert.match(tiles[0].innerHTML, /<img/); assert.match(tiles[1].innerHTML, /vthumb/); assert.doesNotMatch(tiles[1].innerHTML, /<img/);
  tiles.forEach(tile => tile.onclick()); assert.deepEqual(shown, ['C:/downloads/photo.jpg', 'C:/downloads/video.mp4']);
});
test('본문 갤러리 클릭 실패도 알림 처리하고 API 없는 환경의 렌더도 유지한다', async () => {
  const h = await restored(savedTask, { listGallery: async () => [{ path: savedTask.documentFile, name: 'body.txt', isText: true }] });
  await h.evaluate('renderGallery()');
  await assert.doesNotReject(async () => h.elements.get('grid').children[0].onclick());
  assert.equal(h.alerts.length, 1); assert.match(h.alerts[0], /본문.*열지 못/);
});
