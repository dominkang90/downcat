'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {createSinglePostHandler:createThreadsHandler,parseCookieFile}=require('../threads-browser');
const {toolsFor}=require('../tools');
const outDir=path.join(__dirname,'.browser-output');
const url='https://www.threads.com/@tester/post/Test123';
const image=Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex');
const post={code:'Test123',caption:null,media_type:1,user:{username:'tester'},image_versions2:{candidates:[{url:'https://scontent.cdninstagram.com/a.png',width:200,height:100}]}};
function setup(payload=post, extra={}){
  const counts={closed:0,cleared:0,fetch:0,created:0};
  const session={fromPartition:()=>({setPermissionRequestHandler(){},setPermissionCheckHandler(){},cookies:{set:async()=>{}},fetch:async()=>{counts.fetch++;return new Response(image,{headers:{'content-type':'image/png'}})},clearStorageData:async()=>counts.cleared++,clearCache:async()=>{}})};
  class Window{
    constructor(opts){counts.created++;assert.equal(opts.webPreferences.nodeIntegration,false);assert.equal(opts.webPreferences.sandbox,true);assert.equal(opts.webPreferences.contextIsolation,true);assert.equal(opts.webPreferences.preload,undefined);
      this.dead=false;this.webContents=new EventEmitter();this.webContents.setUserAgent=()=>{};this.webContents.setWindowOpenHandler=()=>{};
      this.webContents.executeJavaScript=async code=>vm.runInNewContext(code,{URL,document:{querySelectorAll:()=>[{textContent:JSON.stringify({data:{post:payload},other:{...post,code:'Wrong'}})}],body:{innerText:extra.login?'Log in to continue':''},location:{href:url}}});
    }
    async loadURL(){this.webContents.emit('did-navigate',{},url,extra.status || 200);if(extra.loadError)throw new Error('load error');}
    isDestroyed(){return this.dead;}
    destroy(){this.dead=true;counts.closed++;}
  }
  return {run:createThreadsHandler({BrowserWindow:Window,session,userAgent:'fixture'}),counts};
}
test.after(()=>fs.rmSync(outDir,{recursive:true,force:true}));
test('브라우저→실제 추출 함수→저장 경로와 임시 세션 정리',async()=>{const {run,counts}=setup();const r=await run(url,{outDir});assert.equal(r.ok,true);assert.equal(r.count,2);assert.equal(r.textCount,1);assert.equal(r.mediaCount,1);assert.deepEqual(fs.readFileSync(r.file),image);assert.equal(counts.closed,1);assert.equal(counts.cleared,1);});
test('로그인 장벽, 404, 429에서는 미디어 요청하지 않음',async()=>{for(const x of [{status:404},{status:429},{login:true}]){const {run,counts}=setup(x.login?null:post,x);const r=await run(url,{outDir});assert.equal(r.ok,false);assert.equal(counts.fetch,0);assert.equal(counts.closed,1);if(x.login)assert.equal(r.needsLogin,true);}});
test('프로필/취소는 창을 만들기 전에 끝냄',async()=>{const {run,counts}=setup();assert.match((await run('https://www.threads.com/@tester',{outDir})).error,/개별 게시물/);const ac=new AbortController();ac.abort();assert.equal((await run(url,{outDir,signal:ac.signal})).canceled,true);assert.equal(counts.created,0);});
test('빈 본문은 완료 0개가 아니라 명확한 실패',async()=>{const {run}=setup({code:'Test123',caption:null,user:{username:'tester'},media_type:19});const r=await run(url,{outDir});assert.equal(r.ok,false);assert.equal(r.count,0);assert.match(r.error,/사진이나 영상이 없/);});
test('Netscape 쿠키는 관련 도메인만, 만료 쿠키 제외',()=>{const lines=['# Netscape HTTP Cookie File','.threads.com\tTRUE\t/\tTRUE\t0\tsession\tfixture','#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t0\tsession\tfixture','.evilthreads.com\tTRUE\t/\tTRUE\t0\tsession\tfixture','.threads.com.evil.com\tTRUE\t/\tTRUE\t0\tsession\tfixture','.threads.com\tTRUE\t/\tTRUE\t1\told\tfixture'];const got=parseCookieFile(lines.join('\n'));assert.equal(got.length,2);assert.equal(got[1].httpOnly,true);});
test('Threads는 yt-dlp/gallery-dl 설치 대기 불필요',()=>assert.deepEqual(toolsFor('threads'),[]));
