// Packs extension/ into a zip for the Chrome Web Store upload
// (docs/chrome-web-store.md). The store assigns its own key, so the
// development "key" is left out of the uploaded manifest.
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {crc32, deflateRawSync} from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'extension');

async function files(directory, prefix = '') {
  const out = [];
  for (const entry of await readdir(path.join(directory, prefix), {withFileTypes: true})) {
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await files(directory, name)));
    else if (entry.isFile() && !entry.name.startsWith('.')) out.push(name);
  }
  return out.sort();
}

function zip(entries) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const {name, data} of entries) {
    const packed = deflateRawSync(data),
      nameBytes = Buffer.from(name),
      crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const entries = [];
for (const name of await files(source)) {
  let data = await readFile(path.join(source, name));
  if (name === 'manifest.json') {
    const {key: _key, ...manifest} = JSON.parse(data.toString());
    data = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  }
  entries.push({name, data});
}
const {version} = JSON.parse((await readFile(path.join(source, 'manifest.json'))).toString());
const output = path.join(root, 'release', `autojob-extension-${version}.zip`);
await mkdir(path.dirname(output), {recursive: true});
await writeFile(output, zip(entries));
console.log(output);
