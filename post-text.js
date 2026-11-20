'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {safePart,parsePostUrl}=require('./threads');
const POST_TEXT_RE=/^[a-z0-9_-]+_post(?:_[a-f0-9]{12})?\.txt$/i;
function formatPostText(post){
  let source='확인되지 않음';try{const parsed=(post.platform==='x'?require('./x').parsePostUrl:post.platform==='telegram'?require('./telegram').parsePostUrl:parsePostUrl)(post.sourceUrl);if(parsed.code===post.code)source=parsed.url+(post.platform==='telegram'&&parsed.single?'?single':'');}catch{}
  const stamp=post.publishedAt && Number.isFinite(Date.parse(post.publishedAt))?new Date(post.publishedAt).toISOString():'확인되지 않음';
  const author=typeof post.author==='string'?post.author:'확인되지 않음',name=typeof post.authorName==='string'?post.authorName:'';
  const linkText=(post.platform==='telegram'&&Array.isArray(post.links)?post.links:[]).flatMap(l=>{try{const u=new URL(l.url);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?[String(l.text||u.href).replace(/[\r\n]/g,' ')+': '+u.href]:[];}catch{return [];}}).join('\n');
  return (post.platform==='telegram'?'Telegram':post.platform==='x'?'X':'Threads')+' 게시물\n'+(post.platform==='telegram'?'게시 채널':'작성자')+': '+(name?name+' ':'')+'(@'+author+')\n작성 시각(UTC): '+stamp+'\n원문: '+source+'\n게시물 코드: '+post.code+'\n\n[본문]\n'+(post.text || '(본문 없는 미디어 게시물)')+(linkText?'\n\n[본문 안 링크]\n'+linkText:'')+'\n\n사진·영상은 같은 폴더에 별도 파일로 저장합니다. 이 문서는 입력한 게시물의 본문이며 댓글·인용글 전체를 포함하지 않습니다.\n';
}
async function savePostText(post,dir,signal){
  signal?.throwIfAborted();await fs.mkdir(dir,{recursive:true});
  const buffer=Buffer.from('\ufeff'+formatPostText(post),'utf8');
  if(buffer.length>5*1024*1024)throw Error('본문 크기가 저장 한도를 넘었어요.');
  const stem=safePart(post.code)+'_post',temp=path.join(dir,stem+'.'+crypto.randomBytes(6).toString('hex')+'.part');
  const candidates=[path.join(dir,stem+'.txt'),path.join(dir,stem+'_'+crypto.createHash('sha256').update(buffer).digest('hex').slice(0,12)+'.txt')];
  try{
    await fs.writeFile(temp,buffer,{flag:'wx'});signal?.throwIfAborted();
    for(const file of candidates){
      signal?.throwIfAborted();
      try{await fs.link(temp,file);return {file,bytes:buffer.length};}
      catch(e){if(e.code!=='EEXIST')throw e;const stat=await fs.lstat(file);if(stat.isFile()&&stat.size===buffer.length&&(await fs.readFile(file)).equals(buffer))return {file,bytes:buffer.length};}
    }
    throw Error('기존 본문 파일과 충돌하여 덮어쓰지 않았어요.');
  }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
}
async function openPostText(file,outDir,open){
  if(typeof file!=='string'||!POST_TEXT_RE.test(path.basename(file)))throw Error('받냥이가 저장한 본문 TXT만 열 수 있어요.');
  const [root,actual]=await Promise.all([fs.realpath(outDir),fs.realpath(file)]);
  const relative=path.relative(root,actual);if(!relative||relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative)||!POST_TEXT_RE.test(path.basename(actual)))throw Error('저장 폴더 밖의 파일은 열 수 없어요.');
  const st=await fs.stat(actual);if(!st.isFile()||st.size>5*1024*1024)throw Error('본문 파일을 확인할 수 없어요.');
  const error=await open(actual);if(error)throw Error('본문 파일을 열지 못했어요: '+String(error));return true;
}
module.exports={POST_TEXT_RE,formatPostText,savePostText,openPostText};
