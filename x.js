'use strict';
// X가 페이지에 로드한 게시물 데이터만 읽는다. 비공개 API 키/쿠키/Aside SDK는 포함하지 않는다.
// readDocument/extractPost는 Electron 페이지에서도 그대로 실행한다.
function isXUrl(value){
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/^(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)$/i.test(u.hostname);}catch{return false;}
}
function parsePostUrl(value){
  if(!isXUrl(value))throw Error('올바른 https X 또는 Twitter 게시물 주소를 넣어주세요.');
  const u=new URL(value),m=u.pathname.match(/^\/(?:([a-z0-9_]{1,50})\/status|i\/(?:web\/)?status)\/(\d{1,25})(?:\/(?:photo|video)\/\d+)?\/?$/i);
  if(!m)throw Error('X는 현재 개별 게시물 링크를 지원해요. 프로필 대신 /status/숫자가 있는 링크를 넣어주세요.');
  return {id:m[2],code:m[2],url:'https://x.com/'+(m[1]?m[1]+'/status/':'i/status/')+m[2]};
}
function isMediaUrl(value){
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/^(?:pbs|video)\.twimg\.com$/i.test(u.hostname);}catch{return false;}
}
function normalizePost(raw,id){
  const legacy=raw.legacy||raw,user=raw.core?.user_results?.result||raw.user||{};
  const author=user.core?.screen_name||user.legacy?.screen_name||user.screen_name||'unknown';
  const authorKnown=author!=='unknown'&&/^[a-z0-9_]{1,50}$/i.test(author);
  const authorName=user.core?.name||user.legacy?.name||user.name||'';
  const note=raw.note_tweet?.note_tweet_results?.result||raw.note_tweet?.result||raw.note_tweet;
  const text=typeof note?.text==='string'?note.text:typeof legacy.full_text==='string'?legacy.full_text:typeof legacy.text==='string'?legacy.text:null;
  const stamp=legacy.created_at||raw.created_at;
  const supplied=legacy.extended_entities?.media??raw.extended_entities?.media??legacy.entities?.media;
  const mediaKnown=Array.isArray(supplied)||(supplied==null&&!!legacy.entities&&typeof legacy.entities==='object');
  const items=Array.isArray(supplied)?supplied:[];
  const media=[];let incomplete=!mediaKnown;
  for(let i=0;i<items.length;i++){
    const m=items[i];
    if(m.type==='photo'){
      if(isMediaUrl(m.media_url_https))media.push({kind:'image',url:m.media_url_https,index:i+1});else incomplete=true;
    }else if(m.type==='video'||m.type==='animated_gif'){
      const best=(m.video_info?.variants||[]).filter(v=>v.content_type==='video/mp4'&&isMediaUrl(v.url)).sort((a,b)=>(Number(b.bitrate)||0)-(Number(a.bitrate)||0))[0];
      if(best)media.push({kind:'video',url:best.url,index:i+1,thumbnail:isMediaUrl(m.media_url_https)?m.media_url_https:null});else incomplete=true;
    }else incomplete=true;
  }
  return {platform:'x',code:id,author,authorKnown,authorName:typeof authorName==='string'?authorName:'',textKnown:text!==null,text:text||'',textSource:typeof note?.text==='string'?'note':'legacy',publishedAt:stamp&&Number.isFinite(Date.parse(stamp))?new Date(stamp).toISOString():null,sourceUrl:'https://x.com/'+(authorKnown?author+'/status/':'i/status/')+id,media,mediaKnown,expectedCount:items.length,incomplete};
}
function extractPost(payloads,id){
  const stack=[...payloads],seen=new Set(),candidates=[];let scanned=0;
  while(stack.length&&scanned++<100000){
    const o=stack.pop();if(!o||typeof o!=='object'||seen.has(o)||typeof o.nodeType==='number')continue;seen.add(o);
    const code=String(o.rest_id||o.id_str||o.legacy?.id_str||'');
    if(code===id&&(o.legacy?.full_text!==undefined||o.full_text!==undefined||o.text!==undefined||o.note_tweet)){
      candidates.push(normalizePost(o,id));
    }
    for(const[k,v]of Object.entries(o))if(!['_owner','return','child','sibling','stateNode','alternate','_debugOwner'].includes(k)&&v&&typeof v==='object')stack.push(v);
  }
  if(!candidates.length)return null;
  // 같은 ID의 부분 후보가 전체 본문이나 이미 확인한 영상을 지우지 않도록 항목별로 선택한다.
  const base=[...candidates].sort((a,b)=>Number(b.authorKnown)-Number(a.authorKnown)||Number(!!b.publishedAt)-Number(!!a.publishedAt))[0];
  const body=[...candidates].sort((a,b)=>Number(b.textKnown)-Number(a.textKnown)||Number(b.textSource==='note')-Number(a.textSource==='note')||b.text.length-a.text.length)[0];
  const media=[...candidates].sort((a,b)=>b.expectedCount-a.expectedCount||b.media.length-a.media.length||Number(b.mediaKnown)-Number(a.mediaKnown)||Number(a.incomplete)-Number(b.incomplete))[0];
  return {...base,text:body.text,textKnown:body.textKnown,textSource:body.textSource,media:media.media,mediaKnown:media.mediaKnown,expectedCount:media.expectedCount,incomplete:media.incomplete};
}
function readDocument(doc,value){
  const target=parsePostUrl(value),roots=[];
  for(const article of doc.querySelectorAll('article[data-testid="tweet"]')){
    const matches=Array.from(article.querySelectorAll('a[href]')).some(a=>{try{return parsePostUrl(new URL(a.getAttribute('href'),'https://x.com').href).id===target.id;}catch{return false;}});
    if(!matches)continue;
    const keys=Object.keys(article),fiberKey=keys.find(k=>k.startsWith('__reactFiber')),propsKey=keys.find(k=>k.startsWith('__reactProps'));
    if(propsKey)roots.push(article[propsKey]);
    let fiber=fiberKey?article[fiberKey]:null;
    for(let i=0;fiber&&i<14;i++,fiber=fiber.return)if(fiber.memoizedProps)roots.push(fiber.memoizedProps);
  }
  const post=extractPost(roots,target.id);
  const loginWall=!post&&/\/(?:i\/flow\/login|login)(?:[/?#]|$)/i.test(doc.location?.href||'');
  return {post,loginWall,resolvedUrl:post?.sourceUrl||target.url};
}
function failure(error,extra={}){return {ok:false,tool:'x',code:-1,count:0,bytes:0,thumb:null,file:null,error,...extra};}
async function downloadPost(post,options={},onEvent=()=>{}){
  if(post?.platform!=='x'||!/^\d{1,25}$/.test(post.code||''))return failure('X 게시물 데이터를 확인하지 못했어요.');
  if(options.signal?.aborted)return failure('취소했어요.',{canceled:true});
  if(!post.authorKnown)return failure('X 작성자 정보를 확인하지 못했어요. 다시 시도해주세요.');
  const r=await require('./threads').downloadPost(post,{...options,site:'x'},onEvent);
  return {...r,tool:'x',...(r.error?{error:r.error.replace(/Threads/g,'X')}:{})};
}
module.exports={isXUrl,parsePostUrl,isMediaUrl,normalizePost,extractPost,readDocument,downloadPost,failure};
