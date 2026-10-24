'use strict';
// 받냥이 실행기: 일반 모드로 켜 보고, 창이 안 뜬 채 바로 꺼지면 더 안전한 모드로 차례로 다시 켠다.
// 잘 된 모드는 기억해 두었다가 다음부터 바로 쓴다. 기록은 logs/launch.log, 크롬 엔진 기록은 logs/chromium-<모드>.log.
//
// 왜 필요한가: 일부 Windows(예: 빌드 26300)에서 화면·그래픽 담당 하위 프로세스가 보안 격리(sandbox) 안에서
// 시작조차 못 하고(0xC0000135) 죽어서, 창이 하얗게 떴다 사라지거나 아예 안 뜬다.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LOGS = path.join(ROOT, 'logs');
const READY = path.join(LOGS, 'ready.json');      // main.js가 창을 띄우면 쓴다
const MODE_FILE = path.join(LOGS, 'launch-mode.json');
const LAUNCH_LOG = path.join(LOGS, 'launch.log');

// 순서대로 시도한다. 아래로 갈수록 덜 까다로운 대신 보호막이 줄어든다.
const MODES = {
  normal: [],
  'no-gpu': ['--disable-gpu', '--disable-gpu-sandbox', '--in-process-gpu'],
  'no-sandbox': ['--no-sandbox', '--disable-gpu', '--in-process-gpu'],
};
const WAIT_MS = 20000; // 창이 뜰 때까지 기다리는 최대 시간

fs.mkdirSync(LOGS, { recursive: true });
function log(msg) {
  try { fs.appendFileSync(LAUNCH_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
  console.log(msg);
}

function electronExe() {
  const dir = path.join(ROOT, 'node_modules', 'electron');
  let name = process.platform === 'win32' ? 'electron.exe' : 'electron';
  try { name = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim() || name; } catch {}
  return path.join(dir, 'dist', name);
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

function tryMode(exe, mode) {
  return new Promise((resolve) => {
    try { fs.rmSync(READY, { force: true }); } catch {}
    const args = ['.', ...MODES[mode], '--enable-logging=file', `--log-file=${path.join(LOGS, `chromium-${mode}.log`)}`];
    const child = spawn(exe, args, {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: false,
      env: { ...process.env, DOWNCAT_LAUNCH_MODE: mode },
    });
    let exitCode;
    child.on('exit', (code, signal) => { exitCode = code != null ? code : signal; });
    child.on('error', (e) => { exitCode = String(e.message || e); });
    const started = Date.now();
    const timer = setInterval(() => {
      const ready = readJson(READY);
      if (ready) { clearInterval(timer); child.unref(); resolve({ ok: true, ready }); return; }
      if (exitCode !== undefined) { clearInterval(timer); resolve({ ok: false, exitCode }); return; }
      if (Date.now() - started > WAIT_MS) { // 아직 살아 있는데 창 신호가 없음 → 느린 것으로 보고 맡긴다
        clearInterval(timer); child.unref(); resolve({ ok: true, slow: true });
      }
    }, 250);
  });
}

(async () => {
  const exe = electronExe();
  if (!fs.existsSync(exe)) { log(`실행 파일이 없어요: ${exe}`); process.exit(2); }
  const saved = (readJson(MODE_FILE) || {}).mode;
  const order = [saved, ...Object.keys(MODES)].filter((m, i, a) => m && MODES[m] && a.indexOf(m) === i);
  for (const mode of order) {
    log(`모드 ${mode}로 시작`);
    const r = await tryMode(exe, mode);
    if (r.ok) {
      if (r.ready && r.ready.alreadyRunning) { log('이미 켜진 받냥이를 앞으로 가져왔어요'); process.exit(0); }
      log(r.slow ? `모드 ${mode}: 창 신호는 없지만 실행 중` : `모드 ${mode}: 창 열림 ✓`);
      if (!r.slow && mode !== saved) {
        try { fs.writeFileSync(MODE_FILE, JSON.stringify({ mode, at: new Date().toISOString() }, null, 2)); } catch {}
      }
      process.exit(0);
    }
    log(`모드 ${mode}: 창이 뜨기 전에 꺼짐 (종료 코드 ${r.exitCode})`);
  }
  log('모든 모드에서 실패 — logs 폴더의 launch.log·chromium-*.log·main.log를 Claude에게 보여 주세요');
  process.exit(1);
})();
