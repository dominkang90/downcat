'use strict';
// Electron에 이미 들어 있는 Chromium과 앱 로그인 세션을 재사용한다.
// Threads 페이지에는 Node 권한/앱 preload를 절대 넣지 않는다.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const threads=require('./threads');
const coreSource=fs.readFileSync(path.join(__dirname,'threads.js'),'utf8');
const delay=require('node:timers/promises').setTimeout;

function parseCookieFile(text) {
  const out=[];
  for(let line of text.split(/\r?\n/)) {
    let httpOnly=false;
    if(line.startsWith('#HttpOnly_')) {httpOnly=true;line=line.slice(10);}
    if(!line || line.startsWith('#'))continue;
    const [domain,includeSub,cookiePath,secure,expires,name,...values]=line.split('\t');
    if(!name || !values.length || !/^(?:\.?)(?:[a-z0-9-]+\.)*(?:threads\.(?:com|net)|instagram\.com)$/i.test(domain || ''))continue;
    const expirationDate=Number(expires);
    if(expirationDate && expirationDate<Date.now()/1000)continue;
    const cookie={url:'https://'+domain.replace(/^\./,'')+(cookiePath || '/'),name,value:values.join('\t'),path:cookiePath || '/',secure:secure==='TRUE',httpOnly};
    if(includeSub==='TRUE')cookie.domain=domain;
    if(expirationDate)cookie.expirationDate=expirationDate;
    out.push(cookie);
  }
  return out;
}
function extractionScript(url) {
  return `(()=>{const module={exports:{}};${coreSource}\nreturn module.exports.readDocument(document,${JSON.stringify(url)});})()`;
}
function createSinglePostHandler({BrowserWindow,session,userAgent}) {
  return async function downloadThreads(value,options={},onEvent=()=>{}) {
    let target;try {const parsed=threads.parseTargetUrl(value);target=parsed.kind==='share'?parsed:threads.parsePostUrl(value);}catch(e){return threads.failure(e.message);}
    if(options.signal?.aborted)return threads.failure('취소했어요.',{canceled:true});
    onEvent({type:'start',tool:'threads',url:target.url});
    onEvent({type:'log',line:target.kind==='share'?'공유 링크가 가리키는 실제 게시물을 확인하고 있어요.':'Threads 게시물을 브라우저에서 읽고 있어요.',isErr:false});
    const persistent=!!options.useCookie && !options.cookieFile;
    const ses=session.fromPartition(persistent ? 'persist:downcat' : 'downcat-threads-'+crypto.randomBytes(8).toString('hex'),{cache:false});
    let win;let timeout;let abortListener;let loginRedirect=false;let statusCode=0;
    const ac=new AbortController();
    const forwardAbort=()=>ac.abort();
    options.signal?.addEventListener('abort',forwardAbort,{once:true});
    try {
      if(!persistent) {
        ses.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));
        ses.setPermissionCheckHandler(()=>false);
      }
      if(options.cookieFile) {
        // 쿠키는 Threads/Instagram 도메인만 이 작업의 임시 세션으로 가져온다.
        const stat=fs.statSync(options.cookieFile);if(stat.size>5000000)throw new Error('쿠키 파일이 너무 커요. 올바른 cookies.txt를 선택해주세요.');
        for(const c of parseCookieFile(fs.readFileSync(options.cookieFile,'utf8'))) {ac.signal.throwIfAborted();await ses.cookies.set(c);}
      }
      ac.signal.throwIfAborted();
      win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});
      if(userAgent)win.webContents.setUserAgent(userAgent);
      win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      const restrict=(event,url)=>{if(!threads.isThreadsUrl(url)){event.preventDefault();if(/instagram\.com\//i.test(url))loginRedirect=true;}};
      win.webContents.on('will-navigate',restrict);win.webContents.on('will-redirect',restrict);
      win.webContents.on('did-navigate',(_e,_u,code)=>{statusCode=code;});
      timeout=setTimeout(()=>ac.abort(new Error('Threads 페이지를 읽는 시간이 초과됐어요.')),options.resolveTimeoutMs || 45000);
      const abortPromise=new Promise((_,reject)=>{abortListener=()=>reject(ac.signal.reason || new Error('취소했어요.'));if(ac.signal.aborted)abortListener();else ac.signal.addEventListener('abort',abortListener,{once:true});});
      await Promise.race([win.loadURL(target.url),abortPromise]);
      const script=extractionScript(target.url);let result;
      while(!ac.signal.aborted) {
        if(statusCode===404) return threads.failure('삭제되었거나 찾을 수 없는 게시물이에요.');
        if(statusCode===429) return threads.failure('Threads 요청이 많아 잠시 제한됐어요. 기다렸다 다시 시도해주세요.',{rateLimited:true});
        if(loginRedirect) return threads.failure('Threads 로그인이 필요해요. 게시물 주소를 입력한 뒤 로그인 버튼으로 로그인하고 창을 닫아주세요.',{needsLogin:true});
        result=await Promise.race([win.webContents.executeJavaScript(script),abortPromise]);
        if(result.post && !result.post.incomplete)break;
        if(result.loginWall) return threads.failure('Threads 로그인이 필요해요. 게시물 주소를 입력한 뒤 로그인 버튼으로 로그인하고 창을 닫아주세요.',{needsLogin:true});
        await delay(750,undefined,{signal:ac.signal});
      }
      clearTimeout(timeout);timeout=null;
      if(!result?.post) return threads.failure('게시물 데이터를 읽지 못했어요. 앱에서 Threads 로그인 후 다시 시도해주세요.');
      const post=result.post;
      // 페이지는 여기까지만 유지한다. 실제 미디어는 같은 Chromium 세션으로 받는다.
      if(win && !win.isDestroyed())win.destroy();win=null;
      onEvent({type:'log',line:'Threads 미디어 '+post.media.length+'개를 찾았어요.',isErr:false});
      return await threads.downloadPost(post,{...options,fetch:(url,init)=>ses.fetch(url,init)},onEvent);
    } catch(err) {
      if(options.signal?.aborted)return threads.failure('취소했어요.',{canceled:true});
      if(loginRedirect || statusCode===401 || statusCode===403)return threads.failure('Threads 로그인이 필요하거나 접근이 제한됐어요. 앱에서 로그인 후 다시 시도해주세요.',{needsLogin:true});
      if(statusCode===429)return threads.failure('Threads 요청이 많아 잠시 제한됐어요. 기다렸다 다시 시도해주세요.',{rateLimited:true});
      if(ac.signal.aborted)return threads.failure(target.kind==='share'?'공유 링크의 실제 게시물을 확인하지 못했어요. 앱에서 로그인 후 다시 시도하거나 게시물 주소를 직접 넣어주세요.':'게시물 데이터를 읽지 못했어요. 앱에서 Threads 로그인 후 다시 시도해주세요.');
      return threads.failure('Threads 읽기 실패: '+String(err.message || err).replace(/https?:\/\/\S+/g,'[주소]').slice(0,180));
    } finally {
      if(timeout)clearTimeout(timeout);
      options.signal?.removeEventListener('abort',forwardAbort);
      if(abortListener)ac.signal.removeEventListener('abort',abortListener);
      if(win && !win.isDestroyed())win.destroy();
      if(!persistent){await ses.clearStorageData().catch(()=>{});await ses.clearCache().catch(()=>{});}
    }
  };
}
function createThreadsHandler(deps) {
  const downloadOne=createSinglePostHandler(deps);
  let collect;
  return async (value,options={},onEvent=()=>{})=>{
    let target;try{target=threads.parseTargetUrl(value);}catch(e){return threads.failure(e.message);}
    if(target.kind!=='profile')return downloadOne(value,options,onEvent);
    if(!collect)collect=require('./threads-profile-browser').createProfileCollector({...deps,parseCookieFile});
    return require('./threads-profile').downloadProfile(target,{...options,collect,downloadOne},onEvent);
  };
}
module.exports={createThreadsHandler,createSinglePostHandler,extractionScript,parseCookieFile};
