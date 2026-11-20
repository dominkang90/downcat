'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MAX_BODY=15*1024*1024;
function allowedHost(host){return /^(?:[a-z0-9-]+\.)*(?:threads\.(?:com|net)|instagram\.com)$/i.test(host);}
function threadUrl(value){try{const u=new URL(value);return u.protocol==='https:' && /^(?:[a-z0-9-]+\.)*threads\.(?:com|net)$/i.test(u.hostname);}catch{return false;}}
function safeCookie(c){try{const u=new URL(c.url);return u.protocol==='https:' && allowedHost(u.hostname) && (!c.domain || allowedHost(c.domain.replace(/^\./,'')));}catch{return false;}}
function positive(value,fallback){return Number.isFinite(Number(value)) && Number(value)>0?Number(value):fallback;}
function createProfileCollector({BrowserWindow,session,userAgent,parseCookieFile}){
  return async function collect(target,options={},onEvent=()=>{}){
    const urls=new Set();
    const result=(stopReason,error)=>({urls:[...urls],complete:stopReason==='limit'||stopReason==='end',stopReason,...(error?{error}:{}),...(stopReason==='login'?{needsLogin:true}:{}),...(stopReason==='rate-limit'?{rateLimited:true}:{})});
    if(options.signal?.aborted)return result('canceled');
    if(target?.kind!=='profile' || !target.username || !threadUrl(target.url))return result('error','올바른 Threads 프로필 주소가 아니에요.');
    const limit=Number.isFinite(Number(options.threadsProfileLimit)) && Number(options.threadsProfileLimit)>=0?Math.floor(Number(options.threadsProfileLimit)):50;
    const interval=positive(options.pollIntervalMs,2000), timeoutMs=positive(options.timeoutMs,600000), maxRounds=Math.floor(positive(options.maxRounds,300));
    const persistent=!!options.useCookie && !options.cookieFile;
    const ac=new AbortController();
    let ses,win,timer,abortListener,debuggerClient,debuggerAttached=false,debuggerListener;
    let loginRedirect=false,status=0,networkStatus=0,disposed=false,networkSeen=false,networkHasNext=null,networkSeq=0,lastBodySeq=0;
    const responses=new Map(),pendingBodies=new Set();
    const forwardAbort=()=>ac.abort({kind:'canceled'});
    options.signal?.addEventListener('abort',forwardAbort,{once:true});
    if(options.signal?.aborted)forwardAbort();
    timer=setTimeout(()=>ac.abort({kind:'timeout'}),timeoutMs);
    const abortPromise=new Promise((_,reject)=>{abortListener=()=>reject(ac.signal.reason || {kind:'canceled'});if(ac.signal.aborted)abortListener();else ac.signal.addEventListener('abort',abortListener,{once:true});});
    abortPromise.catch(()=>{});
    const check=()=>{if(ac.signal.aborted)throw ac.signal.reason || {kind:'canceled'};};
    const guarded=async work=>{check();const value=await Promise.race([Promise.resolve().then(()=>{check();return work();}),abortPromise]);check();return value;};
    const wait=()=>guarded(()=>new Promise(resolve=>{const id=setTimeout(done,interval);function done(){ac.signal.removeEventListener('abort',cancel);resolve();}function cancel(){clearTimeout(id);ac.signal.removeEventListener('abort',cancel);resolve();}ac.signal.addEventListener('abort',cancel,{once:true});}));
    const emit=()=>{try{onEvent({type:'profile',phase:'collecting',discovered:urls.size,message:'게시물 '+urls.size+'개 찾는 중…'});}catch{}};
    const merge=values=>{if(limit && urls.size>=limit)return;for(const value of values || []){try{const u=new URL(value);const m=u.pathname.match(/^\/@([^/]+)\/post\/([A-Za-z0-9_-]+)\/?$/);if(!threadUrl(value)||!m||decodeURIComponent(m[1]).toLowerCase()!==target.username.toLowerCase())continue;urls.add('https://www.threads.com/@'+m[1].toLowerCase()+'/post/'+m[2]);if(limit && urls.size>=limit)break;}catch{}}};
    try{
      check();
      const pagePath=path.join(__dirname,'threads-profile-page.js');
      const pageSource=fs.readFileSync(pagePath,'utf8'),reader=require(pagePath);
      const script=name=>'(()=>{const module={exports:{}};'+pageSource+'\nreturn module.exports.'+name+'(document,'+JSON.stringify(target.username)+');})()';
      ses=session.fromPartition(persistent?'persist:downcat':'downcat-profile-'+crypto.randomBytes(8).toString('hex'),{cache:false});
      if(!persistent){ses.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));ses.setPermissionCheckHandler(()=>false);}
      check();
      if(options.cookieFile){
        const stat=fs.statSync(options.cookieFile);if(stat.size>5000000)throw new Error('쿠키 파일이 너무 커요.');
        const parse=parseCookieFile || require('./threads-browser').parseCookieFile;
        const cookies=parse(fs.readFileSync(options.cookieFile,'utf8'));
        check();
        for(const cookie of cookies){check();if(safeCookie(cookie))await guarded(()=>Promise.resolve(ses.cookies.set(cookie)).finally(async()=>{if(ac.signal.aborted || disposed){try{await ses.clearStorageData();}catch{}}}));check();}
      }
      check();
      win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});
      const wc=win.webContents;
      if(userAgent)wc.setUserAgent(userAgent);
      wc.setWindowOpenHandler(()=>({action:'deny'}));
      const restrict=(event,url)=>{if(!threadUrl(url)){event.preventDefault();try{if(/(?:^|\.)instagram\.com$/i.test(new URL(url).hostname)){loginRedirect=true;ac.abort({kind:'login'});}}catch{}}};
      wc.on('will-navigate',restrict);wc.on('will-redirect',restrict);
      wc.on('did-navigate',(_event,_url,code)=>{status=Number(code)||0;if([401,403,429].includes(status))ac.abort({kind:'http-status'});});
      debuggerClient=wc.debugger;
      if(debuggerClient && typeof debuggerClient.attach==='function'){
        try{
          debuggerClient.attach('1.3');debuggerAttached=true;
          debuggerListener=(_event,method,params={})=>{
            if(disposed || ac.signal.aborted)return;
            if(method==='Network.responseReceived'){
              const r=params.response || {};
              let relevant=false;try{const u=new URL(r.url);relevant=allowedHost(u.hostname) && /\/(?:graphql|api)(?:\/|\?|$)/i.test(u.pathname+u.search);}catch{}
              if(!relevant)return;
              const seq=++networkSeq;
              // Any newer body invalidates stale initial page_info=false.
              networkSeen=true;networkHasNext=null;
              if(r.status===429 || r.status===401 || r.status===403){networkStatus=r.status;ac.abort({kind:'http-status'});return;}
              if(Number(r.encodedDataLength)>MAX_BODY)return;
              if(responses.size<128)responses.set(params.requestId,{seq});
            }else if(method==='Network.loadingFailed')responses.delete(params.requestId);
            else if(method==='Network.loadingFinished'){
              const meta=responses.get(params.requestId);responses.delete(params.requestId);
              if(!meta || Number(params.encodedDataLength)>MAX_BODY)return;
              const job=Promise.resolve().then(()=>{if(disposed||ac.signal.aborted)return null;return debuggerClient.sendCommand('Network.getResponseBody',{requestId:params.requestId});}).then(body=>{
                if(!body || disposed || ac.signal.aborted)return;
                const raw=body.base64Encoded?Buffer.from(body.body || '', 'base64').toString('utf8'):body.body || '';
                if(Buffer.byteLength(raw,'utf8')>MAX_BODY)return;
                const clean=raw.replace(/^\s*(?:for\s*\(\s*;;\s*\)\s*;|\)\]\}',?\s*)/,'').trim();
                const payloads=[];try{payloads.push(JSON.parse(clean));}catch{for(const line of clean.split(/\r?\n/)){try{payloads.push(JSON.parse(line));}catch{}}}
                const connection=reader.readConnections(payloads,target.username);
                if(disposed||ac.signal.aborted)return;
                merge(connection.urls);
                if(meta.seq>=lastBodySeq){lastBodySeq=meta.seq;networkHasNext=meta.seq===networkSeq && connection.recognized && typeof connection.hasNext==='boolean'?connection.hasNext:null;}
              }).catch(()=>{}).finally(()=>pendingBodies.delete(job));
              pendingBodies.add(job);
            }
          };
          debuggerClient.on('message',debuggerListener);
          await guarded(()=>debuggerClient.sendCommand('Network.enable'));
        }catch(err){
          if(ac.signal.aborted)throw err;
          if(debuggerListener)debuggerClient.removeListener('message',debuggerListener);
          if(debuggerAttached){try{debuggerClient.detach();}catch{}debuggerAttached=false;}
        }
      }
      await guarded(()=>win.loadURL(target.url));
      let stagnant=0,loginStreak=0,endStreak=0,lastCount=0;
      for(let round=0;round<maxRounds;round++){
        check();
        if(status===429 || networkStatus===429)return result('rate-limit','Threads 요청이 잠시 제한됐어요. 잠시 후 다시 시도해주세요.');
        if(loginRedirect || status===401 || status===403 || networkStatus===401 || networkStatus===403)return result('login','Threads 로그인이 필요하거나 접근이 제한됐어요.');
        if(status===404)return result('error','프로필을 찾을 수 없어요.');
        const state=await guarded(()=>wc.executeJavaScript(script('readProfileDocument')));
        merge(state?.urls);emit();
        if(networkStatus===429)return result('rate-limit','Threads 요청이 잠시 제한됐어요.');
        if(networkStatus===401 || networkStatus===403)return result('login','Threads 로그인이 필요하거나 접근이 제한됐어요.');
        if(limit && urls.size>=limit)return result('limit');
        loginStreak=state?.loginWall?loginStreak+1:0;
        if(loginStreak>=3)return result('login','Threads 로그인이 필요해요.');
        const hasNext=networkSeen?networkHasNext:state?.hasNext;
        const end=hasNext===false && responses.size===0 && pendingBodies.size===0 && !state?.loginWall;
        endStreak=end?endStreak+1:0;
        if(endStreak>=2)return result('end');
        const advanced=await guarded(()=>wc.executeJavaScript(script('advanceProfile')));
        stagnant=urls.size===lastCount && !advanced?.moved?stagnant+1:0;lastCount=urls.size;
        if(stagnant>=8 && round>=7 && responses.size===0 && pendingBodies.size===0)return result('stalled','추가 게시물을 확인하지 못했어요. 찾은 항목만 처리합니다.');
        await wait();
      }
      return result('timeout','프로필 수집 한도 시간 또는 탐색 횟수에 도달했어요.');
    }catch(err){
      if(options.signal?.aborted || (ac.signal.aborted && ac.signal.reason?.kind==='canceled'))return result('canceled');
      if(status===429 || networkStatus===429)return result('rate-limit','Threads 요청이 잠시 제한됐어요.');
      if(loginRedirect || status===401 || status===403 || networkStatus===401 || networkStatus===403)return result('login','Threads 로그인이 필요하거나 접근이 제한됐어요.');
      if(ac.signal.aborted)return result('timeout','프로필 수집 시간이 초과됐어요.');
      return result('error','프로필 읽기 실패: '+String(err?.message || err).replace(/https?:\/\/\S+/g,'[주소]').slice(0,180));
    }finally{
      disposed=true;clearTimeout(timer);
      options.signal?.removeEventListener('abort',forwardAbort);
      if(abortListener)ac.signal.removeEventListener('abort',abortListener);
      if(debuggerListener && debuggerClient){try{debuggerClient.removeListener('message',debuggerListener);}catch{}}
      if(debuggerAttached){try{debuggerClient.detach();}catch{}}
      if(win){try{if(!win.isDestroyed())win.destroy();}catch{}}
      if(ses && !persistent){try{await ses.clearStorageData();}catch{}try{await ses.clearCache();}catch{}}
    }
  };
}
module.exports={createProfileCollector};
