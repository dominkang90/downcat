'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const core=require('../threads'),page=require('../threads-profile-page');
const outDir=path.join(__dirname,'.profile-output');
const profileUrl='https://www.threads.com/@tester';
const postUrl=n=>'https://www.threads.com/@tester/post/Post'+n;
const moduleUnderTest=()=>require('../threads-profile');
test.after(()=>fs.rmSync(outDir,{recursive:true,force:true}));
test('프로필 게시물 목록과 명시적 /media 모두 지원; 개별 게시물 처리 유지',()=>{
  const p=core.parseTargetUrl(profileUrl+'?x=1');assert.equal(p.kind,'profile');assert.equal(p.url,profileUrl);
  assert.equal(core.parseTargetUrl(profileUrl+'/media').kind,'profile');assert.equal(core.parseTargetUrl(postUrl(1)).kind,'post');
  assert.throws(()=>core.parseTargetUrl(profileUrl+'/replies'));assert.throws(()=>core.parseTargetUrl('https://threads.com.evil.test/@tester'));
});
test('프로필 연결은 본인 thread_items만; 인용/다른 작성자/중복 제외',()=>{
  const p=(code,user='tester')=>({code,user:{username:user}});
  const target={mediaData:{edges:[{node:{thread_items:[{post:{...p('A'),quoted_post:p('Quote')}},{post:p('B')},{post:p('Other','else')},{post:p('A')}]} }],page_info:{has_next_page:true}}};
  assert.deepEqual(page.readConnections([target],'tester'),{urls:['https://www.threads.com/@tester/post/A','https://www.threads.com/@tester/post/B'],hasNext:true,recognized:true});
});
test('단순 링크는 안전한 동일 작성자 게시물로 정규화',()=>{
  assert.equal(page.linkFromHref('https://threads.net/@tester/post/AbC?x=1','tester'),'https://www.threads.com/@tester/post/AbC');
  assert.equal(page.linkFromHref('https://evil.test/@tester/post/AbC','tester'),null);assert.equal(page.linkFromHref('/@other/post/AbC','tester'),null);
});
test('프로필은 중복 없이 순차 처리하며 텍스트만인 항목은 건너뜀',async()=>{
  const order=[],events=[];let active=0;
  const result=await moduleUnderTest().downloadProfile(core.parseTargetUrl(profileUrl),{outDir,profileDelayMs:0,collect:async()=>({urls:[postUrl(1),postUrl(2),postUrl(1),postUrl(3)],complete:true,stopReason:'limit'}),downloadOne:async u=>{assert.equal(active++,0);order.push(u);await Promise.resolve();active--;return u===postUrl(2)?{ok:false,noMedia:true,count:0,bytes:0}:{ok:true,count:1,bytes:10,file:'fixture.jpg',thumb:'fixture.jpg'};}},e=>events.push(e));
  assert.deepEqual(order,[postUrl(1),postUrl(2),postUrl(3)]);assert.equal(result.ok,true);assert.equal(result.count,2);assert.equal(result.profile.skipped,1);assert.ok(events.some(e=>e.type==='profile'&&e.phase==='downloading'));assert.ok(fs.existsSync(result.reportFile));
});
test('전체 수집의 로딩 정체는 전체 완료가 아님',async()=>{
  const r=await moduleUnderTest().downloadProfile(core.parseTargetUrl(profileUrl),{outDir,profileDelayMs:0,threadsProfileLimit:0,collect:async()=>({urls:[postUrl(1)],complete:false,stopReason:'stalled'}),downloadOne:async()=>({ok:true,count:1,bytes:10,file:'a.jpg'})});
  assert.equal(r.ok,false);assert.equal(r.count,1);assert.match(r.summary,/멈|중단|확인/);
});
test('429/로그인 제한은 다음 게시물로 계속 요청하지 않음',async()=>{
  for(const flag of ['rateLimited','needsLogin']){let calls=0;const r=await moduleUnderTest().downloadProfile(core.parseTargetUrl(profileUrl),{outDir,profileDelayMs:0,collect:async()=>({urls:[postUrl(1),postUrl(2)],complete:true,stopReason:'limit'}),downloadOne:async()=>{calls++;return {ok:false,[flag]:true,error:'접근 제한',count:0,bytes:0};}});assert.equal(calls,1);assert.equal(r.ok,false);assert.equal(r[flag],true);}
});
test('취소는 다음 게시물 실행 없이 이미 받은 부분만 보존',async()=>{
  const ac=new AbortController();let calls=0;const r=await moduleUnderTest().downloadProfile(core.parseTargetUrl(profileUrl),{outDir,signal:ac.signal,profileDelayMs:0,collect:async()=>({urls:[postUrl(1),postUrl(2)],complete:true,stopReason:'limit'}),downloadOne:async()=>{calls++;ac.abort();return {ok:true,count:1,bytes:10,file:'a.jpg'};}});assert.equal(calls,1);assert.equal(r.canceled,true);assert.equal(r.ok,false);assert.equal(r.count,1);
});

test('프로필 주소도 실제 engine 분기로 들어가며 전체 0과 요약을 보존',async()=>{
  const engine=require('../engine'),events=[];let called=0;
  engine.setThreadsHandler(async(url,opts)=>{called++;assert.equal(url,profileUrl);assert.equal(opts.threadsProfileLimit,0);return {ok:true,tool:'threads',count:2,bytes:10,summary:'범위 확인'};});
  try{const r=await engine.download(profileUrl,{outDir,threadsProfileLimit:0},e=>events.push(e));assert.equal(called,1);assert.equal(r.summary,'범위 확인');assert.equal(events.filter(e=>e.type==='done').length,1);}finally{engine.setThreadsHandler(null);}
});
