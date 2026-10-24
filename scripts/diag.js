'use strict';
// 진단: Electron을 여러 조건으로 켜 보고 엔진 오류 출력(stderr)과 종료 코드를 logs/diag.txt에 모은다.
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const LOGS = path.join(ROOT, 'logs'); fs.mkdirSync(LOGS, { recursive: true });
const OUT = path.join(LOGS, 'diag.txt');
fs.writeFileSync(OUT, '');
const w = (s) => { fs.appendFileSync(OUT, s + '\n'); console.log(s); };
const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
w(`node ${process.version} os ${os.release()} ${os.arch()} exe exists=${fs.existsSync(exe)}`);
try { w('dist/version=' + fs.readFileSync(path.join(path.dirname(exe), 'version'), 'utf8')); } catch (e) { w('no version ' + e.message); }
try { w(execSync('wmic path win32_VideoController get name,driverversion', { encoding: 'utf8' }).replace(/\r/g, '').trim()); } catch {}
const cases = [
  ['min-normal', [path.join(__dirname, 'diag-min')]],
  ['min-nosandbox-nogpu', [path.join(__dirname, 'diag-min'), '--no-sandbox', '--disable-gpu', '--in-process-gpu']],
  ['min-swiftshader', [path.join(__dirname, 'diag-min'), '--use-angle=swiftshader', '--disable-gpu-sandbox']],
  ['app-normal', ['.']],
];
(async () => {
  for (const [name, args] of cases) {
    w(`\n===== ${name}: electron ${args.join(' ')}`);
    const t = Date.now();
    const r = await new Promise((res) => {
      const c = spawn(exe, [...args, '--enable-logging=stderr', '--v=0'], { cwd: ROOT,
        env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ELECTRON_ENABLE_STACK_DUMPING: '1' } });
      let buf = '';
      c.stdout.on('data', d => buf += d); c.stderr.on('data', d => buf += d);
      const kill = setTimeout(() => { try { c.kill(); } catch {} }, 15000);
      c.on('error', e => { clearTimeout(kill); res({ code: 'spawn error ' + e.message, buf }); });
      c.on('exit', (code, sig) => { clearTimeout(kill); setTimeout(() => res({ code: code != null ? code + ' (0x' + (code >>> 0).toString(16) + ')' : sig, buf }), 200); });
    });
    w(`exit=${r.code} after ${Date.now() - t}ms`);
    w(r.buf.split(/\r?\n/).filter(l => l.trim()).slice(-60).join('\n'));
  }
  w('\n===== done');
})();
