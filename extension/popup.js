'use strict';
// 팝업: 받냥이 연결 상태를 보여주고, "이 페이지 보내기"·"토큰 설정"을 제공한다.
const BRIDGE = 'http://127.0.0.1:47653';
const $ = (id) => document.getElementById(id);

// 연결 상태(/ping)
(async () => {
  try {
    const res = await fetch(`${BRIDGE}/ping`);
    const data = await res.json().catch(() => ({}));
    setConn(res.ok && data.app === 'downcat' ? '받냥이 연결됨 ✅' : '응답 이상', res.ok);
  } catch { setConn('받냥이 꺼짐 — 먼저 실행', false); }
})();

$('page').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;
  // 실제 전송은 background가 담당(토큰·쿠키·referer 로직 재사용)
  chrome.runtime.sendMessage({ type: 'send', url: tab.url, mode: 'auto', tab });
  window.close();
});

$('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());

function setConn(msg, ok) { const c = $('conn'); c.textContent = msg; c.style.color = ok ? '#2e7d32' : '#c62828'; }
