'use strict';
// Threads 게시물 데이터에서 요청한 게시물만 고른다. 답글/인용/프로필 사진은 받지 않는다.
// 이 파일의 읽기 함수는 Electron 페이지 안에서도 그대로 사용한다(새 라이브러리 없음).
function isThreadsUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      /^(?:www\.)?threads\.(?:com|net)$/i.test(u.hostname);
  } catch { return false; }
}
function parsePostUrl(value) {
  if (!isThreadsUrl(value)) throw new Error('올바른 https Threads 게시물 주소를 넣어주세요.');
  const u = new URL(value);
  const m = u.pathname.match(/^\/@[a-z0-9._]+\/post\/([a-z0-9_-]+)\/?$/i) || u.pathname.match(/^\/t\/([a-z0-9_-]+)\/?$/i);
  if (!m) throw new Error('개별 게시물 주소 형식을 확인해주세요.');
  return { code: m[1], url: 'https://www.threads.com' + u.pathname.replace(/\/$/, '') };
}
function parseTargetUrl(value) {
  if (!isThreadsUrl(value)) throw new Error('올바른 https Threads 주소를 넣어주세요.');
  const u=new URL(value),m=u.pathname.match(/^\/@([a-z0-9._]+)(?:\/media)?\/?$/i);
  if(m)return {kind:'profile',username:m[1].toLowerCase(),url:'https://www.threads.com/@'+m[1].toLowerCase()+(/\/media\/?$/i.test(u.pathname)?'/media':'')};
  const share=u.pathname.match(/^\/share\/([a-z0-9_-]+)\/?$/i);
  if(share)return {kind:'share',url:'https://www.threads.com/share/'+share[1]};
  try{return {kind:'post',...parsePostUrl(value)};}catch{throw new Error('지원하지 않는 Threads 주소 형식이에요. 프로필, 게시물 또는 공유 링크를 넣어주세요.');}
}
function isMediaUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(u.hostname);
  } catch { return false; }
}
function bestCandidate(items) {
  return (items || []).filter(x => x && isMediaUrl(x.url)).map((x, i) => ({x,i}))
    .sort((a,b) => ((b.x.width || 0) * (b.x.height || 0) - (a.x.width || 0) * (a.x.height || 0)) || a.i-b.i)[0]?.x || null;
}
function normalizePost(post) {
  const media = [];
  const items = Array.isArray(post.carousel_media) && post.carousel_media.length ? post.carousel_media : [post];
  for (let i=0; i<items.length; i++) {
    const item = items[i];
    const video = bestCandidate(item.video_versions);
    const image = bestCandidate(item.image_versions2?.candidates);
    if (video) media.push({ kind:'video', url:video.url, index:i+1, thumbnail:image?.url || null });
    else if (image && item.media_type !== 2) media.push({ kind:'image', url:image.url, index:i+1 });
  }
  const author=post.user?.username || 'unknown';
  const textKnown=post.caption===null || typeof post.caption?.text==='string';
  const taken=typeof post.taken_at==='number' && post.taken_at>0?new Date(post.taken_at*1000):null;
  const sourceUrl=/^[a-z0-9._]+$/i.test(author)?'https://www.threads.com/@'+author+'/post/'+post.code:'https://www.threads.com/t/'+post.code;
  return { code:post.code, author, authorName:post.user?.full_name || '',textKnown,text:textKnown?(post.caption?.text || ''):'',publishedAt:taken && Number.isFinite(taken.getTime())?taken.toISOString():null,sourceUrl, media, expectedCount:items.length,
    incomplete: items.some(item => (item.media_type === 2 && !bestCandidate(item.video_versions)) || (item.media_type === 1 && !bestCandidate(item.image_versions2?.candidates))) };
}
function extractPost(payloads, code) {
  const stack = [...payloads]; const seen = new Set(); let found = null; let scanned=0;
  while(stack.length && scanned++ < 200000) {
    const item = stack.pop();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (item.code === code && ('media_type' in item || 'image_versions2' in item || 'carousel_media' in item || 'video_versions' in item)) {
      const p=normalizePost(item);
      if (!found || p.media.length > found.media.length || (p.media.length===found.media.length && !found.textKnown && p.textKnown)) found=p;
    }
    for (const v of Object.values(item)) if (v && typeof v === 'object') stack.push(v);
  }
  return found;
}
function readDocument(doc, value) {
  let target=parseTargetUrl(value);
  const text=(doc.body?.innerText || '').slice(0,12000);
  const loginWall=/\/(?:accounts\/)?login(?:\/|\?|$)/i.test(doc.location?.href || '') ||
    /log in to (?:see|view|continue)|로그인하여 (?:계속|게시물)|계속하려면 로그인/i.test(text);
  if(target.kind==='share') {
    // 공유 토큰은 게시물 코드가 아니다. 실제 이동한 안전한 게시물 URL에서만 코드를 고른다.
    try{target={kind:'post',...parsePostUrl(doc.location?.href)};}
    catch{return {post:null,loginWall,pendingShare:true};}
  }
  if(target.kind!=='post')parsePostUrl(value);
  const {code}=target; const payloads=[];
  for(const script of doc.querySelectorAll('script[type="application/json"]')) {
    const text=script.textContent || '';
    if (!text.includes(code) || text.length>15000000) continue;
    try { payloads.push(JSON.parse(text)); } catch {}
  }
  const post=extractPost(payloads,code);
  // 일치하는 데이터가 없을 때 다른 게시물이나 og:image로 대신 성공 처리하지 않는다.
  if(post)post.sourceUrl=target.url;
  return {post,loginWall,resolvedUrl:target.url};
}
function filterMedia(media, mode) {
  return media.filter(m => mode === 'video' ? m.kind === 'video' : mode === 'image' ? m.kind === 'image' : true);
}
function safePart(value) {
  const s=String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g,'_').replace(/^\.+/,'').slice(0,80) || 'unknown';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s) ? '_'+s : s;
}
function failure(error, extra={}) {
  return {ok:false,tool:'threads',code:-1,count:0,bytes:0,thumb:null,file:null,error,...extra};
}
function mediaExtension(type, kind) {
  const mime=(type || '').split(';')[0].trim().toLowerCase();
  const types={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/avif':'avif','video/mp4':'mp4','video/webm':'webm'};
  return mime.startsWith(kind + '/') ? types[mime] || null : null;
}
// Chromium의 표준 fetch 스트림을 파일에 쓴다. 다중연결/다운로드 엔진을 새로 만들지 않는다.
async function downloadPost(post, options={}, onEvent=()=>{}) {
  const fs=require('node:fs'); const fsp=fs.promises; const path=require('node:path'); const crypto=require('node:crypto');
  const site=options.site==='x'?'x':options.site==='telegram'?'telegram':'threads';
  const validateMedia=site==='x'?require('./x').isMediaUrl:site==='telegram'?require('./telegram').isMediaUrl:isMediaUrl;
  const referer=site==='x'?'https://x.com/':site==='telegram'?'https://t.me/':'https://www.threads.com/';
  const media=filterMedia(post.media || [],options.mode);
  if(options.signal?.aborted) return failure('취소했어요.',{canceled:true});
  if(post.textKnown===false)return failure('게시물 본문 데이터를 확인하지 못했어요. 빈 글로 저장하지 않았습니다. 다시 시도해주세요.');
  const hasDocument=typeof post.text==='string' && (!!post.text.trim() || media.length>0 || !!post.incomplete);
  if(!media.length && !hasDocument) return failure(options.mode==='video' ? '이 게시물에는 받을 수 있는 영상이 없어요.' : options.mode==='image' ? '이 게시물에는 받을 수 있는 사진이 없어요.' : '이 게시물에는 받을 수 있는 사진이나 영상이 없어요.',{noMedia:true});
  const dir=path.join(options.outDir || path.join(__dirname,'downloads'),site,safePart(post.author));
  const files=[]; let bytes=0, thumb=null, currentTemp=null,documentFile=null,textCount=0,mediaCount=0;
  const resultFields=()=>({count:files.length,bytes,thumb,file:files.find(f=>f!==documentFile)||documentFile||null,files,documentFile,textCount,mediaCount,...(textCount?{summary:'미디어 '+mediaCount+'개 · 본문 '+textCount+'개'}:{})});
  const timeout=AbortSignal.timeout(options.timeoutMs || 300000);
  const signal=options.signal ? AbortSignal.any([options.signal,timeout]) : timeout;
  const fetcher=options.fetch || globalThis.fetch;
  try {
    await fsp.mkdir(dir,{recursive:true});
    if(hasDocument){const saved=await require('./post-text').savePostText(post,dir,signal);documentFile=saved.file;files.push(saved.file);bytes+=saved.bytes;textCount=1;signal.throwIfAborted();}
    if(post.incomplete)throw new Error('일부 미디어 주소를 읽지 못했어요. 저장한 본문은 남겨 두었습니다. 다시 시도해주세요.');
    for(let i=0;i<media.length;i++) {
      signal.throwIfAborted(); const item=media[i];
      if(!validateMedia(item.url)) throw new Error('안전하지 않은 미디어 주소를 거절했어요.');
      const response=await fetcher(item.url,{signal,redirect:'error',headers:{Referer:referer}});
      if(!response.ok) {
        await response.body?.cancel().catch(()=>{});
        throw new Error(response.status===429 ? 'Threads 요청이 많아 잠시 제한됐어요. 기다렸다 다시 시도해주세요.' : response.status===403 ? '미디어 주소가 만료됐거나 접근이 제한됐어요. 게시물 링크로 다시 시도해주세요.' : '미디어 다운로드 실패: HTTP '+response.status);
      }
      const ext=mediaExtension(response.headers.get('content-type'),item.kind);
      if(!ext || !response.body) {await response.body?.cancel().catch(()=>{});throw new Error('미디어 대신 다른 응답이 왔어요. 파일로 저장하지 않았습니다.');}
      const finalPath=path.join(dir,safePart(post.code)+'_'+String(item.index || i+1).padStart(2,'0')+'.'+ext);
      currentTemp=finalPath+'.'+crypto.randomBytes(6).toString('hex')+'.part';
      const handle=await fsp.open(currentTemp,'wx'); const reader=response.body.getReader(); let written=0;
      const total=Number(response.headers.get('content-length')) || 0; const started=Date.now();
      try {
        while(true) {
          signal.throwIfAborted(); const chunk=await reader.read(); if(chunk.done) break;
          const buffer=Buffer.from(chunk.value); let offset=0;
          while(offset<buffer.length) {const r=await handle.write(buffer,offset,buffer.length-offset);offset+=r.bytesWritten;}
          written+=buffer.length;
          if(written>2147483648) throw new Error('현재 Threads 다운로드는 파일당 2GB까지 지원해요.');
          onEvent({type:'progress',percent:total ? Math.min(99,Math.round((i+written/total)/media.length*100)) : Math.round(i/media.length*100),files:files.length});
          if(options.rateLimit) {
            const m=String(options.rateLimit).match(/^(\d+(?:\.\d+)?)\s*([KMG])?$/i);
            const rate=m ? Number(m[1])*({K:1024,M:1048576,G:1073741824}[(m[2] || '').toUpperCase()] || 1) : 0;
            if(rate>0) {const delay=written/rate*1000-(Date.now()-started);if(delay>0) await require('node:timers/promises').setTimeout(Math.min(delay,2147483647),undefined,{signal});}
          }
        }
      } finally {await reader.cancel().catch(()=>{});await handle.close();}
      if(!written || (total && written!==total && !response.headers.get('content-encoding'))) throw new Error('다운로드가 중간에 끊겼어요. 다시 시도해주세요.');
      signal.throwIfAborted();
      // 같은 게시물을 동시에 받아도 파일을 덮어쓰지 않는다. 다 받은 파일만 최종 이름으로 만든다.
      let savedPath=finalPath;
      try {await fsp.link(currentTemp,savedPath);} catch(err) {
        if(err.code!=='EEXIST') throw err;
        const existing=await fsp.lstat(savedPath);
        const hashFile=async file=>{const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file)){signal.throwIfAborted();h.update(chunk);}return h.digest('hex');};
        const identical=existing.isFile() && existing.size===written && await hashFile(savedPath)===await hashFile(currentTemp);
        if(!identical) {savedPath=path.join(dir,safePart(post.code)+'_'+String(item.index || i+1).padStart(2,'0')+'_'+crypto.randomBytes(4).toString('hex')+'.'+ext);await fsp.link(currentTemp,savedPath);}
      }
      await fsp.unlink(currentTemp);currentTemp=null;
      files.push(savedPath);bytes+=written;mediaCount++;if(!thumb && item.kind==='image')thumb=savedPath;
      signal.throwIfAborted();
      onEvent({type:'progress',files:files.length,percent:Math.round((i+1)/media.length*100)});
    }
    return {ok:true,tool:'threads',code:0,...resultFields()};
  } catch(err) {
    if(currentTemp) await fsp.rm(currentTemp,{force:true}).catch(()=>{});
    const canceled=!!options.signal?.aborted;
    return failure(canceled ? '취소했어요.' : timeout.aborted ? '다운로드 시간이 초과됐어요. 다시 시도해주세요.' : err.message,{canceled,rateLimited:/요청이 많아|HTTP 429/.test(err.message || ''),...resultFields()});
  }
}
module.exports={isThreadsUrl,parsePostUrl,parseTargetUrl,safePart,isMediaUrl,extractPost,readDocument,filterMedia,downloadPost,failure};
