// electron-builder afterPack 훅: 앱 exe에 아이콘을 직접 박는다.
// win.signAndEditExecutable:false라 electron-builder가 exe를 안 건드리므로(=winCodeSign
// 심링크 문제 회피) 아이콘은 여기서 직접 넣는다.
// - Windows에서 빌드: 동봉한 rcedit-x64.exe 사용(예전과 같음)
// - 그 밖(리눅스·맥에서 빌드): 순수 JS 도구 resedit로 같은 일을 한다(wine 불필요)
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

async function setIconWithResedit(exe, icoPath) {
  const ResEdit = await import('resedit');
  const PELibrary = await import('pe-library');
  const exeData = fs.readFileSync(exe);
  const executable = PELibrary.NtExecutable.from(exeData, { ignoreCert: true });
  const res = PELibrary.NtExecutableResource.from(executable);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
  // 기존 앱 아이콘 그룹 ID를 그대로 덮어쓴다(없으면 1)
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries, groupId, lang, iconFile.icons.map((item) => item.data));
  res.outputResource(executable);
  fs.writeFileSync(exe, Buffer.from(executable.generate()));
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const name = context.packager.appInfo.productFilename; // "받냥이"
  const exe = path.join(context.appOutDir, `${name}.exe`);
  const icon = path.join(__dirname, 'icon.ico');
  if (!fs.existsSync(exe)) throw new Error('app exe not found: ' + exe);
  if (process.platform === 'win32') {
    execFileSync(path.join(__dirname, 'rcedit-x64.exe'), [exe, '--set-icon', icon], { stdio: 'inherit' });
  } else {
    await setIconWithResedit(exe, icon);
  }
  console.log('  • icon embedded  file=' + path.basename(exe));
};
