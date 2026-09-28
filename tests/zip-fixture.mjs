import assert from 'node:assert/strict';
import {crc32,inflateRawSync} from 'node:zlib';

// Independently read the ZIP directory and local entries. This checks the archive
// format, boundaries and content checksums on every OS without a system unzip.
export function readZipArchive(input){
 const bytes=Buffer.from(input);let end=-1;
 for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--)if(bytes.readUInt32LE(offset)===0x06054b50&&offset+22+bytes.readUInt16LE(offset+20)===bytes.length){end=offset;break;}
 assert.ok(end>=0,'ZIP end-of-directory record is missing');
 assert.equal(bytes.readUInt16LE(end+4),0,'archive disk');assert.equal(bytes.readUInt16LE(end+6),0,'directory disk');
 const count=bytes.readUInt16LE(end+10),directorySize=bytes.readUInt32LE(end+12),directoryOffset=bytes.readUInt32LE(end+16);
 assert.equal(bytes.readUInt16LE(end+8),count,'entry count');assert.equal(directoryOffset+directorySize,end,'directory size');
 const entries=new Map(),ranges=[];let cursor=directoryOffset;
 for(let index=0;index<count;index++){
  assert.ok(cursor+46<=end,'central header bounds');assert.equal(bytes.readUInt32LE(cursor),0x02014b50,'central signature');
  const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16),compressedSize=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24),nameSize=bytes.readUInt16LE(cursor+28),extraSize=bytes.readUInt16LE(cursor+30),commentSize=bytes.readUInt16LE(cursor+32),local=bytes.readUInt32LE(cursor+42);
  assert.equal(flags&9,0,'unencrypted entry with inline sizes');assert.ok([0,8].includes(method),'supported ZIP compression');assert.equal(bytes.readUInt16LE(cursor+34),0,'entry disk');
  assert.ok(cursor+46+nameSize+extraSize+commentSize<=end,'central entry bounds');
  const nameBytes=bytes.subarray(cursor+46,cursor+46+nameSize),name=nameBytes.toString('utf8');assert.ok(!entries.has(name),'unique filename');
  assert.ok(local+30<=directoryOffset,'local header bounds');assert.equal(bytes.readUInt32LE(local),0x04034b50,'local signature');
  assert.equal(bytes.readUInt16LE(local+6),flags,'local flags');assert.equal(bytes.readUInt16LE(local+8),method,'local compression');assert.equal(bytes.readUInt32LE(local+14),crc,'local CRC');assert.equal(bytes.readUInt32LE(local+18),compressedSize,'local compressed size');assert.equal(bytes.readUInt32LE(local+22),size,'local size');
  const localNameSize=bytes.readUInt16LE(local+26),localExtraSize=bytes.readUInt16LE(local+28),start=local+30+localNameSize+localExtraSize,finish=start+compressedSize;
  assert.ok(finish<=directoryOffset,'entry payload bounds');assert.deepEqual(bytes.subarray(local+30,local+30+localNameSize),nameBytes,'local filename');
  assert.ok(ranges.every(([begin,end])=>finish<=begin||local>=end),'entries do not overlap');ranges.push([local,finish]);
  const compressed=bytes.subarray(start,finish),data=method===8?inflateRawSync(compressed):compressed;
  assert.equal(data.length,size,'uncompressed size');assert.equal(crc32(data),crc,'content CRC');entries.set(name,data);
  cursor+=46+nameSize+extraSize+commentSize;
 }
 assert.equal(cursor,end,'all central entries consumed');return entries;
}
