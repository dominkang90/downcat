'use strict';
// Public Telegram iframe previews only. No login, cookie file or persistent session.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const delay=require('node:timers/promises').setTimeout;
const telegram=require('./telegram');

function allowedNavigation(value) {
  try {
    const raw=String(value),u=new URL(raw);
    // Check raw authority too: URL.port normalizes explicit :443 to an empty string.
    const authority=raw.match(/^https:\/\/([^/?#]+)/i)?.[1];
    return u.protocol==='https:' && u.hostname==='t.me' && !u.username && !u.password && !u.port && /^t\.me$/i.test(authority || '');
  } catch {return false;}
}
function extractionScript(url) {
  const source=fs.readFileSync(path.join(__dirname,'telegram.js'),'utf8');
  // readDocument and its helpers must be browser-safe; Node-only core methods are
  // defined, not called. Do not expose require, process or Electron to the page.
  return `(()=>{const module={exports:{}};${source}\nreturn module.exports.readDocument(document,${JSON.stringify(url)});})()`;
}
function failure(error,extra={}) {return {ok:false,tool:'telegram',code:-1,count:0,bytes:0,thumb:null,file:null,files:[],error,...extra};}
function safeMessage(value) {
  return String(value?.message || value || '')
    .replace(/https?:\/\/\S+/gi,'[주소]')
    .replace(/\b(?:set-cookie|cookie|authorization|(?:access[_-]?|refresh[_-]?|api[_-]?)?token|password)\s*[:=]\s*[^\r\n]*/gi,'[인증정보 숨김]')
    .slice(0,240);
}
const publicOnly='공개 웹 미리보기로 제공되는 게시물만 저장할 수 있어요. 로그인이나 접근 제한을 우회하지 않습니다.';
function httpFailure(code) {
  if(code===401)return failure('Telegram 인증 제한으로 공개 미리보기를 읽을 수 없어요 (HTTP 401). '+publicOnly,{accessRestricted:true});
  if(code===403)return failure('Telegram이 접근을 거부했어요 (HTTP 403). '+publicOnly,{accessRestricted:true});
  if(code===404)return failure('삭제되었거나 찾을 수 없는 Telegram 게시물이에요 (HTTP 404). '+publicOnly,{unavailable:true});
  if(code===429)return failure('Telegram 요청이 많아 잠시 제한됐어요 (HTTP 429). 기다렸다 다시 시도해주세요. '+publicOnly,{rateLimited:true});
  if(code>=400)return failure('Telegram 공개 미리보기를 불러오지 못했어요 (HTTP '+code+').');
  return null;
}
function coreOptions(options) {
  // Do not even read cookie option getters. Never forward them to the core.
  const out={};
  for(const key of Object.keys(options))if(key!=='cookieFile' && key!=='useCookie')out[key]=options[key];
  return out;
}
function createTelegramHandler({BrowserWindow,session,userAgent}) {
  return async function downloadTelegram(value,options={},onEvent=()=>{}) {
    if(options.signal?.aborted)return failure('취소했어요.',{canceled:true});
    let target;
    try {
      // Accept core-supported public aliases, but never an explicit port or
      // credential-bearing input. Navigation itself remains t.me-only.
      if(!/^https:\/\/(?:t\.me|telegram\.me)(?:[/?#]|$)/i.test(String(value)))throw new Error('HTTPS Telegram 공개 개별 게시물 주소가 필요해요.');
      target=telegram.parsePostUrl(value);
      if(!allowedNavigation(target.embedUrl))throw new Error('공개 Telegram 미리보기 주소가 올바르지 않아요.');
    } catch(err) {return failure(safeMessage(err));}
    const ac=new AbortController();
    let ses,win,timeout,abortListener,statusCode=0,loadError=null;
    let timedOut=false,lastReason='',lastExactPost=null,stage='Telegram 페이지 준비 중';
    const forwardAbort=()=>ac.abort(options.signal?.reason);
    const abortPromise=new Promise((_,reject)=>{abortListener=()=>reject(ac.signal.reason || new Error('취소했어요.'));ac.signal.addEventListener('abort',abortListener,{once:true});});
    abortPromise.catch(()=>{});
    options.signal?.addEventListener('abort',forwardAbort,{once:true});
    if(options.signal?.aborted)forwardAbort();
    const configured=Number(options.resolveTimeoutMs);
    const timeoutMs=Number.isFinite(configured) && configured>0 ? configured : 45000;
    timeout=setTimeout(()=>{timedOut=true;ac.abort(new Error('Telegram 페이지 읽기 시간 초과'));},timeoutMs);
    const race=operation=>{ac.signal.throwIfAborted();return Promise.race([Promise.resolve().then(operation),abortPromise]);};
    const closeWindow=()=>{if(win && !win.isDestroyed())win.destroy();win=null;};
    const fetchPublic=(url,init)=>ses.fetch(url,{...init,credentials:'omit'});
    try {
      ac.signal.throwIfAborted();
      onEvent({type:'start',tool:'telegram',url:target.url});
      onEvent({type:'log',line:'Telegram 공개 웹 미리보기를 읽고 있어요.',isErr:false});
      ses=session.fromPartition('downcat-telegram-'+crypto.randomBytes(8).toString('hex'),{cache:false});
      ses.setPermissionRequestHandler((_wc,_permission,cb)=>cb(false));
      ses.setPermissionCheckHandler(()=>false);
      ac.signal.throwIfAborted();
      stage='Telegram 공개 미리보기 불러오기';
      win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});
      if(userAgent)win.webContents.setUserAgent(userAgent);
      win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      const restrict=(event,url)=>{if(!allowedNavigation(url)){event.preventDefault();loadError=new Error('허용되지 않은 이동을 차단했어요. '+publicOnly);}};
      win.webContents.on('will-navigate',restrict);
      win.webContents.on('will-redirect',restrict);
      win.webContents.on('did-navigate',(_event,_url,code)=>{statusCode=Number(code)||0;});
      win.webContents.on('did-fail-load',(_event,code,description,_url,isMainFrame)=>{if(isMainFrame!==false)loadError=new Error(description || 'Chromium 오류 '+code);});
      await race(()=>win.loadURL(target.embedUrl));
      const script=extractionScript(target.url+(target.single?'?single':''));
      let post;
      while(true) {
        ac.signal.throwIfAborted();
        const statusFailure=httpFailure(statusCode);if(statusFailure)return statusFailure;
        if(loadError)throw loadError;
        stage='Telegram 게시물 데이터 읽기';
        const result=await race(()=>win.webContents.executeJavaScript(script));
        if(result?.unavailable)return failure('Telegram 공개 웹 미리보기를 이용할 수 없어요: '+safeMessage(result.reason || '비공개·삭제 또는 웹 미리보기 미제공 게시물입니다.')+' '+publicOnly,{unavailable:true});
        const candidate=result?.post;
        const exact=candidate && String(candidate.code)===String(target.id || target.code) && typeof candidate.author==='string' && candidate.author.toLowerCase()===target.channel.toLowerCase();
        if(exact && candidate.authorKnown===true && candidate.textKnown===true)lastExactPost=candidate;
        if(exact && candidate.authorKnown===true && candidate.textKnown===true && !candidate.incomplete){post=candidate;break;}
        lastReason=safeMessage(result?.reason || (typeof candidate?.incomplete==='string' && candidate.incomplete) || (!exact?'대상 채널의 정확한 게시물을 아직 확인하지 못했어요.':candidate.authorKnown!==true?'게시물 작성자를 아직 확인하지 못했어요.':candidate.textKnown!==true?'게시물 본문을 아직 확인하지 못했어요.':'게시물 미디어 정보를 아직 확인하지 못했어요.'));
        await delay(750,undefined,{signal:ac.signal});
      }
      clearTimeout(timeout);timeout=null;
      closeWindow();
      onEvent({type:'log',line:'Telegram 미디어 '+post.media.length+'개를 찾았어요.',isErr:false});
      // Do not race the core: its cancellation result can contain a saved body.
      // Keep init.signal intact: the core combines cancellation/download timeout.
      return await telegram.downloadPost(post,{...coreOptions(options),signal:ac.signal,fetch:fetchPublic},onEvent);
    } catch(err) {
      if(options.signal?.aborted)return failure('취소했어요.',{canceled:true});
      const statusFailure=httpFailure(statusCode);if(statusFailure)return statusFailure;
      if(timedOut) {
        const message='Telegram 공개 게시물을 읽는 시간이 초과됐어요 ('+timeoutMs+'ms). '+(lastReason || stage);
        if(lastExactPost) {
          closeWindow();
          try {
            // Exact known body only. The expired resolution signal must not kill
            // disk-only salvage, while the user's signal remains authoritative.
            const partial=await telegram.downloadPost({...lastExactPost,incomplete:true},{...coreOptions(options),signal:options.signal,timeoutMs:5000,fetch:fetchPublic},onEvent);
            if(partial.canceled || options.signal?.aborted)return partial;
            return {...partial,ok:false,timedOut:true,error:message+' 미디어를 끝까지 확인하지 못했어요. '+(partial.textCount?'확보한 본문은 저장했습니다.':safeMessage(partial.error))};
          } catch(partialError) {
            if(options.signal?.aborted)return failure('취소했어요.',{canceled:true});
            return failure(message+' 본문 저장 실패: '+safeMessage(partialError),{timedOut:true});
          }
        }
        return failure(message+' '+publicOnly,{timedOut:true});
      }
      return failure('Telegram 읽기 실패: '+safeMessage(loadError || err));
    } finally {
      if(timeout)clearTimeout(timeout);
      options.signal?.removeEventListener('abort',forwardAbort);
      ac.signal.removeEventListener('abort',abortListener);
      closeWindow();
      if(ses){try{await ses.clearStorageData();}catch{}try{await ses.clearCache();}catch{}}
    }
  };
}
module.exports={createTelegramHandler,extractionScript};
