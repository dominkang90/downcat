'use strict';
// 옵션 페이지: [연결하기](받냥이 창에서 [예]만 누르면 끝) 또는 토큰 직접 붙여넣기. /ping으로 연결 확인.
const BRIDGE = 'http://127.0.0.1:47653';
const $ = (id) => document.getElementById(id);

// 저장된 토큰 불러오기 + 설치기가 넣은 정책 토큰이 있으면 안내
chrome.storage.local.get('token').then(({ token }) => { if (token) $('token').value = token; });
chrome.storage.managed.get('bridgeToken').then((m) => {
  if (m && m.bridgeToken) setStatus('설치기가 넣은 토큰으로 자동 연결됩니다(직접 안 넣어도 됨).', '#2e7d32');
}).catch(() => {});

// [연결하기]: 받냥이에 연결을 요청 → 받냥이 창에서 [예]를 누르면 토큰을 받아 저장한다.
$('pair').addEventListener('click', async () => {
  const btn = $('pair');
  btn.disabled = true;
  setStatus('받냥이 창에서 [예]를 눌러 주세요…', '#1565c0');
  try {
    const res = await fetch(`${BRIDGE}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(120000), // 2분 안에 대답이 없으면 그만
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.token) {
      await chrome.storage.local.set({ token: data.token });
      $('token').value = data.token;
      setStatus('연결됐어요 ✅ 이제 우클릭 → "받냥이로 받기"를 쓰면 돼요.', '#2e7d32');
    } else if (res.status === 404) {
      setStatus('받냥이가 예전 버전이에요 — 받냥이를 업데이트하거나 아래에 토큰을 직접 넣어 주세요.', '#c62828');
    } else {
      setStatus(data.error || `연결 실패 (${res.status})`, '#c62828');
    }
  } catch (e) {
    setStatus(e && e.name === 'TimeoutError'
      ? '시간이 지났어요 — 다시 [연결하기]를 눌러 주세요.'
      : '받냥이가 안 켜져 있어요 — 먼저 실행하세요.', '#c62828');
  } finally {
    btn.disabled = false;
  }
});

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
