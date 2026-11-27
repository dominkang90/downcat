'use strict';
// 새 버전 확인: GitHub의 "최신" 릴리스(시험판·초안은 GitHub이 빼 준다)와 지금 버전을 비교한다.
// 알림만 한다. 설치 파일을 대신 받아 실행하지 않는다.
const REPO = 'dominkang90/downcat';
const DAY = 24 * 60 * 60 * 1000;

// "v0.2.8" → [0,2,8,1]. 꼬리표가 붙은 판(0.2.7-youtube.1)은 같은 숫자의 정식판보다 낮게 본다.
function parse(v) {
  const m = String(v).replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(-[0-9a-z.-]+)?$/i);
  return m ? [+m[1], +m[2], +m[3], m[4] ? 0 : 1] : null;
}
function isNewer(latest, current) {
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false; // 모르는 형식이면 알리지 않는다
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
// 주소는 응답에서 받지 않고 우리 저장소 주소로 직접 만든다.
function releaseUrl(tag) { return `https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)}`; }
async function check(fetch) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'downcat-app-updater' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return { latest: String((await res.json()).tag_name || '') };
}
module.exports = { DAY, isNewer, releaseUrl, check };
