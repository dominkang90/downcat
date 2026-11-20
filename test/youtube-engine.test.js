'use strict';
// 실제 engine 코드 + 모의 하위 프로세스. 실제 인터넷/네이티브 다운로드 검증은 아니다.
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('fs'), path=require('path'), vm=require('vm'), {createRequire}=require('module'), {EventEmitter}=require('events');
const root=fs.mkdtempSync(path.join(__dirname,'yt-engine-'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
let serial=0;
function setup({deno=true,mode='ok',controller=null}={}){
 const dir=path.join(root,String(++serial)),bin=path.join(dir,'bin'),out=path.join(dir,'out');fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(out);if(deno)fs.writeFileSync(path.join(bin,'deno.exe'),'fixture-not-executable');
 const calls=[];const cp={execFileSync(){throw Error('no PATH ffmpeg');},execFile(_f,_a,_o,cb){cb(Error('no thumbnails'));},spawn(cmd,args,opts){
  calls.push({cmd,args,opts});const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  queueMicrotask(()=>{
   if(args.includes('-J')){child.stdout.emit('data',Buffer.from(JSON.stringify({title:'형식 검사',formats:[{format_id:'18',ext:'mp4',vcodec:'h264',acodec:'aac',height:360}]})));child.emit('close',0);return;}
   if(mode==='runtime'){child.stderr.emit('data',Buffer.from('WARNING: No supported JavaScript runtime could be found\nERROR: HTTP Error 403: Forbidden\n'));child.emit('close',1);return;}
   const count=mode==='empty'?0:mode==='ok'?2:1;
   for(let i=0;i<count;i++){const file=path.join(out,`영상 ${i}.dat`);fs.writeFileSync(file,`verified fixture ${i}`);child.stdout.emit('data',Buffer.from(`DCFILE:${file}\n`));}
   if(mode==='cancel'){controller.abort();child.emit('error',Object.assign(Error('aborted'),{name:'AbortError'}));child.emit('close',null);return;}
   if(mode==='partial')child.stderr.emit('data',Buffer.from('ERROR: Video unavailable\n'));
   child.emit('close',mode==='partial'?1:0);
  });return child;
 }};
 const filename=path.resolve(__dirname,'../engine.js'),realRequire=createRequire(filename),mod={exports:{}};
 const wrap=vm.runInThisContext(`(function(require,module,exports,__dirname,__filename){${fs.readFileSync(filename,'utf8')}\n})`,{filename});
 wrap(name=>name==='child_process'?cp:realRequire(name),mod,mod.exports,path.dirname(filename),filename);
 const engine=mod.exports;engine.setBinDir(bin);return {engine,bin,out,calls};
}
const channel='https://www.youtube.com/@kax-ai-kr';
for(const url of [channel,channel+'/videos',channel+'/shorts','https://youtu.be/12345678901','https://music.youtube.com/watch?v=12345678901'])test('YouTube 런타임 명시: '+url,()=>{
 const {engine,bin}=setup();const a=engine.ytdlpArgs(url,'out',{});assert(a.includes('--ignore-config'));assert(a.includes('--no-js-runtimes'));assert.equal(a[a.indexOf('--js-runtimes')+1],'deno:'+path.join(bin,'deno.exe'));assert.equal(a.at(-1),url);assert(!a.includes('--no-playlist'));assert(!a.includes('--ignore-errors'));
});
for(const url of ['https://video.example/watch','https://youtube.com.evil.test/watch','https://example.com/?next=youtube.com'])test('다른 사이트에는 적용 안 함: '+url,()=>{const {engine}=setup({deno:false});const a=engine.ytdlpArgs(url,'out',{});assert(!a.includes('--js-runtimes'));assert(!a.includes('--ignore-config'));});
test('Deno 없으면 실행 전 정확한 오류와 done 1회',async()=>{const {engine,out,calls}=setup({deno:false});const ev=[];const r=await engine.download(channel,{outDir:out},e=>ev.push(e));assert.equal(r.ok,false);assert.match(r.error,/Deno/);assert.equal(r.needsLogin,undefined);assert.equal(calls.length,0);assert.equal(ev.filter(e=>e.type==='done').length,1);});
test('포맷 조회에도 같은 런타임 인자',async()=>{const {engine,bin,calls}=setup();const r=await engine.probeFormats('https://www.youtube.com/watch?v=12345678901');assert.equal(r.ok,true);assert.equal(calls[0].args[calls[0].args.indexOf('--js-runtimes')+1],'deno:'+path.join(bin,'deno.exe'));assert(calls[0].args.includes('--ignore-config'));});
test('포맷 조회도 Deno 없으면 실행하지 않음',async()=>{const {engine,calls}=setup({deno:false});const r=await engine.probeFormats('https://youtu.be/12345678901');assert.equal(r.ok,false);assert.match(r.error,/Deno/);assert.equal(calls.length,0);});
test('채널 파일 2개 집계와 단일 완료 이벤트',async()=>{const {engine,out,calls}=setup();const ev=[];const r=await engine.download(channel,{outDir:out},e=>ev.push(e));assert.equal(r.ok,true);assert.equal(r.count,2);assert.equal(calls[0].args.at(-1),channel);assert.equal(ev.filter(e=>e.type==='done').length,1);});
test('채널 일부 실패 시 완료 파일 유지',async()=>{const {engine,out}=setup({mode:'partial'});const r=await engine.download(channel,{outDir:out});assert.equal(r.ok,false);assert.equal(r.count,1);assert(fs.existsSync(r.file));assert.match(r.error,/unavailable/);});
test('채널 취소 시 이미 완료한 파일 유지',async()=>{const controller=new AbortController();const {engine,out}=setup({mode:'cancel',controller});const ev=[];const r=await engine.download(channel,{outDir:out,signal:controller.signal},e=>ev.push(e));assert.equal(r.ok,false);assert.equal(r.canceled,true);assert.equal(r.count,1);assert(fs.existsSync(r.file));assert.equal(ev.filter(e=>e.type==='done').length,1);});
test('YouTube 빈 결과를 성공으로 보고하지 않음',async()=>{const {engine,out}=setup({mode:'empty'});fs.writeFileSync(path.join(out,'다른 작업.dat'),'unrelated');const r=await engine.download(channel,{outDir:out});assert.equal(r.ok,false);assert.equal(r.count,0);assert.match(r.error,/파일|영상/);});
test('실행기 오류를 로그인 오류로 오인하지 않음',async()=>{const {engine,out}=setup({mode:'runtime'});const r=await engine.download(channel,{outDir:out});assert.equal(r.ok,false);assert.match(r.error,/Deno|실행기/);assert.equal(r.needsLogin,undefined);});
