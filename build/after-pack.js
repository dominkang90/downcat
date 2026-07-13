// electron-builder afterPack 훅: rcedit로 앱 exe에 아이콘을 직접 박는다.
// win.signAndEditExecutable:false라 electron-builder가 exe를 안 건드리므로(=winCodeSign
// 심링크 문제 회피) 아이콘은 여기서 직접 넣는다. rcedit-x64.exe는 build/에 vendor.
// 심볼릭 링크·관리자 권한 불필요.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const name = context.packager.appInfo.productFilename; // "받냥이"
  const exe = path.join(context.appOutDir, `${name}.exe`);
  const icon = path.join(__dirname, 'icon.ico');
  const rcedit = path.join(__dirname, 'rcedit-x64.exe');
  if (!fs.existsSync(exe)) throw new Error('app exe not found: ' + exe);
  execFileSync(rcedit, [exe, '--set-icon', icon], { stdio: 'inherit' });
  console.log('  • icon embedded via rcedit  file=' + path.basename(exe));
};
