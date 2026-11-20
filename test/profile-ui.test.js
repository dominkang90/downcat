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
  const callbacks = {}; const patches = [];
  const api = {
    getSettings: async () => ({ parallel: 1 }), setSettings: patch => patches.push(patch),
    getCookieFile: async () => '', getTasks: async () => [], toolsStatus: async () => [],
    onToolsChanged() {}, onJobEvent: cb => { callbacks.job = cb; }, onClipboardUrl() {}, onBridgeJob() {},
    download: async () => ({ ok: true, count: 1, bytes: 1 }), ...overrides,
  };
  const document = { getElementById: id => elements.get(id), createElement: tag => new Element(tag), addEventListener() {} };
  const context = vm.createContext({ window: { api }, document, URL, console, setTimeout() {},
    localStorage: { getItem: () => null, setItem() {} }, crypto: { randomUUID: () => 'new' }, alert() {}, confirm: () => false });
  const evaluate = source => vm.runInContext(source, context);
  evaluate(fs.readFileSync(path.join(root, file), 'utf8'));
  return { elements, callbacks, patches, evaluate };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const task = { id: 'profile', url: 'https://www.threads.com/@example', status: 'downloading', count: 0, bytes: 0 };
async function renderer(overrides) {
  const h = harness('renderer.js', overrides); await settle();
  h.evaluate('taskList = ' + JSON.stringify([task]) + '; render();'); return h;
}
const status = h => h.elements.get('tasks').children[0].querySelector('.statusText').textContent;
test('Threads 설정은 게시물 기준 20/50/100/전체와 공개 목록 한계를 안내한다', () => {
  const select = settingsHtml.match(/<select\b[^>]*id="threadsProfileLimit"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, 'threadsProfileLimit 선택창');
  assert.deepEqual([...select[1].matchAll(/value="(\d+)"/g)].map(m => Number(m[1])), [20, 50, 100, 0]);
  assert.match(select[1], /value="50"\s+selected/);
  assert.match(settingsHtml, /스레드|Threads/); assert.match(settingsHtml, /게시물/); assert.match(settingsHtml, /파일 개수.*아/);
  assert.match(settingsHtml, /사이트 표시 순서/); assert.match(settingsHtml, /텍스트만.*본문 파일로 저장/);
  assert.match(fs.readFileSync(path.join(root, 'renderer.js'), 'utf8'), /class="stat profileCount"/);
  assert.match(settingsHtml, /공개 목록 끝까지/); assert.match(settingsHtml, /완전 수집.*보장.*아/);
});
for (const value of [undefined, null, 0, 20, 50, 100]) {
  test('프로필 설정 읽기: ' + String(value), async () => {
    const h = harness('settings.js', { getSettings: async () => ({ threadsProfileLimit: value }) }); await settle();
    assert.equal(h.elements.get('threadsProfileLimit')?.value, String(value ?? 50));
  });
}
test('프로필 설정 변경은 숫자로 저장하고 전체 0을 유지한다', async () => {
  const h = harness('settings.js'); await settle(); const el = h.elements.get('threadsProfileLimit'); assert.ok(el);
  for (const value of [20, 50, 100, 0]) { el.value = String(value); el.onchange(); assert.equal(h.patches.at(-1).threadsProfileLimit, value); }
});
for (const phase of ['collecting', 'downloading']) {
  test('프로필 ' + phase + ' 메시지는 텍스트로 표시되고 다시 그려도 유지된다', async () => {
    const h = await renderer(); const message = '<b>게시물 목록 수집 중</b>';
    h.callbacks.job({ jobId: 'profile', type: 'profile', phase, discovered: 12, total: 12, current: 3, message });
    assert.equal(status(h), message); h.evaluate('render()'); assert.equal(status(h), message);
    assert.equal(h.evaluate('taskList[0].count'), 0, '게시물 개수를 파일 개수에 넣지 않음');
  });
}
test('프로필 게시물 진행과 일반 파일 개수는 서로 덮어쓰지 않는다', async () => {
  const h = await renderer();
  h.callbacks.job({ jobId: 'profile', type: 'profile', phase: 'downloading', discovered: 12, total: 12, current: 0, message: '게시물 받는 중' });
  const li = h.elements.get('tasks').children[0];
  assert.match(li.querySelector('.profileCount').textContent, /게시물.*0\s*\/\s*12/);
  h.callbacks.job({ jobId: 'profile', type: 'progress', files: 2 });
  assert.match(li.querySelector('.cnt').textContent, /2p/); assert.match(li.querySelector('.profileCount').textContent, /0\s*\/\s*12/);
  h.evaluate('render()'); assert.match(h.elements.get('tasks').children[0].querySelector('.profileCount').textContent, /0\s*\/\s*12/);
});
test('수집 중 게시물 개수는 전체 수를 모를 때도 별도로 표시한다', async () => {
  const h = await renderer();
  h.callbacks.job({ jobId: 'profile', type: 'profile', phase: 'collecting', discovered: 7, message: '수집 중' });
  assert.match(h.elements.get('tasks').children[0].querySelector('.profileCount').textContent, /게시물.*7/);
});
for (const [name, result, label] of [
  ['done', { ok: true, count: 4 }, /완료/], ['partial', { ok: false, count: 2 }, /일부 받음/], ['fail', { ok: false, count: 0 }, /실패/],
]) {
  test(name + ' 결과 summary를 작업에 복사하고 상태와 함께 표시한다', async () => {
    const summary = '<주의> 게시물 3개 확인 · 파일 4개';
    const h = await renderer({ download: async () => ({ ...result, bytes: 10, summary }) });
    await h.evaluate('runOne(taskList[0])');
    assert.equal(h.evaluate('taskList[0].summary'), summary); assert.match(status(h), label); assert.ok(status(h).includes(summary));
    assert.doesNotMatch(status(h), /사이트가 막음/);
  });
}
test('서버에서 복원한 작업 summary도 완료/부분/실패 상태와 함께 표시한다', async () => {
  for (const state of ['done', 'partial', 'fail']) {
    const h = harness('renderer.js', { getTasks: async () => [{ ...task, status: state, summary: '공개 목록 끝에서 종료' }] });
    await settle(); assert.ok(status(h).includes('공개 목록 끝에서 종료')); assert.doesNotMatch(status(h), /사이트가 막음/);
  }
});
test('다시 받기를 누르면 이전 summary와 프로필 진행 표시를 지운다', async () => {
  const h = await renderer({ getSettings: () => new Promise(() => {}) });
  h.evaluate('taskList[0].summary = "지난 결과"; taskList[0]._profile = { message: "지난 진행", discovered: 9 }; startOne(taskList[0]);');
  assert.ok(!h.evaluate('taskList[0].summary')); assert.ok(!h.evaluate('taskList[0]._profile'));
  assert.doesNotMatch(status(h), /지난/);
});

test('필터로 숨겨진 프로필 카드도 새 진행 메시지를 기억한다', async () => {
  const h = await renderer(); h.elements.get('filter').value = '찾을 수 없는 주소'; h.evaluate('render()');
  assert.equal(h.elements.get('tasks').children.length, 0);
  h.callbacks.job({ jobId: 'profile', type: 'profile', phase: 'collecting', discovered: 9, message: '숨겨진 동안 9개 확인' });
  h.elements.get('filter').value = ''; h.evaluate('render()');
  assert.equal(status(h), '숨겨진 동안 9개 확인');
});
test('전체 0개와 현재 0개도 프로필 카운터에 그대로 표시한다', async () => {
  const h = await renderer();
  h.callbacks.job({ jobId: 'profile', type: 'profile', phase: 'downloading', discovered: 0, total: 0, current: 0, message: '저장할 게시물 없음' });
  assert.match(h.elements.get('tasks').children[0].querySelector('.profileCount').textContent, /게시물.*0\/0/);
});
