'use strict';
// 받냥이 도구 관리자: yt-dlp · gallery-dl · ffmpeg · aria2 를 bin 폴더에 자동으로 깔고 최신으로 유지한다.
//
// 원칙
//  1) 원본과 같은지 SHA-256 해시로 확인한 다음에만 설치한다. 해시를 구할 곳이 없으면 아예 설치하지 않는다.
//     해시 출처(우선순위): 배포처가 올린 해시 목록 파일 → GitHub가 계산해 둔 파일 해시(digest) → 코드에 고정한 해시.
//     두 출처가 서로 다르면 설치하지 않는다.
//  2) 켤 때: 없는 도구는 바로 설치. 있는 도구는 하루 한 번 업데이트 확인(ffmpeg는 30일 — 아래 설명).
//  3) 없는 도구를 설치하는 동안 들어온 다운로드 작업은 설치가 끝날 때까지 기다린다(whenReady).
//     이미 있는 도구의 업데이트는 뒤에서 받고, 파일을 바꿔 끼우는 순간에만 잠깐 기다리게 한다.
//  4) 실행 중인 exe도 Windows에서 "이름 바꾸기"는 되므로, 옛 파일을 .old로 비키고 새 파일을 넣는다(작업 안 끊김).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { extractFiles } = require('./zip');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// 도구별 설정. repo = GitHub 저장소, asset = 받을 파일 이름, files = bin에 둘 파일.
const TOOL_SPECS = {
  ytdlp: {
    label: 'yt-dlp', repo: 'yt-dlp/yt-dlp',
    asset: /^yt-dlp\.exe$/,
    files: { 'yt-dlp.exe': null },                 // null = 받은 파일 자체가 실행파일
    sums: 'SHA2-256SUMS',                           // yt-dlp가 릴리스에 올리는 해시 목록
    interval: DAY,
    versionArgs: ['--version'],                     // 예: 2026.10.10 (= 릴리스 태그)
    sameAsLocal: (local, release) => local === release.tag_name,
  },
  gallerydl: {
    label: 'gallery-dl', repo: 'gdl-org/builds',    // gallery-dl 공식 빌드 저장소(README 안내와 같은 곳)
    asset: /^gallery-dl_windows\.exe$/,
    files: { 'gallery-dl.exe': null },
    sums: null,                                     // 해시 목록이 없어 GitHub digest를 쓴다
    interval: DAY,
    // 매일 날짜 태그로 다시 빌드되므로, 릴리스 설명(어떤 커밋인지)이 바뀔 때만 새 버전으로 본다
    identity: (release) => release.body ? 'body:' + sha256(release.body).slice(0, 16) : release.tag_name,
  },
  ffmpeg: {
    label: 'ffmpeg', repo: 'yt-dlp/FFmpeg-Builds',  // 지금 쓰는 yt-dlp용 빌드 그대로
    asset: /^ffmpeg-master-latest-win64-gpl\.zip$/,
    files: { 'ffmpeg.exe': /\/bin\/ffmpeg\.exe$/i, 'ffprobe.exe': /\/bin\/ffprobe\.exe$/i },
    sums: 'checksums.sha256',
    // 이 빌드는 매일 새로 만들어져 버전 번호(N-127798-…-20261020)가 매일 바뀐다.
    // 매일 200MB를 받지 않도록 30일에 한 번만 비교하고, 빌드가 바뀌었을 때만 받는다.
    interval: 30 * DAY,
    versionArgs: ['-version'],
    identity: (_release, hash) => 'sha256:' + hash, // 빌드가 바뀌면 해시가 바뀐다
    // 태그가 늘 'latest'라서 빌드 날짜를 버전처럼 보여준다
    display: (release, asset) => {
      const d = String(asset.updated_at || release.published_at || '').slice(0, 10);
      return d ? '빌드 ' + d : '최신 빌드';
    },
    keepLegacy: true,                               // 원래 있던 ffmpeg는 바로 갈아끼우지 않는다(30일 뒤 비교)
  },
  aria2: {
    label: 'aria2', repo: 'aria2/aria2',
    asset: /^aria2-[\d.]+-win-64bit-build\d+\.zip$/,
    files: { 'aria2c.exe': /\/aria2c\.exe$/i },
    sums: null,
    // aria2는 해시 목록을 안 올린다. GitHub digest가 없을 때를 위해 확인해 둔 해시를 고정한다.
    pinned: { 'aria2-1.37.0-win-64bit-build1.zip': '67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288' },
    interval: DAY,
    versionArgs: ['--version'],                     // "aria2 version 1.37.0"
    sameAsLocal: (local, release) => local === release.tag_name.replace(/^release-/, ''),
    display: (release) => release.tag_name.replace(/^release-/, ''),
  },
};
const ORDER = ['ytdlp', 'gallerydl', 'aria2', 'ffmpeg']; // 작은 것부터(ffmpeg 200MB는 마지막)

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// "해시  파일이름" 형식(sha256sum 출력)에서 파일 이름의 해시를 찾는다
function parseSums(text, name) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (m && m[2].trim() === name) return m[1].toLowerCase();
  }
  return null;
}

class ToolManager extends EventEmitter {
  /**
   * opts.binDir   도구를 둘 폴더
   * opts.fetch    fetch 함수(Electron에선 net.fetch — 시스템 프록시를 따름)
   * opts.enabled  자동 설치를 켤지(기본: Windows에서만)
   * opts.specs    도구 설정(테스트에서 바꿔 끼움), opts.apiBase GitHub API 주소(테스트용)
   * opts.now      현재 시각 함수(테스트용)
   */
  constructor(opts = {}) {
    super();
    this.binDir = opts.binDir;
    this.fetch = opts.fetch || ((u, o) => fetch(u, o));
    this.enabled = opts.enabled != null ? opts.enabled : process.platform === 'win32';
    this.specs = opts.specs || TOOL_SPECS;
    this.order = opts.order || ORDER.filter(n => this.specs[n]);
    this.apiBase = opts.apiBase || 'https://api.github.com';
    this.now = opts.now || Date.now;
    this.stateFile = path.join(this.binDir, 'tools.json');
    this.tmpDir = path.join(this.binDir, '.downcat-tmp');
    this.live = {};        // 이름 → {status, percent, error, latest}
    this.blocking = new Set(); // 지금 작업을 기다리게 하는 도구들(새로 설치 중 / 파일 교체 중)
    this.waiters = [];
    this.running = null;   // 진행 중인 checkAll 약속
    this.timer = null;
    this.state = this._loadState();
    for (const n of this.order) this.live[n] = { status: this._hasFiles(n) ? 'ok' : 'missing' };
  }

  // ── 상태 ──
  _loadState() { try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; } }
  _saveState() {
    fs.mkdirSync(this.binDir, { recursive: true });
    const tmp = this.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }
  _hasFiles(name) { return Object.keys(this.specs[name].files).every(f => fs.existsSync(path.join(this.binDir, f))); }
  _set(name, patch) { Object.assign(this.live[name], patch); this.emit('change', this.snapshot()); }

  // 설정 창·메인 창이 보여줄 요약
  snapshot() {
    return this.order.map(n => {
      const st = this.state[n] || {};
      return {
        name: n, label: this.specs[n].label,
        status: this.enabled ? this.live[n].status : (this._hasFiles(n) ? 'ok' : 'manual'),
        version: st.version || null, latest: this.live[n].latest || null,
        percent: this.live[n].percent != null ? this.live[n].percent : null,
        error: this.live[n].error || null, checkedAt: st.checkedAt || null,
      };
    });
  }

  // ── 작업 대기 ──
  isReady(names) { return !(names || this.order).some(n => this.blocking.has(n)); }
  /** names의 도구가 설치·교체 중이면 끝날 때까지 기다린다(실패해도 끝나면 풀린다). */
  whenReady(names) {
    if (this.isReady(names)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ names, resolve }));
  }
  _block(name) { this.blocking.add(name); }
  _unblock(name) {
    this.blocking.delete(name);
    this.waiters = this.waiters.filter(w => { if (this.isReady(w.names)) { w.resolve(); return false; } return true; });
  }

  // ── 시작 ──
  /** 켤 때 한 번: 지난번 찌꺼기 정리 → 없는 도구 설치 + 기한 지난 도구 확인. 이후 1시간마다 기한 확인. */
  start() {
    if (!this.enabled) return Promise.resolve([]);
    this._cleanup();
    const p = this.checkAll({ force: false });
    this.timer = setInterval(() => { this.checkAll({ force: false }).catch(() => {}); }, HOUR);
    if (this.timer.unref) this.timer.unref();
    return p;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  _cleanup() {
    try { fs.rmSync(this.tmpDir, { recursive: true, force: true }); } catch {}
    let names = [];
    try { names = fs.readdirSync(this.binDir); } catch {}
    for (const f of names) if (/\.old-\d+$/.test(f)) { try { fs.rmSync(path.join(this.binDir, f), { force: true }); } catch {} }
  }

  /**
   * 모든 도구 확인. force=true면 기한과 상관없이 지금 확인([지금 모두 확인·업데이트] 버튼).
   * 반환: [{name, result:'installed'|'updated'|'latest'|'skipped'|'error', error?}]
   */
  checkAll({ force = false } = {}) {
    if (this.running) return this.running; // 이미 돌고 있으면 그 결과를 같이 기다린다
    // 없는 도구는 확인 시작 전에 미리 "설치 중"으로 막아 둔다 → 그 사이 들어온 작업이 기다리게
    for (const n of this.order) if (!this._hasFiles(n)) this._block(n);
    this.running = (async () => {
      const out = [];
      for (const n of this.order) {
        try { out.push({ name: n, result: await this.checkTool(n, { force }) }); }
        catch (e) {
          const msg = String((e && e.message) || e);
          this._set(n, { status: this._hasFiles(n) ? 'ok' : 'error', error: msg, percent: null });
          out.push({ name: n, result: 'error', error: msg });
        } finally { this._unblock(n); }
      }
      return out;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  // 로컬 exe의 버전 문자열(첫 줄에서 숫자 버전만). 실패하면 null.
  _localVersion(name) {
    const spec = this.specs[name];
    if (!spec.versionArgs) return Promise.resolve(null);
    const exe = path.join(this.binDir, Object.keys(spec.files)[0]);
    return new Promise((res) => execFile(exe, spec.versionArgs, { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return res(null);
      const first = String(stdout).split(/\r?\n/)[0] || '';
      const m = first.match(/(N-\d+-g[0-9a-f]+(?:-\d{8})?|\d+(?:\.\d+)+)/i);
      res(m ? m[1] : first.trim() || null);
    }));
  }

  async checkTool(name, { force = false } = {}) {
    const spec = this.specs[name];
    const have = this._hasFiles(name);
    let st = this.state[name];

    // 사용자가 손으로 넣었거나 예전 릴리스 ZIP에 들어 있던 도구(기록 없음): 버전만 읽어 기록해 둔다
    if (have && !st) {
      const local = await this._localVersion(name);
      st = this.state[name] = { version: local || '알 수 없음', id: null, legacy: true,
        checkedAt: spec.keepLegacy ? this.now() : 0 };
      this._saveState();
    }
    if (have && !force && st && this.now() - (st.checkedAt || 0) < spec.interval) {
      this._set(name, { status: 'ok', error: null, percent: null });
      return 'skipped';
    }

    this._set(name, { status: 'checking', error: null, percent: null });
    const release = await this._getJson(`${this.apiBase}/repos/${spec.repo}/releases/latest`);
    const asset = (release.assets || []).find(a => spec.asset.test(a.name));
    if (!asset) throw new Error(`${spec.label}: 최신 릴리스에서 받을 파일을 못 찾았어요`);
    const expected = await this._expectedHash(spec, release, asset);
    const id = spec.identity ? spec.identity(release, expected) : release.tag_name;
    const display = spec.display ? spec.display(release, asset) : release.tag_name;
    this._set(name, { latest: display });

    // 이미 최신이면 기록만 갱신
    const sameLegacy = !!(st && st.legacy && spec.sameAsLocal && spec.sameAsLocal(st.version, release));
    if (have && st && (st.id === id || sameLegacy)) {
      Object.assign(st, { id, version: sameLegacy ? display : st.version, checkedAt: this.now(), legacy: false });
      this._saveState();
      this._set(name, { status: 'ok', percent: null });
      return 'latest';
    }

    // 받기 → 해시 확인 → (ZIP이면) 풀기 → 바꿔 끼우기
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const dl = path.join(this.tmpDir, `${name}-${process.pid}-${this.now()}.download`);
    const staged = {};
    try {
      this._set(name, { status: 'downloading', percent: 0 });
      const got = await this._download(asset.browser_download_url, dl, (pct) => this._set(name, { percent: pct }));
      this._set(name, { status: 'verifying', percent: null });
      if (got !== expected) {
        throw new Error(`${spec.label}: 받은 파일의 해시가 원본과 달라서 설치하지 않았어요`);
      }
      for (const [file, match] of Object.entries(spec.files)) staged[file] = path.join(this.tmpDir, `${name}-${file}.new`);
      if (Object.values(spec.files).every(m => m === null)) {
        fs.renameSync(dl, staged[Object.keys(spec.files)[0]]);
      } else {
        this._set(name, { status: 'installing' });
        const wanted = {};
        for (const [file, match] of Object.entries(spec.files)) wanted[staged[file]] = match;
        await extractFiles(dl, wanted);
      }
      // 교체하는 순간만 작업을 잠깐 세운다(새로 설치하는 도구는 checkAll이 처음부터 막아 두었다)
      this._block(name);
      this._set(name, { status: 'installing' });
      try {
        for (const file of Object.keys(spec.files)) this._swap(staged[file], path.join(this.binDir, file));
      } finally { if (have) this._unblock(name); }
      this.state[name] = { version: display, id, sha256: expected, installedAt: this.now(), checkedAt: this.now() };
      this._saveState();
      this._set(name, { status: 'ok', percent: null, error: null });
      return have ? 'updated' : 'installed';
    } finally {
      try { fs.rmSync(dl, { force: true }); } catch {}
      for (const p of Object.values(staged)) { try { fs.rmSync(p, { force: true }); } catch {} }
    }
  }

  // 새 파일을 제자리에 넣는다. 옛 파일은 이름을 바꿔 비켜 두고(실행 중이어도 됨) 지울 수 있으면 지운다.
  _swap(src, dest) {
    let old = null;
    if (fs.existsSync(dest)) {
      old = `${dest}.old-${this.now()}`;
      fs.renameSync(dest, old);
    }
    try { fs.renameSync(src, dest); }
    catch (e) { if (old) { try { fs.renameSync(old, dest); } catch {} } throw e; }
    if (old) { try { fs.rmSync(old, { force: true }); } catch {} } // 실행 중이면 못 지움 → 다음 실행 때 정리
  }

  // 원본 해시 구하기. 출처가 둘 이상이면 서로 같아야 한다.
  async _expectedHash(spec, release, asset) {
    const found = [];
    if (spec.sums) {
      const sumsAsset = (release.assets || []).find(a => a.name === spec.sums);
      if (sumsAsset) {
        const h = parseSums(await this._getText(sumsAsset.browser_download_url), asset.name);
        if (h) found.push(['해시 목록', h]);
      }
    }
    if (typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest)) {
      found.push(['GitHub', asset.digest.slice(7).toLowerCase()]);
    }
    if (spec.pinned && spec.pinned[asset.name]) found.push(['고정값', spec.pinned[asset.name].toLowerCase()]);
    if (!found.length) throw new Error(`${spec.label}: 원본 해시를 구할 곳이 없어 설치하지 않았어요`);
    if (found.some(([, h]) => h !== found[0][1])) {
      throw new Error(`${spec.label}: 해시 출처끼리 값이 달라서 설치하지 않았어요 (${found.map(f => f[0]).join('·')})`);
    }
    return found[0][1];
  }

  async _getJson(url) {
    const res = await this.fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'downcat-tool-updater' },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 403 || res.status === 429) throw new Error('GitHub 확인 횟수 제한 — 1시간 뒤 자동으로 다시 확인해요');
    if (!res.ok) throw new Error(`업데이트 확인 실패 (HTTP ${res.status})`);
    return res.json();
  }
  async _getText(url) {
    const res = await this.fetch(url, { headers: { 'User-Agent': 'downcat-tool-updater' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`해시 목록 받기 실패 (HTTP ${res.status})`);
    return res.text();
  }

  // 파일을 받으면서 동시에 SHA-256을 계산한다. 반환: 받은 파일의 해시(hex)
  async _download(url, dest, onPct) {
    const res = await this.fetch(url, { headers: { 'User-Agent': 'downcat-tool-updater' }, signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!res.ok || !res.body) throw new Error(`받기 실패 (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(dest, 'w');
    let got = 0, lastPct = -1;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        hash.update(buf);
        let off = 0;
        while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
        got += buf.length;
        if (total) {
          const pct = Math.floor(got * 100 / total);
          if (pct !== lastPct) { lastPct = pct; onPct(pct); }
        }
      }
    } finally { fs.closeSync(fd); }
    if (total && got !== total) throw new Error(`받다가 끊겼어요 (${got}/${total} 바이트)`);
    return hash.digest('hex');
  }
}

function createToolManager(opts) { return new ToolManager(opts); }

// 다운로드 하나가 어떤 도구를 쓰는지(자동 분배 결과 기준). yt-dlp는 고화질 병합에 ffmpeg,
// "지원 안 하는 주소"면 gallery-dl로 다시 시도하므로 셋 다 기다린다.
function toolsFor(engineTool) {
  if (engineTool === 'ytdlp') return ['ytdlp', 'ffmpeg', 'gallerydl'];
  if (engineTool === 'gallerydl') return ['gallerydl'];
  if (engineTool === 'aria2') return ['aria2'];
  return undefined; // 모름 → 전부
}

module.exports = { createToolManager, ToolManager, TOOL_SPECS, parseSums, toolsFor, DAY };

// 📌 이 코드가 하는 일: 받냥이가 쓰는 4가지 도구를 "공식 배포처에서 받아 → 지문(해시)이 원본과 같은지 확인하고 →
// bin 폴더에 넣는" 일을 자동으로 한다. 하루 한 번 새 버전이 있는지 보고, 도구를 까는 동안 들어온 작업은 줄 세워 기다리게 한다.
