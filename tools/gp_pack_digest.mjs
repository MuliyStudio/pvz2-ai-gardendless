// 计算 GP-Next pack 快照 digest：与游戏 assets/pack-snapshot 的 U() 一致。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/gp_pack_digest.mjs <pack-dir>'); process.exit(1); }

const files = new Map();
function walk(cur, rel) {
  for (const name of fs.readdirSync(cur)) {
    const full = path.join(cur, name);
    const r = rel ? rel + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, r);
    else files.set(r, fs.readFileSync(full));
  }
}
walk(dir, '');

const names = [...files.keys()].sort();
const prefix = Buffer.from('gp-next-pack-snapshot-v1\0', 'utf8');
const parts = [prefix];
for (const name of names) {
  const nb = Buffer.from(name, 'utf8');
  const len = Buffer.alloc(12);
  len.writeUInt32BE(nb.length, 0);
  len.writeBigUInt64BE(BigInt(files.get(name).length), 4);
  parts.push(len, nb, files.get(name));
}
const hash = crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex');
console.log(JSON.stringify({ dir, files: names, digest: hash }, null, 2));
