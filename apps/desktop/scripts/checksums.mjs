import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
const files=(await readdir('release')).filter(name=>/\.(exe|dmg|zip)$/u.test(name)).sort();
if(files.length===0) throw new Error('No installers to checksum.');
const lines=[];
for(const file of files) {
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(`release/${file}`)) hash.update(chunk);
 lines.push(`${hash.digest('hex')}  ${file}`);
}
await writeFile('release/SHA256SUMS.txt',lines.join('\n')+'\n');
