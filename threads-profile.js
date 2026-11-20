'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {setTimeout:wait}=require('node:timers/promises');
const {failure,safePart}=require('./threads');
const {linkFromHref}=require('./threads-profile-page');
const reasons={limit:'설정한 게시물 수까지 수집',end:'현재 공개 목록 끝 확인',stalled:'추가 목록 로딩이 멈춰 확인한 범위만 받음',timeout:'목록 수집 시간/안전 한도에서 중단',login:'로그인이 필요해 중단','rate-limit':'요청 제한으로 중단',canceled:'사용자가 취소함',error:'목록을 읽다가 중단'};
async function downloadProfile(target,options={},onEvent=()=>{}) {
  if(options.signal?.aborted)return failure('취소했어요.',{canceled:true});
  const rawLimit=Number(options.threadsProfileLimit ?? 50);
  const limit=Number.isInteger(rawLimit)&&rawLimit>=0&&rawLimit<=10000?rawLimit:50;
  let listing;
  try {listing=await options.collect(target,{...options,threadsProfileLimit:limit},onEvent);}
  catch(e){listing={urls:[],complete:false,stopReason:options.signal?.aborted?'canceled':'error',error:options.signal?.aborted?'취소했어요.':'프로필 목록을 읽지 못했어요.'};}
  const urls=[...new Set((listing.urls || []).map(u=>linkFromHref(u,target.username)).filter(Boolean))];
  if(limit && urls.length>limit)urls.length=limit;
  const profile={total:urls.length,processed:0,succeeded:0,skipped:0,failed:0,pending:urls.length,collectionComplete:!!listing.complete,stopReason:listing.stopReason};
  const results=[];let count=0,bytes=0,file=null,thumb=null,documentFile=null,textCount=0,mediaCount=0,needsLogin=!!listing.needsLogin,rateLimited=!!listing.rateLimited,canceled=!!options.signal?.aborted;
  let fatal=listing.error || '',consecutiveFailures=0;
  onEvent({type:'start',tool:'threads',url:target.url});
  if(!needsLogin && !rateLimited && !canceled)for(let i=0;i<urls.length;i++) {
    try {
      if(options.signal?.aborted){canceled=true;break;}
      if(i)await wait(Math.max(0,options.profileDelayMs ?? 2000),undefined,{signal:options.signal});
      if(options.signal?.aborted){canceled=true;break;}
      onEvent({type:'profile',phase:'downloading',discovered:urls.length,total:urls.length,current:i+1,message:'프로필 게시물 '+(i+1)+'/'+urls.length+' 처리 중 · 파일 '+count+'개'});
      let r;
      try {r=await options.downloadOne(urls[i],options,event=>{
        if(event.type==='progress')onEvent({...event,files:count+(event.files || 0)});
        else if(event.type!=='start'&&event.type!=='done')onEvent(event);
      });}catch{r=failure('게시물 처리 중 오류가 생겼어요.');}
      count+=r.count || 0;bytes+=r.bytes || 0;file=file || r.file;thumb=thumb || r.thumb;
      documentFile=documentFile || r.documentFile;textCount+=r.textCount || 0;mediaCount+=r.mediaCount ?? r.count ?? 0;
      profile.processed++;profile.pending=urls.length-profile.processed;
      if(r.canceled || options.signal?.aborted)canceled=true;
      if(r.ok){profile.succeeded++;consecutiveFailures=0;}
      else if(r.noMedia){profile.skipped++;consecutiveFailures=0;}
      else {profile.failed++;consecutiveFailures++;}
      results.push({url:urls[i],status:r.canceled?'canceled':r.ok?'done':r.noMedia?'skipped':'failed',count:r.count || 0,error:r.error || null});
      needsLogin=!!r.needsLogin;rateLimited=!!r.rateLimited;
      if(canceled || needsLogin || rateLimited || consecutiveFailures>=3){fatal=r.error || '연속 오류로 추가 요청을 멈췄어요.';break;}
    }catch(e){canceled=!!options.signal?.aborted;fatal=canceled?'취소했어요.':'프로필 다운로드를 중단했어요.';break;}
  }
  if(options.signal?.aborted)canceled=true;
  let stop=needsLogin?'login':rateLimited?'rate-limit':canceled?'canceled':profile.pending?'error':listing.stopReason || 'error';
  profile.stopReason=stop;
  const scope=reasons[stop] || reasons.error;
  let summary='게시물 '+profile.processed+'/'+urls.length+'개 처리 · 파일 '+count+'개';
  if(textCount)summary+=' (미디어 '+mediaCount+' · 본문 '+textCount+')';
  if(profile.skipped)summary+=' · 미디어 없음 '+profile.skipped+'개';
  if(profile.failed)summary+=' · 실패 '+profile.failed+'개';
  summary+=' · '+scope;
  const ok=!!listing.complete && profile.pending===0 && profile.failed===0 && !needsLogin && !rateLimited && !canceled && count>0;
  const result={ok,tool:'threads',code:ok?0:-1,count,bytes,file,thumb,documentFile,textCount,mediaCount,canceled,needsLogin,rateLimited,summary,profile};
  if(!ok)result.error=fatal || (count===0 && profile.skipped===urls.length && urls.length>0?'선택한 형식의 사진·영상이 없는 게시물만 찾았어요.':scope);
  // 개별 결과는 URL/상태만 남긴다. 쿠키나 만료되는 미디어 URL은 기록하지 않는다.
  try {
    const safeName=safePart(target.username);
    const folder=path.join(options.outDir || path.join(__dirname,'downloads'),'threads',safeName);
    await fs.mkdir(folder,{recursive:true});
    result.reportFile=path.join(folder,'profile-report-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex')+'.json');
    await fs.writeFile(result.reportFile,JSON.stringify({profile:target.url,requestedLimit:limit,...profile,summary,results,pendingUrls:urls.slice(profile.processed)},null,2),{flag:'wx'});
  }catch{result.ok=false;result.code=-1;result.error=(result.error?result.error+' ':'')+'결과 기록을 저장하지 못했어요.';result.summary+=' · 결과 기록 저장 실패';delete result.reportFile;}
  return result;
}
module.exports={downloadProfile};
