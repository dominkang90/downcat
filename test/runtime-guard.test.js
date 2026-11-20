'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const required = [...new Set([...renderer.matchAll(/window\.api\.(\w+)\(/g)].map(m => m[1]))];
class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.value = ''; this.parts = {}; this.classList = { toggle() {}, add() {}, remove() {} }; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener() {}
  appendChild(el) { this.children.push(el); if (el.tagName === 'SCRIPT') this.onScript?.(el); return el; }
  querySelector(selector) { return this.parts[selector] ||= new Element(); }
  set innerHTML(value) { this.children = []; this.parts = {}; this._html = value; }
  get innerHTML() { return this._html || ''; }
  focus() {}
}
function harness(api) {
  const elements = new Map();
  for (const m of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const el = new Element(m[1]); el.id = m[2]; el.hidden = /\bhidden\b/.test(m[0]); elements.set(el.id, el);
  }
  elements.get('sort').value = 'recent';
  const body = new Element('body'); const head = new Element('head'); const scripts = []; const alerts = [];
  body.onScript = head.onScript = el => scripts.push(el);
  const document = {
    body, head, getElementById: id => elements.get(id), createElement: tag => new Element(tag), addEventListener() {},
    querySelectorAll: () => [...elements.values()].filter(el => /^(BUTTON|INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
  };
  const window = { api };
  const context = vm.createContext({ window, document, URL, localStorage: { getItem: () => null, setItem() {} }, crypto: { randomUUID: () => 'id' }, alert: text => alerts.push(text), confirm: () => false, console });
  function evaluate(source) { return vm.runInContext(source, context); }
  function boot() {
    for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)) evaluate(fs.readFileSync(path.join(root, match[1]), 'utf8'));
  }
  return { elements, document, scripts, alerts, evaluate, boot };
}
function goodApi(overrides = {}) {
  const api = Object.fromEntries(required.map(name => [name, () => {}]));
  return Object.assign(api, { getCookieFile: async () => '', getTasks: async () => [], toolsStatus: async () => [], getSettings: async () => ({ parallel: 1 }), openLogin: async () => ({ ok: false }), download: async () => ({ ok: true, count: 1, bytes: 1 }) }, overrides);
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('HTML without preload blocks renderer, disables every control and shows app launch guidance first', async () => {
  const h = harness(undefined); h.boot(); await settle();
  assert.equal(h.scripts.length, 0);
  for (const el of h.document.querySelectorAll('button, input, textarea, select')) assert.equal(el.disabled, true, el.id);
  const notice = h.elements.get('runtime-notice'); assert.ok(notice); assert.equal(notice.hidden, false);
  assert.match(html, /<body>\s*<[^>]+id="runtime-notice"/);
  assert.match(html, /받냥이\.bat/); assert.match(html, /브라우저/); assert.match(html, /앱/);
});
test('every required missing or non-function bridge method prevents renderer loading', () => {
  for (const name of required) {
    for (const value of [undefined, true]) {
      const api = goodApi({ [name]: value }); const h = harness(api); h.boot();
      assert.equal(h.scripts.length, 0, name); assert.equal(h.elements.get('go').disabled, true, name);
    }
  }
});
test('valid bridge loads exactly one external classic renderer without changing renderer scope', async () => {
  const h = harness(goodApi()); h.boot();
  assert.equal(h.scripts.length, 1); assert.equal(h.scripts[0].src, 'renderer.js');
  assert.ok(!h.scripts[0].type || h.scripts[0].type === 'text/javascript');
  assert.equal(h.elements.get('runtime-notice').hidden, true); assert.equal(h.elements.get('go').disabled, false);
  h.evaluate(renderer); await settle(); assert.equal(h.elements.get('count').textContent, '0개');
});
test('login rejection or synchronous failure restores text and button with a friendly message', async () => {
  for (const openLogin of [async () => { throw new Error('secret IPC error'); }, () => { throw new Error('secret IPC error'); }]) {
    const h = harness(goodApi({ openLogin })); h.evaluate(renderer); await settle();
    const button = h.elements.get('instalogin'); button.textContent = '로그인';
    await assert.doesNotReject(button.onclick());
    assert.equal(button.disabled, false); assert.equal(button.textContent, '로그인');
    assert.match(h.alerts[0], /로그인.*다시/); assert.doesNotMatch(h.alerts[0], /secret|IPC/);
  }
});
test('login stays disabled while pending and recovers even when cookie settings reject', async () => {
  let resolve; const pending = new Promise(r => { resolve = r; });
  const h = harness(goodApi({ openLogin: () => pending, getCookieFile: async () => '' })); h.evaluate(renderer); await settle();
  const button = h.elements.get('instalogin'); button.textContent = '로그인';
  const operation = button.onclick(); assert.equal(button.disabled, true);
  resolve({ ok: true }); await operation; assert.equal(button.disabled, false); assert.equal(button.textContent, '로그인');
  h.evaluate('window.api.getCookieFile = async () => { throw new Error("private path"); }');
  await assert.doesNotReject(button.onclick()); assert.equal(button.disabled, false); assert.equal(button.textContent, '로그인'); assert.equal(h.alerts.length, 1);
});
test('settings rejection fails and drains all queued jobs, preserves canceled jobs, then permits retry', async () => {
  const h = harness(goodApi({ getSettings: async () => { throw new Error('secret settings error'); } })); h.evaluate(renderer); await settle();
  await assert.doesNotReject(h.evaluate('(async () => { taskList = [{ id: "a", url: "https://example.com/a", status: "queued" }, { id: "b", url: "https://example.com/b", status: "queued" }, { id: "c", url: "https://example.com/c", status: "canceled" }]; queue.push(...taskList); render(); await pump(); })()'));
  assert.equal(h.evaluate('queue.length'), 0); assert.equal(h.evaluate('running'), 0);
  assert.equal(h.evaluate('taskList[0].status'), 'fail'); assert.equal(h.evaluate('taskList[1].status'), 'fail'); assert.equal(h.evaluate('taskList[2].status'), 'canceled');
  assert.match(h.evaluate('taskList[0].error'), /설정.*다시/); assert.doesNotMatch(h.evaluate('taskList[0].error'), /secret/);
  assert.match(h.evaluate('els.a.querySelector(".statusText").textContent'), /실패.*설정/);
  h.evaluate('window.api.getSettings = async () => ({ parallel: 1 }); startOne(taskList[0]);'); await settle(); await settle();
  assert.equal(h.evaluate('taskList[0].status'), 'done'); assert.equal(h.evaluate('running'), 0);
});

test('null bridge and renderer load errors show the same safe app guidance', () => {
  const missing = harness(null); missing.boot();
  assert.equal(missing.scripts.length, 0); assert.equal(missing.elements.get('runtime-notice').hidden, false);
  const h = harness(goodApi()); h.boot(); h.scripts[0].onerror();
  assert.equal(h.elements.get('runtime-notice').hidden, false);
  for (const control of h.document.querySelectorAll('button, input, textarea, select')) assert.equal(control.disabled, true);
});
test('guard is external, isolated and requires no CSP relaxation', () => {
  const guard = fs.readFileSync(path.join(root, 'runtime-guard.js'), 'utf8');
  assert.match(html, /<script src="runtime-guard.js"><\/script>/);
  assert.doesNotMatch(html, /<script src="renderer.js"/);
  assert.doesNotMatch(guard, /\beval\s*\(|new Function|innerHTML|document\.write/);
});
