'use strict';
// 옵션 페이지: 토큰을 chrome.storage.local에 저장하고, /ping으로 받냥이 연결을 확인한다.
const BRIDGE = 'http://127.0.0.1:47653';
const $ = (id) => document.getElementById(id);

// 저장된 토큰 불러오기
chrome.storage.local.get('token').then(({ token }) => { if (token) $('token').value = token; });

$('save').addEventListener('click', async () => {
  const token = $('token').value.trim();
  await chrome.storage.local.set({ token });
  setStatus(token ? '저장됐어요.' : '토큰을 비웠어요.', '#333');
});

$('test').addEventListener('click', async () => {
  setStatus('확인 중…', '#666');
  try {
    const res = await fetch(`${BRIDGE}/ping`);
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.app === 'downcat') setStatus('받냥이와 연결됨 ✅', '#2e7d32');
    else setStatus('응답이 이상해요 (받냥이 버전 확인)', '#c62828');
  } catch {
    setStatus('받냥이가 안 켜져 있어요 — 먼저 실행하세요.', '#c62828');
  }
});

function setStatus(msg, color) { const s = $('status'); s.textContent = msg; s.style.color = color; }
