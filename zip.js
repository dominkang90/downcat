'use strict';
// 받냥이 ZIP 풀기: 도구 설치용으로 ZIP 안의 "필요한 파일 몇 개"만 꺼낸다(외부 프로그램·PowerShell 안 씀).
// ffmpeg ZIP은 200MB라 통째로 메모리에 올리지 않고, 해당 파일 구간만 읽어서 바로 풀어 쓴다.
// 지원: 저장(0)·deflate(8) 방식, ZIP64(4GB 넘는 ZIP 형식) — 도구 배포 ZIP이 쓰는 방식 전부.
const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = fs.readSync(fd, buf, off, len - off, pos + off);
    if (!n) break;
    off += n;
  }
  return buf.subarray(0, off);
}

// 64비트 숫자 읽기(파일 크기 안에서는 Number로 충분)
const u64 = (b, o) => Number(b.readBigUInt64LE(o));

// ZIP 목록(central directory)을 읽는다 → [{name, method, compSize, size, crc, localOffset}]
function listEntries(fd, fileSize) {
  // 1) 맨 끝에서 EOCD(목록 끝 표시, 서명 0x06054b50)를 찾는다. 주석이 있을 수 있어 최대 64KB 뒤진다.
  const tailLen = Math.min(fileSize, 65557);
  const tail = readAt(fd, fileSize - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 파일이 아니에요(끝 표시 없음)');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  // 2) ZIP64면 값이 0xFFFF.. 로 채워져 있고, 진짜 값은 ZIP64 레코드에 있다.
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('ZIP64 위치 정보가 없어요');
    const z64Pos = u64(tail, loc + 8);
    const z64 = readAt(fd, z64Pos, 56);
    if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('ZIP64 레코드가 깨졌어요');
    count = u64(z64, 32); cdSize = u64(z64, 40); cdOffset = u64(z64, 48);
  }
  const cd = readAt(fd, cdOffset, cdSize);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 목록이 깨졌어요');
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let compSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    // ZIP64 추가 정보(0x0001): 0xFFFFFFFF인 값만 순서대로 들어 있다
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let e = 0; e + 4 <= extra.length;) {
      const id = extra.readUInt16LE(e), len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(extra, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(extra, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(extra, q); q += 8; }
      }
      e += 4 + len;
    }
    entries.push({ name, method, compSize, size, crc, localOffset, encrypted: !!(flags & 1) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// 크기·CRC 확인용 통과 필터
function checker(entry) {
  let n = 0, crc = 0;
  const hasCrc = typeof zlib.crc32 === 'function';
  return new Transform({
    transform(chunk, _enc, cb) { n += chunk.length; if (hasCrc) crc = zlib.crc32(chunk, crc); cb(null, chunk); },
    flush(cb) {
      if (n !== entry.size) return cb(new Error(`${entry.name}: 크기가 달라요 (${n} ≠ ${entry.size})`));
      if (hasCrc && (crc >>> 0) !== entry.crc) return cb(new Error(`${entry.name}: CRC가 달라요(파일 손상)`));
      cb();
    },
  });
}

/**
 * zipPath 안에서 wanted({대상파일경로: 이름판별함수 또는 정규식})에 맞는 파일을 꺼낸다.
 * 하나라도 못 찾으면 에러. 반환: {대상파일경로: ZIP 안 이름}
 */
async function extractFiles(zipPath, wanted) {
  const fd = fs.openSync(zipPath, 'r');
  let entries;
  try { entries = listEntries(fd, fs.fstatSync(fd).size); }
  finally { fs.closeSync(fd); }
  const found = {};
  for (const [dest, match] of Object.entries(wanted)) {
    const test = typeof match === 'function' ? match : (n) => match.test(n);
    const entry = entries.find(e => !e.name.endsWith('/') && test(e.name));
    if (!entry) throw new Error(`압축 안에서 ${dest.split(/[\\/]/).pop()}을(를) 못 찾았어요`);
    if (entry.encrypted) throw new Error(`${entry.name}: 암호 걸린 파일은 못 풀어요`);
    if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name}: 지원 안 하는 압축 방식(${entry.method})`);
    // 로컬 헤더 길이를 읽어 실제 데이터 시작 위치를 구한다
    const fd2 = fs.openSync(zipPath, 'r');
    let dataStart;
    try {
      const lh = readAt(fd2, entry.localOffset, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`${entry.name}: 파일 머리말이 깨졌어요`);
      dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    } finally { fs.closeSync(fd2); }
    const src = entry.compSize > 0
      ? fs.createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compSize - 1 })
      : require('stream').Readable.from([]);
    const stages = [src];
    if (entry.method === 8) stages.push(zlib.createInflateRaw());
    stages.push(checker(entry), fs.createWriteStream(dest));
    await pipeline(...stages);
    found[dest] = entry.name;
  }
  return found;
}

module.exports = { extractFiles, listEntries };
