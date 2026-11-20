'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createProfileCollector}=require('../threads-profile-browser');
const target={kind:'profile',username:'tester',url:'https://www.threads.com/@tester/media'};
const url=n=>'https://www.threads.com/@tester/post/P'+n;
const opts={pollIntervalMs:1,timeoutMs:1000,maxRounds:30,threadsProfileLimit:0};
const connection=(next,code='Net')=>({data:{mediaData:{edges:[{node:{thread_items:[{post:{code,user:{username:'tester'}}}]}}],page_info:{has_next_page:next}}}});
function setup(extra={}){
  const counts={created:0,closed:0,storage:0,cache:0,reads:0,scrolls:0,attached:0,detached:0,cookies:[],commands:[]};
  let wc;
  const ses={setPermissionRequestHandler(fn){counts.permission=fn;},setPermissionCheckHandler(fn){counts.check=fn;},cookies:{set:async c=>{counts.cookies.push(c);if(extra.cookieSet)await extra.cookieSet(c);}},clearStorageData:async()=>{counts.storage++;},clearCache:async()=>{counts.cache++;}};
  const session={fromPartition(p){counts.partition=p;return ses;}};
  class Window{
    constructor(config){
      counts.created++;counts.config=config;
      assert.equal(config.show,false);assert.equal(config.webPreferences.nodeIntegration,false);assert.equal(config.webPreferences.contextIsolation,true);assert.equal(config.webPreferences.sandbox,true);assert.equal(config.webPreferences.webSecurity,true);assert.equal(config.webPreferences.preload,undefined);
      this.dead=false;wc=this.webContents=new EventEmitter();
      wc.setUserAgent=x=>{counts.ua=x;};wc.setWindowOpenHandler=fn=>{assert.deepEqual(fn(),{action:'deny'});};
      wc.executeJavaScript=async source=>{
        if(/return module\.exports\.advanceProfile\(/.test(source)){counts.scrolls++;return extra.advance?extra.advance(counts.scrolls,wc):{moved:false,top:0,height:100};}
        counts.reads++;
        if(extra.read)return extra.read(counts.reads,wc);
        return extra.states?.[Math.min(counts.reads-1,extra.states.length-1)] || {urls:[url(1)],hasNext:null,loginWall:false};
      };
      if(extra.debugger){
        const dbg=wc.debugger=new EventEmitter();
        dbg.attach=()=>{if(extra.attachFails)throw new Error('unsupported');counts.attached++;};dbg.detach=()=>{counts.detached++;};
        dbg.sendCommand=async(method,args)=>{counts.commands.push(method);if(method==='Network.enable'){if(extra.enableFails)throw new Error('unsupported');return {};}
          return extra.body?extra.body(args.requestId):{body:JSON.stringify(connection(false)),base64Encoded:false};};
      }
    }
    async loadURL(u){counts.loaded=u;wc.emit('did-navigate',{},u,extra.status || 200);if(extra.load)return extra.load(wc);}
    isDestroyed(){return this.dead;}
    destroy(){this.dead=true;counts.closed++;}
  }
  const run=createProfileCollector({BrowserWindow:Window,session,userAgent:'fixture',parseCookieFile:extra.parse});
  return {run,counts,get wc(){return wc;}};
}
function response(wc,id,status=200){wc.debugger.emit('message',{},'Network.responseReceived',{requestId:id,response:{url:'https://www.threads.com/graphql/query',status}});wc.debugger.emit('message',{},'Network.loadingFinished',{requestId:id,encodedDataLength:100});}
test('default limit 50, site order, normalized Set dedup, progress and isolated cleanup',async()=>{
  const states=[{urls:Array.from({length:60},(_,i)=>url(i)),hasNext:true}];const s=setup({states}),events=[];
  const r=await s.run(target,{pollIntervalMs:1},e=>events.push(e));assert.equal(r.stopReason,'limit');assert.equal(r.complete,true);assert.equal(r.urls.length,50);assert.equal(r.urls[49],url(49));assert.equal(events.at(-1).discovered,50);assert.equal(s.counts.closed,1);assert.equal(s.counts.storage,1);assert.equal(s.counts.cache,1);assert.match(s.counts.partition,/^downcat-profile-/);
});
test('explicit limit and only profile owner canonical URLs',async()=>{
  const s=setup({states:[{urls:['https://www.threads.net/@TESTER/post/P1?x=1',url(1),'https://www.threads.com/@other/post/P3',url(2),url(3)]}]});
  const r=await s.run(target,{...opts,threadsProfileLimit:2});assert.equal(r.stopReason,'limit');assert.deepEqual(r.urls,[url(1),url(2)]);
});
test('DOM-only fallback cannot claim full from unchanged page',async()=>{const s=setup();const r=await s.run(target,opts);assert.equal(r.complete,false);assert.equal(r.stopReason,'stalled');assert.ok(s.counts.reads>=8);});
test('initial empty shell waits, virtualization retains earlier URLs, moving scroll never stalls',async()=>{
  const s=setup({read:n=>({urls:n<10?[]:[url(n)],hasNext:null}),advance:()=>({moved:true})});
  const r=await s.run(target,{...opts,threadsProfileLimit:3});assert.equal(r.stopReason,'limit');assert.deepEqual(r.urls,[url(10),url(11),url(12)]);
});
test('initial apparent login must persist; transient login does not block',async()=>{const s=setup({states:[{urls:[],loginWall:true},{urls:[],loginWall:true},{urls:[url(1)]}]});const r=await s.run(target,{...opts,threadsProfileLimit:1});assert.equal(r.stopReason,'limit');});
test('confirmed login wall is incomplete with needsLogin',async()=>{const s=setup({states:[{urls:[],loginWall:true}]});const r=await s.run(target,opts);assert.equal(r.stopReason,'login');assert.equal(r.needsLogin,true);assert.equal(s.counts.reads,3);});
test('explicit terminal page_info waits a poll then reports true end',async()=>{const s=setup({states:[{urls:[url(1)],hasNext:false}]});const r=await s.run(target,opts);assert.equal(r.stopReason,'end');assert.equal(r.complete,true);assert.equal(s.counts.reads,2);});
test('empty terminal page is actual full empty, not initial zero shell',async()=>{const s=setup({states:[{urls:[],hasNext:null},{urls:[],hasNext:null},{urls:[],hasNext:false,empty:true}]});const r=await s.run(target,opts);assert.equal(r.stopReason,'end');assert.deepEqual(r.urls,[]);assert.equal(s.counts.reads,4);});
test('HTTP rate/login/not-found statuses',async()=>{for(const [status,reason] of [[429,'rate-limit'],[401,'login'],[403,'login'],[404,'error']]){const s=setup({status});const r=await s.run(target,opts);assert.equal(r.stopReason,reason);assert.equal(r.complete,false);assert.equal(s.counts.closed,1);}});
test('pre-abort creates no session/window',async()=>{const ac=new AbortController();ac.abort();const s=setup();const r=await s.run(target,{...opts,signal:ac.signal});assert.equal(r.stopReason,'canceled');assert.equal(s.counts.created,0);assert.equal(s.counts.partition,undefined);});
test('cancel and timeout race hung navigation with cleanup',async()=>{
  for(const cancel of [true,false]){const ac=new AbortController();const s=setup({load:()=>new Promise(()=>{})});const p=s.run(target,{...opts,timeoutMs:15,signal:ac.signal});if(cancel)setTimeout(()=>ac.abort(),2);const r=await p;assert.equal(r.stopReason,cancel?'canceled':'timeout');assert.equal(r.complete,false);assert.equal(s.counts.closed,1);assert.equal(s.counts.storage,1);}
});
test('cancel during executeJavaScript and polling; partial URLs survive',async()=>{
  const ac=new AbortController();const s=setup({read:n=>{if(n===2){ac.abort();return new Promise(()=>{});}return {urls:[url(1)]};}});
  const r=await s.run(target,{...opts,signal:ac.signal});assert.equal(r.stopReason,'canceled');assert.deepEqual(r.urls,[url(1)]);assert.equal(s.counts.closed,1);
});
test('maxRounds reports timeout, never full even with moving scroll',async()=>{const s=setup({advance:()=>({moved:true})});const r=await s.run(target,{...opts,maxRounds:2});assert.equal(r.stopReason,'timeout');assert.equal(r.complete,false);assert.equal(s.counts.reads,2);});
test('persistent app session reused only useCookie without file; never cleared',async()=>{const s=setup();await s.run(target,{...opts,useCookie:true,threadsProfileLimit:1});assert.equal(s.counts.partition,'persist:downcat');assert.equal(s.counts.storage,0);assert.equal(s.counts.cache,0);});
test('cookieFile always temporary and imports only relevant domains',async()=>{
  const s=setup({parse:()=>[{url:'https://www.threads.com/',name:'fixture',value:'x'},{url:'https://instagram.com/',name:'fixture',value:'x'},{url:'https://threads.com.evil.test/',name:'fixture',value:'x'},{url:'https://www.threads.com/',domain:'.evil.test',name:'fixture',value:'x'}]});
  await s.run(target,{...opts,cookieFile:__filename,useCookie:true,threadsProfileLimit:1});assert.equal(s.counts.cookies.length,2);assert.notEqual(s.counts.partition,'persist:downcat');assert.equal(s.counts.storage,1);
});
test('cancel in cookie import prevents next cookie/window and clears session',async()=>{
  const ac=new AbortController();const s=setup({parse:()=>Array.from({length:3},()=>({url:'https://www.threads.com/',name:'fixture',value:'x'})),cookieSet:()=>{ac.abort();}});
  const r=await s.run(target,{...opts,cookieFile:__filename,signal:ac.signal});assert.equal(r.stopReason,'canceled');assert.equal(s.counts.cookies.length,1);assert.equal(s.counts.created,0);assert.ok(s.counts.storage>=1);
});
test('optional debugger observes browser JSON with prefix, reports end, detaches',async()=>{
  const s=setup({debugger:true,load:wc=>response(wc,'one'),body:()=>({body:'for(;;);'+JSON.stringify(connection(false)),base64Encoded:false})});
  const r=await s.run(target,opts);assert.equal(r.stopReason,'end');assert.ok(r.urls.includes('https://www.threads.com/@tester/post/Net'));assert.equal(s.counts.attached,1);assert.equal(s.counts.detached,1);assert.equal(s.wc.debugger.listenerCount('message'),0);assert.deepEqual([...new Set(s.counts.commands)],['Network.enable','Network.getResponseBody']);
});
test('later network true invalidates initial DOM false and old network false',async()=>{
  const s=setup({debugger:true,states:[{urls:[url(1)],hasNext:false}],load:wc=>response(wc,'first'),advance:(n,wc)=>{if(n===1)response(wc,'second');return {moved:false};},body:id=>({body:JSON.stringify(connection(id==='second',id)),base64Encoded:false})});
  const r=await s.run(target,opts);assert.equal(r.stopReason,'stalled');assert.equal(r.complete,false);assert.equal(r.urls.length,3);
});
test('later unrecognized network body cannot reuse stale terminal false',async()=>{
  const s=setup({debugger:true,states:[{urls:[url(1)],hasNext:false}],load:wc=>response(wc,'first'),advance:(n,wc)=>{if(n===1)response(wc,'second');return {moved:false};},body:id=>({body:JSON.stringify(id==='first'?connection(false):{unknown:true}),base64Encoded:false})});
  const r=await s.run(target,opts);assert.equal(r.complete,false);assert.equal(r.stopReason,'stalled');
});
test('debugger attach/enable failure gracefully falls back to DOM',async()=>{for(const mode of ['attachFails','enableFails']){const s=setup({debugger:true,[mode]:true});const r=await s.run(target,opts);assert.equal(r.stopReason,'stalled');assert.equal(r.complete,false);assert.equal(s.wc.debugger.listenerCount('message'),0);}});
test('network 429 and 401 are explicit partial stops',async()=>{for(const status of [429,401]){const s=setup({debugger:true,load:wc=>response(wc,'rate',status)});const r=await s.run(target,opts);assert.equal(r.stopReason,status===429?'rate-limit':'login');assert.equal(r.complete,false);assert.equal(s.counts.detached,1);}});
test('oversized/unreadable network bodies are not full completion',async()=>{const s=setup({debugger:true,load:wc=>response(wc,'large'),body:()=>({body:'x'.repeat(15*1024*1024+1)})});const r=await s.run(target,opts);assert.equal(r.complete,false);assert.equal(r.stopReason,'stalled');});
test('blocked external navigation does not open a second window',async()=>{const s=setup({load:wc=>{let blocked=false;wc.emit('will-redirect',{preventDefault(){blocked=true;}},'https://www.instagram.com/accounts/login/');assert.equal(blocked,true);}});const r=await s.run(target,opts);assert.equal(r.stopReason,'login');assert.equal(s.counts.created,1);});

test('out-of-order older terminal body cannot replace newest true',async()=>{
  let release;
  const s=setup({debugger:true,load:wc=>{response(wc,'old');response(wc,'new');},body:id=>id==='old'?new Promise(resolve=>{release=()=>resolve({body:JSON.stringify(connection(false,'Old'))});}):{body:JSON.stringify(connection(true,'New'))},advance:n=>{if(n===1)release();return {moved:false};}});
  const r=await s.run(target,opts);assert.equal(r.stopReason,'stalled');assert.equal(r.complete,false);assert.equal(r.urls.length,3);
});
test('cancellation after parsing cookies imports nothing',async()=>{
  const ac=new AbortController();const s=setup({parse:()=>{ac.abort();return [{url:'https://www.threads.com/',name:'fixture',value:'x'}];}});
  const r=await s.run(target,{...opts,cookieFile:__filename,signal:ac.signal});assert.equal(r.stopReason,'canceled');assert.equal(s.counts.cookies.length,0);assert.equal(s.counts.created,0);assert.equal(s.counts.storage,1);
});
test('late pending cookie completion is cleared again after cancellation',async()=>{
  let finish;const ac=new AbortController();const s=setup({parse:()=>[{url:'https://www.threads.com/',name:'fixture',value:'x'}],cookieSet:()=>new Promise(resolve=>{finish=resolve;setTimeout(()=>ac.abort(),1);})});
  const r=await s.run(target,{...opts,cookieFile:__filename,signal:ac.signal});assert.equal(r.stopReason,'canceled');const before=s.counts.storage;finish();await new Promise(resolve=>setTimeout(resolve,1));assert.ok(s.counts.storage>before);assert.equal(s.counts.created,0);
});
test('network rate-limit interrupts hanging navigation immediately',async()=>{
  const s=setup({debugger:true,load:wc=>{response(wc,'rate',429);return new Promise(()=>{});}});
  const r=await s.run(target,{...opts,timeoutMs:500});assert.equal(r.stopReason,'rate-limit');assert.equal(s.counts.closed,1);
});
test('base64 network JSON is read without private API requests',async()=>{
  const s=setup({debugger:true,load:wc=>response(wc,'b64'),body:()=>({body:Buffer.from(JSON.stringify(connection(false))).toString('base64'),base64Encoded:true})});
  const r=await s.run(target,opts);assert.equal(r.stopReason,'end');assert.ok(r.urls.some(x=>x.endsWith('/Net')));assert.ok(s.counts.commands.every(x=>['Network.enable','Network.getResponseBody'].includes(x)));
});
test('progress callback errors do not corrupt collection or cleanup',async()=>{const s=setup();const r=await s.run(target,{...opts,threadsProfileLimit:1},()=>{throw new Error('UI gone');});assert.equal(r.stopReason,'limit');assert.equal(s.counts.closed,1);});
