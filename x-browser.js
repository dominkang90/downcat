'use strict';
// Only Electron's Chromium/session is needed. Remote pages get no Node or preload.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const delay=require('node:timers/promises').setTimeout;
const x=require('./x');

function allowedDomain(domain) {
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*(?:x\.com|twitter\.com)$/i.test(domain);
}
function allowedNavigation(value) {
  try {const u=new URL(value);return u.protocol==='https:' && !u.username && !u.password && !u.port && allowedDomain(u.hostname);}catch{return false;}
}
function parseCookieFile(text) {
  const out=[];
  for(let line of String(text).split(/\r?\n/)) {
    let httpOnly=false;
    if(line.startsWith('#HttpOnly_')){httpOnly=true;line=line.slice(10);}
    if(!line || line.startsWith('#'))continue;
    const [domain,includeSub,cookiePath,secure,expires,name,...values]=line.split('\t');
    if(!name || !values.length || !allowedDomain(String(domain || '').replace(/^\./,'')))continue;
    if(!/^(?:TRUE|FALSE)$/.test(includeSub || '') || !/^(?:TRUE|FALSE)$/.test(secure || ''))continue;
    const expirationDate=Number(expires);
    if(!/^\d+$/.test(expires || '') || !Number.isFinite(expirationDate) || (expirationDate>0 && expirationDate<=Date.now()/1000))continue;
    const p=cookiePath || '/';if(!p.startsWith('/'))continue;
    const cookie={url:'https://'+domain.replace(/^\./,'')+p,name,value:values.join('\t'),path:p,secure:secure==='TRUE',httpOnly};
    if(includeSub==='TRUE')cookie.domain=domain;
    if(expirationDate>0)cookie.expirationDate=expirationDate;
    out.push(cookie);
  }
  return out;
}
function extractionScript(url) {
  const source=fs.readFileSync(path.join(__dirname,'x.js'),'utf8');
  return `(()=>{const module={exports:{}};${source}\nreturn module.exports.readDocument(document,${JSON.stringify(url)});})()`;
}
function failure(error,extra={}) {return {ok:false,tool:'x',code:-1,count:0,bytes:0,thumb:null,file:null,files:[],error,...extra};}
function safeMessage(value) {return String(value?.message || value || '').replace(/https?:\/\/\S+/g,'[주소]').slice(0,240);}
function httpFailure(code) {
  if(code===401)return failure('X 로그인이 필요해요. 앱에서 로그인한 뒤 다시 시도해주세요.',{needsLogin:true});
  if(code===403)return failure('X에서 이 게시물 접근을 거부했어요 (HTTP 403). 비공개 게시물 권한이나 접근 제한을 확인해주세요.',{accessRestricted:true});
  if(code===404)return failure('삭제되었거나 찾을 수 없는 X 게시물이에요 (HTTP 404).');
  if(code===429)return failure('X 요청이 많아 잠시 제한됐어요 (HTTP 429). 기다렸다 다시 시도해주세요.',{rateLimited:true});
  if(code>=400)return failure('X 페이지를 불러오지 못했어요 (HTTP '+code+').');
  return null;
}
function createXHandler({BrowserWindow,session,userAgent}) {
  return async function downloadX(value,options={},onEvent=()=>{}) {
    if(options.signal?.aborted)return failure('취소했어요.',{canceled:true});
    let target;try{target=x.parsePostUrl(value);}catch(err){return failure(safeMessage(err));}
    const persistent=!!options.useCookie && !options.cookieFile;
    const ac=new AbortController();
    let ses,win,timeout,abortListener,statusCode=0,loadError=null;
    let stage='X 페이지 준비 중',lastReason='',lastExactPost=null;
    let timedOut=false;
    const forwardAbort=()=>ac.abort(options.signal?.reason);
    const abortPromise=new Promise((_,reject)=>{abortListener=()=>reject(ac.signal.reason || new Error('취소했어요.'));ac.signal.addEventListener('abort',abortListener,{once:true});});
    // An abort can happen between operations; keep its rejection handled until the next race.
    abortPromise.catch(()=>{});
    options.signal?.addEventListener('abort',forwardAbort,{once:true});
    if(options.signal?.aborted)forwardAbort();
    const configured=Number(options.resolveTimeoutMs);
    const timeoutMs=Number.isFinite(configured) && configured>0 ? configured : 45000;
    timeout=setTimeout(()=>{timedOut=true;ac.abort(new Error('X 페이지 읽기 시간 초과'));},timeoutMs);
    const race=operation=>{ac.signal.throwIfAborted();return Promise.race([Promise.resolve().then(operation),abortPromise]);};
    const cleanupSession=async()=>{
      if(!persistent && ses){
        try{await ses.clearStorageData();}catch{}
        try{await ses.clearCache();}catch{}
      }
    };
    const closeWindow=()=>{if(win && !win.isDestroyed())win.destroy();win=null;};
    try {
      ac.signal.throwIfAborted();
      onEvent({type:'start',tool:'x',url:target.url});
      onEvent({type:'log',line:'X 게시물을 브라우저에서 읽고 있어요.',isErr:false});
      ses=session.fromPartition(persistent?'persist:downcat':'downcat-x-'+crypto.randomBytes(8).toString('hex'),{cache:false});
      if(!persistent){ses.setPermissionRequestHandler((_wc,_permission,cb)=>cb(false));ses.setPermissionCheckHandler(()=>false);}
      if(options.cookieFile){
        stage='쿠키 파일 가져오기';
        const importCookies=(async()=>{
          const stat=await fs.promises.stat(options.cookieFile);ac.signal.throwIfAborted();
          if(stat.size>5000000)throw new Error('쿠키 파일이 너무 커요. 올바른 cookies.txt를 선택해주세요.');
          const text=await fs.promises.readFile(options.cookieFile,'utf8');ac.signal.throwIfAborted();
          for(const cookie of parseCookieFile(text)){ac.signal.throwIfAborted();await ses.cookies.set(cookie);ac.signal.throwIfAborted();}
        })();
        // Electron cookies.set cannot be canceled. Re-clear after its late completion,
        // so a canceled import cannot repopulate the already-cleaned temporary session.
        const guardedImport=importCookies.finally(async()=>{if(ac.signal.aborted)await cleanupSession();});
        await race(()=>guardedImport);
      }
      ac.signal.throwIfAborted();
      stage='X 페이지 불러오기';
      win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});
      if(userAgent)win.webContents.setUserAgent(userAgent);
      win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      const restrict=(event,url)=>{if(!allowedNavigation(url))event.preventDefault();};
      win.webContents.on('will-navigate',restrict);
      win.webContents.on('will-redirect',restrict);
      win.webContents.on('did-navigate',(_event,_url,code)=>{statusCode=Number(code)||0;});
      win.webContents.on('did-fail-load',(_event,code,description,_url,isMainFrame)=>{if(isMainFrame!==false)loadError=new Error(description || 'Chromium 오류 '+code);});
      await race(()=>win.loadURL(target.url));
      const script=extractionScript(target.url);
      let post;
      while(true){
        ac.signal.throwIfAborted();
        const statusFailure=httpFailure(statusCode);if(statusFailure)return statusFailure;
        if(loadError)throw loadError;
        stage='X 게시물 데이터 읽기';
        const result=await race(()=>win.webContents.executeJavaScript(script));
        if(result?.loginWall)return failure('X 로그인이 필요해요. 앱에서 로그인한 뒤 다시 시도해주세요.',{needsLogin:true});
        const candidate=result?.post;
        const exact=candidate && String(candidate.code)===String(target.id || target.code);
        if(exact && candidate.authorKnown===true && candidate.textKnown===true)lastExactPost=candidate;
        if(exact && candidate.authorKnown===true && candidate.textKnown===true && !candidate.incomplete){post=candidate;break;}
        lastReason=safeMessage(result?.reason || result?.error || (typeof candidate?.incomplete==='string' && candidate.incomplete) || (!exact?'대상 게시물을 아직 확인하지 못했어요.':candidate.authorKnown!==true?'게시물 작성자를 아직 확인하지 못했어요.':candidate.textKnown!==true?'게시물 본문을 아직 확인하지 못했어요.':'게시물 미디어 정보를 아직 확인하지 못했어요.'));
        await delay(750,undefined,{signal:ac.signal});
      }
      clearTimeout(timeout);timeout=null;
      // Resolution deadline stops here. Download keeps user cancellation and the
      // same session, but may legitimately take longer than 45 seconds.
      closeWindow();
      onEvent({type:'log',line:'X 미디어 '+post.media.length+'개를 찾았어요.',isErr:false});
      // Core combines cancellation with its own download timeout and returns any
      // already-saved body paths on cancellation. Do not race away that result or
      // replace the combined fetch signal with the resolution controller.
      return await x.downloadPost(post,{...options,signal:ac.signal,fetch:(url,init)=>ses.fetch(url,init)},onEvent);
    } catch(err) {
      if(options.signal?.aborted)return failure('취소했어요.',{canceled:true});
      const statusFailure=httpFailure(statusCode);if(statusFailure)return statusFailure;
      if(timedOut){
        const timeoutMessage='X 게시물을 읽는 시간이 초과됐어요 ('+timeoutMs+'ms). '+(lastReason || stage);
        if(lastExactPost){
          // Resolution timed out, but the exact author's known text is useful.
          // Incomplete forces core to save only the body, never request media.
          // This bounded disk-only salvage uses user cancellation, not the now
          // expired resolution signal. Unknown body/author never reaches here.
          closeWindow();
          const partial=await x.downloadPost({...lastExactPost,incomplete:true},{...options,signal:options.signal,timeoutMs:5000,fetch:(url,init)=>ses.fetch(url,init)},onEvent);
          if(partial.canceled || options.signal?.aborted)return partial;
          return {...partial,ok:false,timedOut:true,error:timeoutMessage+' 미디어/MP4 주소를 끝까지 확인하지 못했어요. '+(partial.textCount?'확보한 본문은 저장했습니다.':safeMessage(partial.error))};
        }
        return failure(timeoutMessage,{timedOut:true});
      }
      return failure('X 읽기 실패: '+safeMessage(loadError || err));
    } finally {
      if(timeout)clearTimeout(timeout);
      options.signal?.removeEventListener('abort',forwardAbort);
      ac.signal.removeEventListener('abort',abortListener);
      closeWindow();
      await cleanupSession();
    }
  };
}
module.exports={createXHandler,parseCookieFile,extractionScript};
