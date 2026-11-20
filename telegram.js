'use strict';
// Public Telegram post widgets only. No user/bot credentials or private-chat API.
function isTelegramUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/^(?:t\.me|telegram\.me)$/.test(u.hostname);}catch{return false;}}
function parsePostUrl(value){
 if(!isTelegramUrl(value))throw Error('올바른 https 텔레그램 공개 게시물 링크를 넣어주세요.');
 const u=new URL(value),m=u.pathname.match(/^\/(?:s\/)?([a-z0-9_]{1,64})\/([1-9]\d{0,19})\/?$/i);
 if(!m||/^(?:c|s|joinchat|share|addstickers|addemoji|proxy|login|iv|boost|invoice|setlanguage)$/i.test(m[1]))throw Error('텔레그램은 공개 채널의 개별 게시물 링크만 지원해요. 비공개·초대·채널 전체 링크는 지원하지 않습니다.');
 if(u.searchParams.has('comment')||u.searchParams.has('thread'))throw Error('텔레그램 댓글·토론 링크는 지원하지 않아요. 원래 채널 게시물 링크를 넣어주세요.');
 const channel=m[1].toLowerCase(),id=m[2],url='https://t.me/'+channel+'/'+id,single=u.searchParams.has('single');
 return {channel,id,code:id,postKey:channel+'/'+id,url,single,embedUrl:url+'?embed=1&mode=tme'+(single?'&single=1':'')};
}
function isMediaUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/^cdn[1-9]\d*\.telesco\.pe$/.test(u.hostname)&&u.pathname.startsWith('/file/');}catch{return false;}}
function visible(node,doc){
 if(!node)return false;
 if(typeof node.getClientRects==='function'&&!node.getClientRects().length)return false;
 const css=doc.defaultView?.getComputedStyle?.(node);return !css||(css.display!=='none'&&css.visibility!=='hidden');
}
function excluded(node,root){for(let p=node;p&&p!==root;p=p.parentElement)if(/(?:tgme_widget_message_reply|tgme_widget_message_link_preview|tgme_widget_message_forwarded_from)/.test(String(p.className||'')))return true;return false;}
function normalizePost(record,target){
 if(String(record.key||'').toLowerCase()!==target.postKey)return null;
 const media=[],seen=new Set();let incomplete=!!record.unsupportedMedia;
 for(const item of record.media||[]){if(!['image','video'].includes(item.kind)||!isMediaUrl(item.url)){incomplete=true;continue;}const key=item.kind+' '+item.url;if(seen.has(key))continue;seen.add(key);media.push({kind:item.kind,url:item.url,index:media.length+1});}
 const textKnown=record.textKnown===true,stamp=record.publishedAt;
 return {platform:'telegram',code:target.id,author:target.channel,authorKnown:!!record.authorName,authorName:record.authorName||'',sourceUrl:target.url+(target.single?'?single':''),publishedAt:stamp&&Number.isFinite(Date.parse(stamp))?new Date(stamp).toISOString():null,textKnown,text:textKnown?String(record.text||''):'',links:record.links||[],media,expectedCount:(record.media||[]).length,incomplete,unsupportedMedia:!!record.unsupportedMedia};
}
function readDocument(doc,value){
 const target=parsePostUrl(value),roots=Array.from(doc.querySelectorAll('.tgme_widget_message[data-post]'));
 const root=roots.find(e=>String(e.getAttribute('data-post')).toLowerCase()===target.postKey);
 if(!root){const error=doc.querySelector('.tgme_widget_message_error');return {post:null,unavailable:!!error,reason:error?'공개 웹 미리보기를 제공하지 않거나 삭제된 텔레그램 게시물입니다.':'요청한 채널과 게시물 번호를 아직 확인하지 못했어요.'};}
 const textNode=root.querySelector('.tgme_widget_message_text'),author=root.querySelector('.tgme_widget_message_owner_name'),time=root.querySelector('.tgme_widget_message_date time');
 const nodes=Array.from(root.querySelectorAll('.tgme_widget_message_photo_wrap, video.tgme_widget_message_video')).filter(e=>!excluded(e,root));
 const media=nodes.map(e=>{
  if(String(e.tagName).toLowerCase()==='video')return {kind:'video',url:e.getAttribute('src')||e.querySelector('source[src]')?.getAttribute('src')||''};
  const css=e.style?.backgroundImage||e.getAttribute('style')||'',m=css.match(/url\(\s*(['"]?)(.*?)\1\s*\)/i);return {kind:'image',url:m?.[2]||''};
 });
 // Video widgets contain an always-present browser fallback. A valid video URL
 // is usable for saving even when the browser shows a playback warning.
 const explicitUnsupported=Array.from(root.querySelectorAll('[class]')).some(e=>/\btgme_widget_message_(?:document|voice|audio|sticker|poll)(?:_|\b)/.test(String(e.className||''))&&!excluded(e,root));
 const noPlayableFallback=!nodes.length&&Array.from(root.querySelectorAll('.message_media_not_supported_wrap')).some(e=>visible(e,doc));
 const unsupportedMedia=explicitUnsupported||noPlayableFallback;
 const links=[];for(const a of textNode?.querySelectorAll('a[href]')||[]){try{const u=new URL(a.getAttribute('href'),'https://t.me');if(!/^https?:$/.test(u.protocol)||u.username||u.password)continue;if(!links.some(l=>l.url===u.href))links.push({text:(a.innerText??a.textContent??'').trim(),url:u.href});}catch{}}
 const post=normalizePost({key:root.getAttribute('data-post'),authorName:(author?.innerText??author?.textContent??'').trim(),publishedAt:time?.getAttribute('datetime'),textKnown:!!textNode||(!unsupportedMedia&&nodes.length>0),text:textNode?(textNode.innerText??textNode.textContent??''):'',links,media,unsupportedMedia},target);
 return {post,reason:unsupportedMedia?'사진·영상 외 첨부이거나 공개 웹에서 제공하지 않는 미디어가 있어요.':post?.incomplete?'일부 미디어 주소를 아직 확인하지 못했어요.':undefined};
}
function failure(error,extra={}){return {ok:false,tool:'telegram',code:-1,count:0,bytes:0,thumb:null,file:null,error,...extra};}
async function downloadPost(post,options={},onEvent=()=>{}){
 if(options.signal?.aborted)return failure('취소했어요.',{canceled:true});
 let target;try{target=parsePostUrl(post?.sourceUrl);}catch{return failure('텔레그램 게시물 출처를 확인하지 못했어요.');}
 if(post.platform!=='telegram'||post.code!==target.id||post.author!==target.channel||!post.authorKnown)return failure('텔레그램 채널과 게시물 번호가 일치하지 않아요.');
 const safe={...post,media:(post.media||[]).map((m,i)=>({...m,index:i+1}))};
 const r=await require('./threads').downloadPost(safe,{...options,site:'telegram'},onEvent);
 const error=r.error?String(r.error).replace(/Threads/g,'텔레그램').replace(/https?:\/\/\S+/g,'[미디어 주소]'):null;
 return {...r,tool:'telegram',...(error?{error}:{} )};
}
module.exports={isTelegramUrl,parsePostUrl,isMediaUrl,normalizePost,readDocument,downloadPost,failure};
