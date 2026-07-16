'use strict';
// 확장 폴더를 서명된 .crx로 굽는다(Chrome의 --pack-extension 이용). build/downcat-ext.crx로 뽑는다.
// 강제설치 정책은 CRX만 받으므로(개발자모드 압축해제는 자동설치 불가) 이 단계가 필요하다.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const extDir = path.join(ROOT, 'extension');
const keyPem = path.join(ROOT, 'build', 'extension-key.pem');
const dest = path.join(ROOT, 'build', 'downcat-ext.crx');
const chrome = process.env.CHROME
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!fs.existsSync(keyPem)) throw new Error('build/extension-key.pem 없음 — 서명키부터 만들어야 함');
if (!fs.existsSync(chrome)) throw new Error('Chrome을 못 찾음: ' + chrome + ' (CHROME 환경변수로 경로 지정 가능)');

// 현재 실행 중인 Chrome과 안 부딪히게 임시 프로필로 pack만 수행
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'downcat-pack-'));
try {
  execFileSync(chrome, [
    `--pack-extension=${extDir}`,
    `--pack-extension-key=${keyPem}`,
    `--user-data-dir=${tmpProfile}`,
    '--no-message-box',
  ], { stdio: 'inherit' });
} finally {
  try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
}

// Chrome은 <폴더명>.crx를 폴더 옆에 만든다 → build/로 옮긴다
const out = path.join(ROOT, 'extension.crx');
if (!fs.existsSync(out)) throw new Error('CRX가 안 만들어짐: ' + out);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.renameSync(out, dest);
// Chrome이 만든 extension.pem은 우리 키가 있으니 지운다(있다면)
try { fs.rmSync(path.join(ROOT, 'extension.pem'), { force: true }); } catch {}
console.log('CRX →', dest, `(${fs.statSync(dest).size} bytes)`);
