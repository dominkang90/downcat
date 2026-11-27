'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../engine');
const base = path.join(__dirname, '.threads-output');
const postUrl = 'https://www.threads.com/@tester/post/AbCd123';
const cdn = 'https://scontent.cdninstagram.com/';
function core() { return require('../threads'); }

test.after(() => { fs.rmSync(base, {recursive:true,force:true}); if(engine.setThreadsHandler) engine.setThreadsHandler(null); });
test('Threads는 자동/영상/이미지 모두 전용 엔진으로 분배', () => {
  for(const mode of ['auto','video','image']) assert.equal(engine.pickTool(postUrl, mode),'threads');
  assert.equal(engine.pickTool('https://threads.com.evil.example/@tester/post/AbCd123','auto'),'ytdlp');
});
test('주소: 두 도메인과 짧은 주소 지원, 프로필은 명확하게 거절', () => {
  const t=core();
  assert.equal(t.parsePostUrl(postUrl+'?x=1').code,'AbCd123');
  assert.equal(t.parsePostUrl('https://www.threads.net/t/AbCd123/').code,'AbCd123');
  assert.throws(()=>t.parsePostUrl('https://www.threads.com/@tester'), /개별 게시물/);
  for(const url of ['https://threads.com.evil.example/@a/post/AbCd123','https://threads.com@localhost/@a/post/AbCd123','file:///threads.com/@a/post/AbCd123','https://threads.com:8443/@a/post/AbCd123']) assert.throws(()=>t.parsePostUrl(url));
});
test('정확한 게시물만 추출: 답글/인용/프로필 사진은 제외, 캐러셀 순서 보존', () => {
  const t=core();
  const target={code:'AbCd123',user:{username:'tester'},carousel_media:[
    {media_type:1,image_versions2:{candidates:[{url:cdn+'small.jpg',width:10,height:10},{url:cdn+'large.jpg',width:100,height:100}]}},
    {media_type:2,video_versions:[{url:cdn+'movie.mp4'}],image_versions2:{candidates:[{url:cdn+'poster.jpg'}]}}
  ],quoted_post:{code:'Other',video_versions:[{url:cdn+'wrong.mp4'}]}};
  const payload=[{reply:{code:'Reply',image_versions2:{candidates:[{url:cdn+'wrong.jpg'}]}},target}];
  const p=t.extractPost(payload,'AbCd123');
  assert.equal(p.author,'tester');
  assert.deepEqual(p.media.map(x=>x.url),[cdn+'large.jpg',cdn+'movie.mp4']);
  assert.deepEqual(t.filterMedia(p.media,'video').map(x=>x.kind),['video']);
  assert.deepEqual(t.filterMedia(p.media,'image').map(x=>x.kind),['image']);
  assert.equal(t.extractPost(payload,'Missing'),null);
});
test('일치하는 빈 게시물과 로그인/삭제/파싱 실패를 구분', () => {
  const t=core();
  assert.equal(t.extractPost([{code:'AbCd123',user:{username:'tester'},media_type:19}],'AbCd123').media.length,0);
  assert.equal(t.isMediaUrl('https://127.0.0.1/a.mp4'),false);
  assert.equal(t.isMediaUrl('https://cdninstagram.com.evil.example/a.jpg'),false);
  assert.equal(t.isMediaUrl(cdn+'a.jpg'),true);
});
test('엔진 실제 호출 경로: 전용 처리, done은 한 번만', async () => {
  let called=0; const events=[];
  assert.equal(typeof engine.setThreadsHandler,'function');
  engine.setThreadsHandler(async(url,opts,event)=>{called++; assert.equal(url,postUrl); return {ok:true,tool:'threads',code:0,count:1,bytes:5,file:'fixture.jpg',thumb:'fixture.jpg'};});
  const r=await engine.download(postUrl,{outDir:base}, e=>events.push(e));
  assert.equal(r.ok,true); assert.equal(called,1); assert.equal(events.filter(e=>e.type==='done').length,1);
});
test('저장: 실제 바이트만 집계, 오류/취소는 부분 파일을 제거', async () => {
  const t=core(); const png=Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex');
  const result=await t.downloadPost({code:'AbCd123',author:'../tester',media:[{kind:'image',url:cdn+'a.png'}]}, {outDir:base,fetch:async()=>new Response(png,{headers:{'content-type':'image/png'}})});
  assert.equal(result.ok,true);assert.equal(result.count,1);assert.equal(fs.statSync(result.file).size,png.length);assert.ok(result.file.startsWith(base+path.sep));
  const bad=await t.downloadPost({code:'Bad123',author:'tester',media:[{kind:'image',url:cdn+'bad.jpg'}]}, {outDir:base,fetch:async()=>new Response('<html>login</html>',{headers:{'content-type':'text/html'}})});
  assert.equal(bad.ok,false);assert.equal(bad.count,0);
  const ac=new AbortController();ac.abort();
  const canceled=await t.downloadPost({code:'Cancel123',author:'tester',media:[{kind:'image',url:cdn+'x.jpg'}]}, {outDir:base,signal:ac.signal,fetch:async()=>{throw Error('should not fetch');}});
  assert.equal(canceled.canceled,true);
});

test('누락된 캐러셀 이미지가 있으면 일부를 전체 성공으로 처리하지 않음', async()=>{
  const t=core();const p=t.extractPost([{code:'AbCd123',media_type:8,user:{username:'tester'},carousel_media:[{media_type:1,image_versions2:{candidates:[{url:cdn+'ok.jpg'}]}},{media_type:1,image_versions2:{candidates:[]}}]}],'AbCd123');
  assert.equal(p.incomplete,true);assert.equal((await t.downloadPost(p,{outDir:base})).ok,false);
});
test('크기만 같은 기존 파일을 새 파일과 동일하다고 판단하지 않음',async()=>{
  const t=core();const p={code:'SameSize',author:'tester',media:[{kind:'image',url:cdn+'a.png'}]};
  const a=await t.downloadPost(p,{outDir:base,fetch:async()=>new Response(Buffer.from('AAAA'),{headers:{'content-type':'image/png'}})});
  const b=await t.downloadPost(p,{outDir:base,fetch:async()=>new Response(Buffer.from('BBBB'),{headers:{'content-type':'image/png'}})});
  assert.notEqual(a.file,b.file);assert.equal(fs.readFileSync(a.file,'utf8'),'AAAA');assert.equal(fs.readFileSync(b.file,'utf8'),'BBBB');
});
test('최종 파일 확정 중 취소도 성공으로 마감하지 않음',async()=>{
  const t=core(),ac=new AbortController(),original=fs.promises.link;
  fs.promises.link=async(...args)=>{await original(...args);ac.abort();};
  try{const r=await t.downloadPost({code:'CommitCancel',author:'tester',media:[{kind:'image',url:cdn+'a.png'}]},{outDir:base,signal:ac.signal,fetch:async()=>new Response(Buffer.from('bytes'),{headers:{'content-type':'image/png'}})});assert.equal(r.ok,false);assert.equal(r.canceled,true);assert.equal(r.count,1);}finally{fs.promises.link=original;}
});
test('속도 제한은 필요한 전체 대기 시간을 지킴',async()=>{
  const timers=require('node:timers/promises'),original=timers.setTimeout;let delay=0;timers.setTimeout=async ms=>{delay+=ms;};
  try{const r=await core().downloadPost({code:'RateLimit',author:'tester',media:[{kind:'image',url:cdn+'a.png'}]},{outDir:base,rateLimit:'1K',fetch:async()=>new Response(Buffer.alloc(65536),{headers:{'content-type':'image/png'}})});assert.equal(r.ok,true);assert.ok(delay>60000);}finally{timers.setTimeout=original;}
});
test('시간 제한은 전체가 아니라 무응답 기준: 느려도 오는 동안은 받고, 멈추면 끊는다',async()=>{
  const slow=gap=>async()=>new Response(new ReadableStream({async pull(c){this.n=(this.n||0)+1;if(this.n>4)return c.close();await new Promise(r=>setTimeout(r,gap));c.enqueue(new Uint8Array(8));}}),{headers:{'content-type':'image/png'}});
  const ok=await core().downloadPost({code:'Idle1',author:'tester',media:[{kind:'image',url:cdn+'a.png'}]},{outDir:base,timeoutMs:150,fetch:slow(60)});
  assert.equal(ok.ok,true);assert.equal(ok.bytes>=32,true); // 총 240ms > 제한 150ms 이지만 성공
  const stuck=await core().downloadPost({code:'Idle2',author:'tester',media:[{kind:'image',url:cdn+'a.png'}]},{outDir:base,timeoutMs:40,fetch:slow(300)});
  assert.equal(stuck.ok,false);assert.match(stuck.error,/시간이 초과/);
});
