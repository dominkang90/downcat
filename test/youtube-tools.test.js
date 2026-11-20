'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createToolManager, TOOL_SPECS, toolsFor, DAY } = require('../tools');
const { makeZip, startFakeGithub, sha256 } = require('./helpers');

const ZIP = 'deno-x86_64-pc-windows-msvc.zip';
const SUMS = ZIP + '.sha256sum';
const powershell = (hash, name = ZIP) => `Algorithm : SHA256\r\nHash : ${hash.toUpperCase()}\r\nPath : C:\\a\\deno\\deno\\target\\release\\${name}\r\n`;
let gh, dirs;
test.beforeEach(async () => { gh = await startFakeGithub(); dirs = []; });
test.afterEach(() => { gh.close(); for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
function release(v = 1, options = {}) {
  const zip = makeZip(options.files || { 'denort.exe': Buffer.from('not deno'), 'deno.exe': Buffer.from(`fake deno v${v}`) });
  const rel = { tag_name: `v2.9.${7 + v}`, assets: [
    { name: 'denort-x86_64-pc-windows-msvc.zip', data: Buffer.from('not deno'), digest: true },
    { name: 'deno-aarch64-pc-windows-msvc.zip', data: Buffer.from('arm64'), digest: true },
    { name: ZIP, data: zip, digest: true },
    { name: SUMS, data: Buffer.from(powershell(sha256(zip))) },
  ] };
  gh.releases['denoland/deno'] = rel;
  return rel;
}
function mk(extra = {}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downcat-deno-test-'));
  dirs.push(binDir);
  let clock = Date.parse('2026-11-11T00:00:00Z');
  const m = createToolManager({ binDir, enabled: true, apiBase: gh.base,
    order: ['deno'], now: () => clock, ...extra });
  return { m, binDir, advance: ms => { clock += ms; },
    has: f => fs.existsSync(path.join(binDir, f)), read: f => fs.readFileSync(path.join(binDir, f), 'utf8') };
}

test('Deno: official Windows x64 ZIP is verified and root deno.exe alone is installed', async () => {
  release();
  const { m, read, has, binDir } = mk();
  assert.deepEqual(await m.checkAll(), [{ name: 'deno', result: 'installed' }]);
  assert.equal(read('deno.exe'), 'fake deno v1');
  assert.equal(has('denort.exe'), false);
  assert.equal(gh.hits.dl[ZIP], 1);
  assert.equal(gh.hits.dl[SUMS], 1);
  assert.equal(gh.hits.dl['denort-x86_64-pc-windows-msvc.zip'], undefined);
  assert.equal(m.snapshot()[0].status, 'ok');
  const state = JSON.parse(read('tools.json')).deno;
  assert.equal(state.version, 'v2.9.8');
  assert.equal(state.sha256, sha256(gh.releases['denoland/deno'].assets[2].data));
  assert.deepEqual(fs.readdirSync(path.join(binDir, '.downcat-tmp')), []);
});

test('Deno specification: exact official asset, root executable and ytdlp dependencies', () => {
  assert.equal(TOOL_SPECS.deno.repo, 'denoland/deno');
  assert.equal(TOOL_SPECS.deno.asset.test(ZIP), true);
  for (const name of ['denort-x86_64-pc-windows-msvc.zip', 'deno-aarch64-pc-windows-msvc.zip', ZIP + '.sha256sum', 'prefix-' + ZIP]) {
    assert.equal(TOOL_SPECS.deno.asset.test(name), false, name);
  }
  const match = TOOL_SPECS.deno.files['deno.exe'];
  assert.equal(match.test('deno.exe'), true);
  assert.equal(match.test('folder/deno.exe'), true);
  assert.equal(match.test('denort.exe'), false);
  assert.equal(match.test('not-deno.exe'), false);
  assert.deepEqual(toolsFor('ytdlp'), ['ytdlp', 'deno', 'ffmpeg', 'gallerydl']);
  assert.deepEqual(toolsFor('gallerydl'), ['gallerydl']);
  assert.deepEqual(toolsFor('aria2'), ['aria2']);
  for (const engine of ['threads', 'x', 'telegram']) assert.deepEqual(toolsFor(engine), []);
  assert.equal(toolsFor('unknown'), undefined);
  const { m } = mk({ order: undefined });
  assert.deepEqual(m.snapshot().map(t => t.name), ['ytdlp', 'deno', 'gallerydl', 'aria2', 'ffmpeg']);
});

test('Deno: a PowerShell checksum alone can verify the ZIP without GitHub digest', async () => {
  const rel = release(); rel.assets[2].digest = false;
  const { m, read } = mk();
  assert.equal((await m.checkAll())[0].result, 'installed');
  assert.equal(read('deno.exe'), 'fake deno v1');
});

test('Deno: missing checksum file can use the GitHub SHA256 digest', async () => {
  const rel = release(); rel.assets.pop();
  const { m } = mk();
  assert.equal((await m.checkAll())[0].result, 'installed');
});

test('Deno: GNU checksum remains supported', async () => {
  const rel = release();
  rel.assets[3].data = Buffer.from(`${sha256(rel.assets[2].data).toUpperCase()} *${ZIP}\r\n`);
  const { m } = mk();
  assert.equal((await m.checkAll())[0].result, 'installed');
});

for (const [label, sums] of [
  ['wrong basename', h => powershell(h, 'denort-x86_64-pc-windows-msvc.zip')],
  ['suffix basename', h => powershell(h, 'prefix-' + ZIP)],
  ['wrong architecture', h => powershell(h, 'deno-aarch64-pc-windows-msvc.zip')],
  ['wrong algorithm', h => powershell(h).replace('SHA256', 'SHA512')],
  ['missing path', h => `Algorithm : SHA256\nHash : ${h}\n`],
  ['short hash', h => powershell(h.slice(1))],
  ['duplicate record', h => powershell(h) + powershell(h)],
  ['extra hash', h => powershell(h) + `Hash : ${'a'.repeat(64)}\n`],
]) {
  test(`Deno: malformed PowerShell checksum fails closed despite valid digest (${label})`, async () => {
    const rel = release(); rel.assets[3].data = Buffer.from(sums(sha256(rel.assets[2].data)));
    const { m, has } = mk();
    const [r] = await m.checkAll();
    assert.equal(r.result, 'error');
    assert.match(r.error, /해시 목록/);
    assert.equal(has('deno.exe'), false);
    assert.equal(gh.hits.dl[ZIP], undefined, 'invalid checksum must stop before archive download');
  });
}

test('Deno: checksum and GitHub digest conflicts stop before download', async () => {
  const rel = release(); rel.assets[2].digest = 'sha256:' + 'a'.repeat(64);
  const { m, has } = mk();
  const [r] = await m.checkAll();
  assert.equal(r.result, 'error');
  assert.match(r.error, /해시 출처끼리 값이 달라서/);
  assert.equal(has('deno.exe'), false);
  assert.equal(gh.hits.dl[ZIP], undefined);
});

test('Deno: no hash source means no archive download or installation', async () => {
  const rel = release(); rel.assets[2].digest = false; rel.assets.pop();
  const { m, has } = mk();
  const [r] = await m.checkAll();
  assert.equal(r.result, 'error');
  assert.match(r.error, /원본 해시를 구할 곳이 없어/);
  assert.equal(has('deno.exe'), false);
  assert.equal(gh.hits.dl[ZIP], undefined);
  assert.equal(m.isReady(toolsFor('ytdlp')), true);
});

test('Deno: downloaded hash mismatch cannot install or leave staged files', async () => {
  const rel = release();
  rel.assets[2].digest = false;
  rel.assets[3].data = Buffer.from(powershell('0'.repeat(64)));
  const { m, has, binDir } = mk();
  const [r] = await m.checkAll();
  assert.equal(r.result, 'error');
  assert.match(r.error, /해시가 원본과 달라서/);
  assert.equal(has('deno.exe'), false);
  assert.equal(has('tools.json'), false);
  assert.deepEqual(fs.readdirSync(path.join(binDir, '.downcat-tmp')), []);
});

test('Deno v2.9.8 official PowerShell checksum and digest agree but reject fake ZIP bytes', async () => {
  const rel = release();
  const official = 'cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf';
  rel.assets[2].digest = 'sha256:' + official;
  rel.assets[3].data = Buffer.from(powershell(official));
  const { m, has } = mk();
  const [r] = await m.checkAll();
  assert.match(r.error, /받은 파일의 해시가 원본과 달라서/);
  assert.equal(gh.hits.dl[ZIP], 1, 'both official hash sources parsed successfully');
  assert.equal(has('deno.exe'), false);
});

test('Deno: denort-only ZIP is not mistaken for deno.exe and failed install releases waiting jobs', async () => {
  release(1, { files: { 'denort.exe': Buffer.from('wrong exe') } });
  gh.hold(ZIP);
  const { m, has } = mk();
  const all = m.checkAll();
  let ready = false;
  const job = m.whenReady(toolsFor('ytdlp')).then(() => { ready = true; });
  assert.equal(m.isReady(toolsFor('ytdlp')), false);
  await waitFor(() => gh.hits.dl[ZIP] === 1);
  assert.equal(ready, false);
  gh.release(ZIP);
  const [r] = await all;
  await job;
  assert.equal(r.result, 'error');
  assert.match(r.error, /압축 안에서.*deno\.exe/);
  assert.equal(has('deno.exe'), false);
  assert.equal(has('denort.exe'), false);
  assert.equal(ready, true);
  assert.equal(m.isReady(), true);
  assert.equal(m.snapshot()[0].status, 'error');
});

async function waitFor(check) {
  const until = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= until) throw new Error('local fixture did not reach expected state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('Deno: new installation blocks ytdlp jobs until verified installation completes', async () => {
  release(); gh.hold(ZIP);
  const { m, has } = mk();
  const all = m.checkAll();
  let started = false;
  const job = m.whenReady(toolsFor('ytdlp')).then(() => { started = true; assert.equal(has('deno.exe'), true); });
  await waitFor(() => gh.hits.dl[ZIP] === 1);
  assert.equal(started, false);
  assert.equal(m.snapshot()[0].status, 'downloading');
  assert.equal(m.isReady(toolsFor('threads')), true);
  gh.release(ZIP);
  assert.equal((await all)[0].result, 'installed');
  await job;
  assert.equal(started, true);
});

test('Deno: daily update keeps existing runtime usable during download and installs new version', async () => {
  release();
  const { m, read, advance } = mk();
  await m.checkAll();
  release(2); advance(DAY + 1); gh.hold(ZIP);
  const all = m.checkAll();
  await waitFor(() => gh.hits.dl[ZIP] === 2);
  assert.equal(m.snapshot()[0].status, 'downloading');
  assert.equal(m.isReady(toolsFor('ytdlp')), true);
  assert.equal(read('deno.exe'), 'fake deno v1');
  gh.release(ZIP);
  assert.equal((await all)[0].result, 'updated');
  assert.equal(read('deno.exe'), 'fake deno v2');
  assert.equal(m.snapshot()[0].version, 'v2.9.9');
});

test('Deno: failed update preserves existing executable and releases readiness', async () => {
  release();
  const { m, read, advance } = mk();
  await m.checkAll();
  const rel = release(2); rel.assets[2].digest = false;
  rel.assets[3].data = Buffer.from(powershell('0'.repeat(64)));
  advance(DAY + 1);
  const [r] = await m.checkAll();
  assert.equal(r.result, 'error');
  assert.equal(read('deno.exe'), 'fake deno v1');
  assert.equal(m.snapshot()[0].status, 'ok');
  assert.equal(m.snapshot()[0].version, 'v2.9.8');
  assert.equal(m.isReady(toolsFor('ytdlp')), true);
});

test('Deno: same release and within-day checks do not re-download', async () => {
  release();
  const { m, advance } = mk();
  await m.checkAll();
  assert.equal((await m.checkAll())[0].result, 'skipped');
  assert.equal(gh.hits.api, 1);
  advance(DAY + 1);
  assert.equal((await m.checkAll())[0].result, 'latest');
  assert.equal(gh.hits.dl[ZIP], 1);
  assert.equal(gh.hits.api, 2);
  assert.equal(TOOL_SPECS.deno.sameAsLocal('2.9.8', { tag_name: 'v2.9.8' }), true);
  assert.equal(TOOL_SPECS.deno.sameAsLocal('2.9.7', { tag_name: 'v2.9.8' }), false);
});

test('Deno: latest release without exact Windows x64 asset is rejected', async () => {
  const rel = release(); rel.assets = rel.assets.filter(a => a.name !== ZIP);
  const { m, has } = mk();
  const [r] = await m.checkAll();
  assert.equal(r.result, 'error');
  assert.match(r.error, /받을 파일을 못 찾았어요/);
  assert.equal(has('deno.exe'), false);
  assert.deepEqual(gh.hits.dl, {});
});
