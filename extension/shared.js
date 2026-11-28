'use strict';
// 확장의 배경(서비스워커)과 팝업이 같이 쓰는 판단 함수. Node 테스트에서도 그대로 불러 쓴다.

// 브라우저가 혼자 받을 수 있는 주소인가? 직접 주소의 파일·사진만 된다.
// 조각 스트림(HLS/DASH)·blob·페이지 주소는 yt-dlp가 있어야 해서 받냥이 앱이 필요하다.
function browserDownloadable(url, mode) {
  if (!/^https?:\/\//i.test(url)) return false;             // blob:/data: 불가
  if (/\.(m3u8|mpd|m4s)(\?|$)/i.test(url)) return false;    // HLS/DASH는 조립 필요 → 앱
  return mode === 'file' || mode === 'image';                // 직링 파일/이미지만
}

// 확장이 혼자 받은 파일을 둘 폴더(브라우저 다운로드 폴더 기준). 보고 있던 페이지의 사이트 이름을 쓴다.
function siteFolder(pageUrl, fileUrl) {
  for (const value of [pageUrl, fileUrl]) {
    try {
      const u = new URL(value);
      if (!/^https?:$/.test(u.protocol)) continue;
      const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '').replace(/^\.+|\.+$/g, '');
      if (host) return '받냥이/' + host;
    } catch { /* 다음 후보 */ }
  }
  return '받냥이';
}

// 버전 a가 b보다 낮은가? ("0.2.0" < "0.3.0")
function versionLess(a, b) {
  const parts = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}

if (typeof module !== 'undefined') module.exports = { browserDownloadable, siteFolder, versionLess };
