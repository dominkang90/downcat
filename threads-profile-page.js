'use strict';
// 페이지 안에서 읽는 함수. Node 모듈/쿠키/비공개 API를 사용하지 않는다.
function postLink(author,code,username) {
  if(typeof author!=='string' || author.toLowerCase()!==username.toLowerCase() || !/^[a-z0-9._]+$/i.test(author) || !/^[a-z0-9_-]+$/i.test(code || ''))return null;
  return 'https://www.threads.com/@'+author.toLowerCase()+'/post/'+code;
}
function linkFromHref(href,username) {
  try {const u=new URL(href,'https://www.threads.com');if(u.protocol!=='https:'||u.username||u.password||u.port||!/^(?:www\.)?threads\.(com|net)$/i.test(u.hostname))return null;const m=u.pathname.match(/^\/@([a-z0-9._]+)\/post\/([a-z0-9_-]+)\/?$/i);return m?postLink(m[1],m[2],username):null;}catch{return null;}
}
function readConnections(payloads,username) {
  const urls=[],seenUrls=new Set(),seen=new Set();let hasNext=null,recognized=false;
  const stack=[...payloads].reverse();let count=0;
  while(stack.length && count++<200000) {
    const o=stack.pop();if(!o||typeof o!=='object'||seen.has(o))continue;seen.add(o);
    // 실제 확인한 프로필 mediaData 목록만 읽는다. 인용된 post는 따로 줍지 않는다.
    const connection=o.mediaData;
    if(connection && Array.isArray(connection.edges)) {
      recognized=true;let belongs=false;
      for(const edge of connection.edges)for(const item of edge.node?.thread_items || []) {
        const p=item.post;const url=postLink(p?.user?.username,p?.code,username);
        if(url){belongs=true;if(!seenUrls.has(url)){seenUrls.add(url);urls.push(url);}}
      }
      if((belongs || connection.edges.length===0) && typeof connection.page_info?.has_next_page==='boolean')hasNext=connection.page_info.has_next_page;
    }
    const values=Object.entries(o).filter(([key])=>key!=='mediaData').map(([,value])=>value);
    for(let i=values.length-1;i>=0;i--)if(values[i]&&typeof values[i]==='object')stack.push(values[i]);
  }
  return {urls,hasNext,recognized};
}
function readProfileDocument(doc,username) {
  const payloads=[];
  for(const script of doc.querySelectorAll('script[type="application/json"]')) {
    const text=script.textContent || '';if(!text.includes('mediaData')||text.length>15000000)continue;
    try{payloads.push(JSON.parse(text));}catch{}
  }
  const data=readConnections(payloads,username);const seen=new Set(data.urls);
  const regions=Array.from(doc.querySelectorAll('[role="region"]'));
  const scope=regions.find(r=>Array.from(r.querySelectorAll('a[href]')).some(a=>{
    try{return new URL(a.getAttribute('href'),'https://www.threads.com').pathname.toLowerCase()==='/@'+username.toLowerCase()+'/media';}catch{return false;}
  })) || regions[0] || doc.body;
  if(scope)for(const card of scope.querySelectorAll('[data-pressable-container]')) {
    const parent=card.parentElement?.closest('[data-pressable-container]');
    if(parent && scope.contains(parent))continue;
    // 카드의 첫 게시물 링크는 작성 시각이다. 안쪽 인용/답글 링크는 고르지 않는다.
    const anchor=card.querySelector('a[href*="/post/"]');
    const url=anchor && linkFromHref(anchor.getAttribute('href'),username);
    if(url && !seen.has(url)){seen.add(url);data.urls.push(url);}
  }
  const text=(scope?.innerText || doc.body?.innerText || '').slice(0,15000);
  const loginWall=/\/(?:accounts\/)?login(?:\/|\?|$)/i.test(doc.location?.href || '') || /log in to (?:see|view|continue)|로그인하여 (?:계속|게시물)|계속하려면 로그인/i.test(text);
  return {urls:data.urls,hasNext:data.hasNext,loginWall,empty:data.recognized&&data.hasNext===false&&data.urls.length===0};
}
function advanceProfile(doc) {
  const region=doc.querySelector('[role="region"]');let scroller=region;
  const view=doc.defaultView;
  while(scroller) {
    const style=view?.getComputedStyle(scroller);
    if(scroller.scrollHeight>scroller.clientHeight+2 && /auto|scroll/.test(style?.overflowY || ''))break;
    scroller=scroller.parentElement;
  }
  scroller=scroller || doc.scrollingElement;
  if(!scroller)return {moved:false,top:0,height:0};
  const before=scroller.scrollTop;const amount=Math.max(500,Math.floor((scroller.clientHeight || view?.innerHeight || 800)*0.8));
  scroller.scrollTop=Math.min(scroller.scrollHeight,scroller.scrollTop+amount);
  return {moved:scroller.scrollTop!==before,top:scroller.scrollTop,height:scroller.scrollHeight};
}
module.exports={postLink,linkFromHref,readConnections,readProfileDocument,advanceProfile};
