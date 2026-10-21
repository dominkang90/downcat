'use strict';
// 가짜 yt-dlp / gallery-dl. 진짜 도구 대신 받냥이 엔진 앞에서 경우별로 연기한다.
//   node fake-tool.js ytdlp|gallerydl <도구 인자...>
// 주소 경로로 경우를 고른다:
//   /ok         파일 2개 받고 성공          /partial   1개 받고 실패(일부 실패)
//   /unsupported "지원하지 않는 주소"        /login     401·403 로그인 필요 오류
//   /cp949      UTF-8 옵션을 받아도 cp949로 출력(엔진의 cp949 재해석 시험)
//   /split      한 줄을 한글 글자 중간에서 끊어 두 번에 나눠 출력
// 진짜 한국어 Windows처럼, UTF-8 옵션(yt-dlp --encoding utf-8 / gallery-dl -o output.stdout=utf-8)이
// 없으면 경로를 cp949로 출력한다 → 옵션을 빼먹으면 테스트가 잡아낸다.
const fs = require('fs');
const path = require('path');

const [kind, ...args] = process.argv.slice(2);
const url = args[args.length - 1];
const scenario = (new URL(url).pathname.split('/').filter(Boolean).pop() || 'ok').replace(/^p$/, 'ok');

// 테스트에 쓰는 한글만 담은 cp949 표 (python: '한'.encode('cp949'))
const CP949 = { '고': 'b0ed', '글': 'b1db', '더': 'b4f5', '로': 'b7ce', '목': 'b8f1', '사': 'bbe7', '상': 'bbf3', '양': 'bee7',
  '업': 'bef7', '영': 'bfb5', '이': 'c0cc', '제': 'c1a6', '진': 'c1f8', '폴': 'c6fa', '한': 'c7d1' };
function encodeCp949(s) {
  const parts = [];
  for (const ch of s) {
    if (ch.charCodeAt(0) < 0x80) parts.push(Buffer.from(ch, 'latin1'));
    else if (CP949[ch]) parts.push(Buffer.from(CP949[ch], 'hex'));
    else throw new Error('fake-tool: cp949 표에 없는 글자 ' + ch);
  }
  return Buffer.concat(parts);
}

const utf8Asked = kind === 'ytdlp'
  ? args.some((a, i) => a === '--encoding' && /^utf-?8$/i.test(args[i + 1] || ''))
  : args.some((a, i) => a === '-o' && /^output\.stdout=utf-?8$/i.test(args[i + 1] || ''));
const useCp949 = scenario === 'cp949' || !utf8Asked;
const enc = (s) => (useCp949 ? encodeCp949(s) : Buffer.from(s, 'utf8'));
const out = (s) => process.stdout.write(Buffer.concat([enc(s), Buffer.from('\n')]));
const err = (s) => process.stderr.write(Buffer.concat([enc(s), Buffer.from('\n')]));

// 저장 폴더: yt-dlp는 -o 템플릿(…/%(extractor)s/…)의 앞부분, gallery-dl은 -d
function outDir() {
  if (kind === 'ytdlp') { const t = args[args.indexOf('-o') + 1]; return t.slice(0, t.indexOf('%(extractor)s')); }
  return args[args.indexOf('-d') + 1];
}
function writeFile(name) {
  const dir = path.join(outDir(), kind === 'ytdlp' ? 'fake' : 'fakegallery', '업로더');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(1234, 7));
  return p;
}
// 받은 파일 알리기: yt-dlp는 DCFILE:경로(엔진이 --print로 시킨 형식), gallery-dl은 경로만
const announce = (p) => out(kind === 'ytdlp' ? 'DCFILE:' + p : p);

(async () => {
  // cp949·split 경우엔 같은 폴더에 "동시에 받는 다른 작업"의 파일도 생긴다(실제로 동시 다운로드 2개 이상이면 생김).
  // 엔진이 출력을 못 읽고 폴더를 다시 훑는 대비책으로 넘어가면 이 파일까지 세어 버려서 테스트가 잡아낸다.
  if (scenario === 'cp949' || scenario === 'split') {
    fs.mkdirSync(outDir(), { recursive: true });
    fs.writeFileSync(path.join(outDir(), 'other-job.mp4'), Buffer.alloc(99));
  }
  if (kind === 'ytdlp' && scenario === 'unsupported') { err(`ERROR: Unsupported URL: ${url}`); process.exit(1); }
  if (kind === 'gallerydl' && scenario === 'unsupported' && /both/.test(url)) { err(`[gallery-dl][error] Unsupported URL '${url}'`); process.exit(64); }
  if (scenario === 'login') {
    if (kind === 'ytdlp') err('ERROR: [generic] login: Unable to download webpage: HTTP Error 403: Forbidden');
    else err(`[instagram][error] HttpError: '401 Unauthorized' for '${url}'`);
    process.exit(1);
  }
  const ext = kind === 'ytdlp' ? 'mp4' : 'jpg';
  if (scenario === 'partial') {
    announce(writeFile(`고양이 사진 1.${ext}`));
    err('ERROR: second item: HTTP Error 404: Not Found');
    process.exit(1);
  }
  if (scenario === 'split') {
    const line = Buffer.concat([enc((kind === 'ytdlp' ? 'DCFILE:' : '') + writeFile(`고양이 영상.${ext}`)), Buffer.from('\n')]);
    const cut = line.indexOf(enc('양')) + 1; // '양' 글자 바이트 한가운데서 자른다
    process.stdout.write(line.subarray(0, cut));
    await new Promise(r => setTimeout(r, 80));
    process.stdout.write(line.subarray(cut));
    process.exit(0);
  }
  // ok, cp949, (gallery-dl의) unsupported 대체 성공: 2개
  if (kind === 'ytdlp') out('DLPCT: 50.0%|1.00MiB/s|00:01');
  announce(writeFile(`고양이 사진 1.${ext}`));
  announce(writeFile(`고양이 사진 2.${ext}`));
  process.exit(0);
})();
