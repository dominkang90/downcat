'use strict';
// 받냥이 가속 엔진: 일반 파일 URL을 aria2c로 다중 연결 다운로드한다.
// engine.js가 tool==='aria2'일 때 이 모듈에 위임한다. yt-dlp 경로와 같은 onEvent 계약을 지킨다.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN_DIR = path.join(__dirname, 'bin');

// aria2c 실제 경로를 호출 시점에 찾는다(설치 직후에도 반영되게). 없으면 null → PATH 폴백.
function resolveAria2() {
  const local = path.join(BIN_DIR, 'aria2c.exe');
  return fs.existsSync(local) ? local : null;
}

// aria2c 실행 인자. 순수 함수 — 테스트로 검증한다.
// opts: connections(기본16), referer, userAgent, cookieFile, rateLimit
function aria2Args(url, outDir, opts) {
  opts = opts || {};
  const conn = opts.connections || 16;
  const args = [
    '--dir=' + outDir,
    '--continue=true',                        // 재개: 이어받기
    '--max-connection-per-server=' + conn,    // 한 서버에 최대 연결 수
    '--split=' + conn,                        // 파일을 몇 조각으로 나눠 받을지
    '--min-split-size=1M',
    '--content-disposition=true',             // 서버가 준 진짜 파일명 사용
    '--auto-file-renaming=false',
    '--allow-overwrite=false',
    '--summary-interval=1',                   // 1초마다 진행 요약 출력 → 진행률 파싱용
    '--console-log-level=warn',
    '--show-console-readout=true',
  ];
  if (opts.referer) args.push('--referer=' + opts.referer);
  if (opts.userAgent) args.push('--user-agent=' + opts.userAgent);
  if (opts.cookieFile) args.push('--load-cookies=' + opts.cookieFile);
  if (opts.rateLimit) args.push('--max-download-limit=' + opts.rateLimit);
  args.push(url);   // URL은 항상 맨 끝
  return args;
}

// aria2 요약 줄에서 진행률·속도·남은시간을 뽑는다. 없으면 null.
// 예: [#2089b4 400MiB/1.2GiB(33%) CN:16 DL:5.2MiB ETA:2m34s]
function parseAria2Progress(line) {
  const pct = line.match(/\((\d+)%\)/);
  if (!pct) return null;
  const dl = line.match(/DL:\s*([0-9.]+\s*[KMGT]?i?B)/i);
  const eta = line.match(/ETA:\s*([^\s\]]+)/i);
  return {
    percent: parseInt(pct[1], 10),
    speed: dl ? dl[1].replace(/\s+/g, '') + '/s' : null,
    eta: eta ? eta[1] : null,
  };
}

// aria2c가 PATH에도 없고 bin에도 없을 때 확인용
function commandExists() {
  try { execFileSync('aria2c', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// 실제 실행. resolve -> {ok, code, canceled}. 파일 집계는 engine이 scanNew로 한다.
function runAria2(url, outDir, opts, onEvent) {
  opts = opts || {};
  onEvent = onEvent || (() => {});
  const exe = resolveAria2();
  if (!exe && !commandExists()) {
    const msg = 'aria2c가 없어요 — 설정에서 자동 설치하거나 bin 폴더에 aria2c.exe를 넣어주세요';
    onEvent({ type: 'error', line: msg });
    return Promise.resolve({ ok: false, code: -1, canceled: false, error: msg });
  }
  const args = aria2Args(url, outDir, opts);
  onEvent({ type: 'start', tool: 'aria2', url });
  return new Promise((resolve) => {
    const child = spawn(exe || 'aria2c', args, { windowsHide: true, signal: opts.signal });
    const handle = (buf, isErr) => {
      // aria2 진행 표시는 \r로 갱신되니 \r·\n 둘 다로 쪼갠다
      for (const line of buf.toString().split(/[\r\n]+/)) {
        if (!line.trim()) continue;
        const p = parseAria2Progress(line);
        if (p) { onEvent({ type: 'progress', ...p }); continue; }
        onEvent({ type: 'log', line, isErr });
      }
    };
    child.stdout.on('data', b => handle(b, false));
    child.stderr.on('data', b => handle(b, true));
    child.on('error', (e) => {
      if (opts.signal && opts.signal.aborted) { resolve({ ok: false, code: null, canceled: true }); return; }
      onEvent({ type: 'error', line: String(e) });
      resolve({ ok: false, code: -1, canceled: false, error: String(e) });
    });
    child.on('close', (code) => {
      const canceled = !!(opts.signal && opts.signal.aborted);
      resolve({ ok: code === 0 && !canceled, code, canceled });
    });
  });
}

module.exports = { aria2Args, parseAria2Progress, runAria2 };

// 📌 이 코드가 하는 일: `aria2Args`는 "aria2한테 넘길 명령 조각들"을 배열로 만든다(16조각으로 나눠 이어받기 하며 받아라). `parseAria2Progress`는 aria2가 찍는 한 줄에서 "몇 %·속도·남은시간"만 콕 뽑는다.
