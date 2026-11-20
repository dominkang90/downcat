'use strict';

// 별도 classic script로 renderer를 로드해 기존 최상위 선언과 Electron 격리 방식을 유지한다.
(() => {
  const required = [
  "getCookieFile",
  "openSettings",
  "openLogin",
  "setSettings",
  "listGallery",
  "showItem",
  "openPostText",
  "cancelJob",
  "setTaskLabel",
  "removeTask",
  "getSettings",
  "download",
  "expandListing",
  "onJobEvent",
  "onClipboardUrl",
  "onBridgeJob",
  "toolsStatus",
  "onToolsChanged",
  "getTasks"
];
  const notice = document.getElementById('runtime-notice');
  function block() {
    notice.hidden = false;
    for (const control of document.querySelectorAll('button, input, textarea, select')) {
      control.disabled = true;
    }
  }
  const api = window.api;
  if (!api || required.some(name => typeof api[name] !== 'function')) {
    block();
    return;
  }
  const script = document.createElement('script');
  script.src = 'renderer.js';
  script.async = false;
  script.onerror = block;
  document.body.appendChild(script);
})();
