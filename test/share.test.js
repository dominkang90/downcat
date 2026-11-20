'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const core=require('../threads'),{createThreadsHandler}=require('../threads-browser'),engine=require('../engine');
const outDir=path.join(__dirname,'.share-output');
const cases=[['FYgaj-Cgq','DfkS5j6DMne'],['DzSez6001','DfkS4XZHE8O']];
const payload=code=>({code,caption:{text:'shared post body'},media_type:2,user:{username:'tester'},video_versions:[{url:'https://scontent.cdninstagram.com/'+code+'.mp4'}]});
function setup(token,code,extra={}){
  const counts={created:0,closed:0,cleared:0,loaded:[],fetch:[]};
  const share='https://www.threads.com/share/'+token,post='https://www.threads.com/@tester/post/'+code;
  const session={fromPartition:()=>({setPermissionRequestHandler(){},setPermissionCheckHandler(){},cookies:{set:async()=>{}},fetch:async url=>{counts.fetch.push(url);return new Response(Buffer.from('fixture-video'),{headers:{'content-type':'video/mp4'}})},clearStorageData:async()=>counts.cleared++,clearCache:async()=>{}})};
  class Window{
    constructor(opts){counts.created++;assert.equal(opts.webPreferences.sandbox,true);assert.equal(opts.webPreferences.nodeIntegration,false);assert.equal(opts.webPreferences.preload,undefined);this.dead=false;this.webContents=new EventEmitter();this.webContents.setUserAgent=()=>{};this.webContents.setWindowOpenHandler=()=>{};
      this.webContents.executeJavaScript=async script=>vm.runInNewContext(script,{URL,document:{location:{href:extra.destination || (extra.unresolved?share:post)},body:{innerText:extra.login?'Log in to continue':''},querySelectorAll:()=>[{textContent:JSON.stringify({target:payload(code),quote:payload('WrongQuote')})}]}});
    }
    async loadURL(url){counts.loaded.push(url);this.webContents.emit('did-navigate',{},post,extra.status || 200);if(extra.loadError)throw Error('load failed');}
    isDestroyed(){return this.dead;}destroy(){this.dead=true;counts.closed++;}
  }
  return {run:createThreadsHandler({BrowserWindow:Window,session}),counts,share};
}
test.after(()=>{fs.rmSync(outDir,{recursive:true,force:true});engine.setThreadsHandler(null);});
test('스크린샷 두 공유 링크와 threads.net 공유 링크를 별도 종류로 인식',()=>{
  for(const [token] of cases){const r=core.parseTargetUrl('https://www.threads.com/share/'+token);assert.equal(r.kind,'share');assert.equal(r.code,undefined);}
  assert.equal(core.parseTargetUrl('https://threads.net/share/ABC_def/?x=1').url,'https://www.threads.com/share/ABC_def');
});
test('잘못된 경로를 프로필 미지원으로 오안내하지 않음',()=>{
  assert.throws(()=>core.parseTargetUrl('https://www.threads.com/unsupported'),e=>!e.message.includes('프로필이 아니라')&&e.message.includes('주소'));
  for(const u of ['https://threads.com.evil.test/share/abc','https://x@threads.com/share/abc','https://threads.com:123/share/abc','https://threads.com/share/abc/extra'])assert.throws(()=>core.parseTargetUrl(u));
});
for(const [token,code] of cases)test('실제 engine → 공유 링크 이동 → 정확한 게시물 저장: '+token,async()=>{
  const {run,counts,share}=setup(token,code),events=[];engine.setThreadsHandler(run);
  try{const r=await engine.download(share,{outDir},e=>events.push(e));assert.equal(r.ok,true,r.error);assert.equal(r.count,2);assert.equal(r.textCount,1);assert.equal(r.mediaCount,1);assert.deepEqual(counts.loaded,[share]);assert.deepEqual(counts.fetch,['https://scontent.cdninstagram.com/'+code+'.mp4']);assert.equal(counts.closed,1);assert.equal(counts.cleared,1);assert.equal(events.filter(e=>e.type==='done').length,1);}finally{engine.setThreadsHandler(null);}
});
test('공유 주소가 이동하지 않으면 다른 글로 대신 성공하지 않고 전용 안내',async()=>{
  const {run,counts,share}=setup('Expired','Actual',{unresolved:true});const r=await run(share,{outDir,resolveTimeoutMs:25});assert.equal(r.ok,false);assert.match(r.error,/공유 링크/);assert.equal(counts.fetch.length,0);assert.equal(counts.closed,1);
});
test('공유 링크 로그인/404/429는 구분하고 미디어 요청 없음',async()=>{
  for(const extra of [{destination:'https://www.threads.com/login',login:true},{status:404},{status:429,loadError:true}]){const {run,counts,share}=setup('ABC','Actual',extra);const r=await run(share,{outDir,resolveTimeoutMs:50});assert.equal(r.ok,false);assert.equal(counts.fetch.length,0);if(extra.login)assert.equal(r.needsLogin,true);if(extra.status===429)assert.equal(r.rateLimited,true);}
});
test('공유 링크를 외부 주소·프로필 주소로 해석해 임의 미디어를 받지 않음',async()=>{
  for(const destination of ['https://evil.test/@tester/post/Actual','https://www.threads.com/@tester']){const {run,counts,share}=setup('ABC','Actual',{destination});const r=await run(share,{outDir,resolveTimeoutMs:25});assert.equal(r.ok,false);assert.equal(counts.fetch.length,0);}
});
test('공유 링크도 미리 취소되면 창이나 세션을 만들지 않음',async()=>{
  const {run,counts,share}=setup('ABC','Actual');const ac=new AbortController();ac.abort();assert.equal((await run(share,{outDir,signal:ac.signal})).canceled,true);assert.equal(counts.created,0);
});
