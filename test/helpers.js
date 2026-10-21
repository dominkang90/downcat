'use strict';
// 테스트 도우미: 작은 ZIP 만들기, 가짜 GitHub(릴리스 API + 파일 받기) 서버.
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

let CRC_TABLE;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// {이름: Buffer} → ZIP Buffer (deflate). 폴더 항목도 넣어 실제 배포 ZIP처럼 만든다.
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  const entries = [];
  for (const name of Object.keys(files)) {
    const dirs = name.split('/').slice(0, -1);
    for (let i = 1; i <= dirs.length; i++) {
      const d = dirs.slice(0, i).join('/') + '/';
      if (!entries.some(e => e.name === d)) entries.push({ name: d, data: Buffer.alloc(0) });
    }
    entries.push({ name, data: files[name] });
  }
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = data.length ? zlib.deflateRawSync(data) : Buffer.alloc(0);
    const method = data.length ? 8 : 0;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/**
 * 가짜 GitHub. releases[repo] = { tag_name, body?, published_at?, assets: [{name, data, digest?: true|false|'sha256:..'}] }
 * GET /repos/<repo>/releases/latest → 릴리스 JSON,  GET /dl/<repo>/<name> → 파일
 * hold(name)로 특정 파일 응답을 붙잡아 두었다가 release(name)로 풀 수 있다(설치 중 상황 만들기).
 */
async function startFakeGithub() {
  const releases = {};
  const hits = { api: 0, dl: {} };
  const held = new Map(); // name → {promise, release}
  const server = http.createServer(async (req, res) => {
    const api = req.url.match(/^\/repos\/(.+)\/releases\/latest$/);
    if (api) {
      hits.api++;
      const rel = releases[api[1]];
      if (!rel) { res.writeHead(404); res.end('{}'); return; }
      const base = `http://127.0.0.1:${server.address().port}`;
      const json = {
        tag_name: rel.tag_name, body: rel.body || '', published_at: rel.published_at || '2026-10-20T18:27:00Z',
        assets: rel.assets.map(a => ({
          name: a.name, size: a.data.length, updated_at: rel.published_at || '2026-10-20T18:27:00Z',
          browser_download_url: `${base}/dl/${api[1]}/${encodeURIComponent(a.name)}`,
          digest: a.digest === true ? 'sha256:' + sha256(a.data) : (a.digest || null),
        })),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); return;
    }
    const dl = req.url.match(/^\/dl\/(.+)\/([^/]+)$/);
    if (dl) {
      const name = decodeURIComponent(dl[2]);
      const a = (releases[dl[1]] || { assets: [] }).assets.find(x => x.name === name);
      if (!a) { res.writeHead(404); res.end(); return; }
      hits.dl[name] = (hits.dl[name] || 0) + 1;
      if (held.has(name)) await held.get(name).promise;
      res.writeHead(200, { 'Content-Length': a.data.length }); res.end(a.data); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`, releases, hits,
    hold(name) { let release; const promise = new Promise(r => { release = r; }); held.set(name, { promise, release }); },
    release(name) { const h = held.get(name); if (h) { held.delete(name); h.release(); } },
    close() { for (const h of held.values()) h.release(); server.close(); },
  };
}

module.exports = { makeZip, startFakeGithub, sha256 };
