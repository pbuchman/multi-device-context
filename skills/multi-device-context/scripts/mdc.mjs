#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

class InputError extends Error {}
const args = process.argv.slice(2);
const command = args.shift();
const flags = {};
for (let i = 0; i < args.length;) {
  if (args[i].startsWith('--')) {
    const name = args.splice(i, 1)[0].slice(2);
    flags[name] = name === 'once' || name === 'code' ? true : args.splice(i, 1)[0];
  } else i++;
}
const help = `MDC agent CLI (Node.js 22+)
Config: MDC_CONFIG or ~/.config/multi-device-context/agent.json (mode 0600).
JSON: {"url":"https://your-host","key":"your-agent-key"}
Commands:
  list [--after CURSOR] [--limit 50]
  get CONTEXT_ID
  watch [--after CURSOR] [--once]
  create --text TEXT [--code] [--id UUID] [--item-id UUID]
  append CONTEXT_ID --text TEXT [--code] [--item-id UUID]
  rename CONTEXT_ID --title TITLE
  delete CONTEXT_ID [ITEM_ID]
  upload CONTEXT_ID FILE [--type MIME] [--item-id UUID]
  download CONTEXT_ID ITEM_ID OUTPUT
Use --file FILE instead of --text for long text. '-' reads stdin.
Watch emits JSON lines; save cursor only after processing the event.
Delete is permanent. Keys have full access to their owner's contexts.`;
if (!command || command === 'help' || flags.help) { console.log(help); process.exit(0); }
try {
  const file = process.env.MDC_CONFIG ?? join(homedir(), '.config/multi-device-context/agent.json');
  const info = await stat(file);
  if (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid())) throw new InputError('Config must be owned by you with mode 0600');
  const config = JSON.parse(await readFile(file, 'utf8'));
  const url = new URL(config.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^mdc_/.test(config.key)) throw new InputError('Invalid agent configuration');
  const base = url.origin + '/api/agent/v1/contexts';
  const id = value => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? '')) throw new InputError('A valid UUID is required'); return value; };
  async function request(path = '', method = 'GET', body, binary = false) {
    const response = await fetch(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(binary ? 300_000 : 30_000),
      headers: { authorization: `Bearer ${config.key}`, ...(body ? { 'content-type': binary ? 'application/octet-stream' : 'application/json' } : {}) },
      ...(body ? { body: binary ? body : JSON.stringify(body) } : {}), ...(binary && body ? { duplex: 'half' } : {}) });
    if (!response.ok) throw new InputError(`API returned ${response.status}${response.status === 429 ? '; retry after ' + response.headers.get('retry-after') + ' seconds' : ''}`);
    return response;
  }
  const output = value => console.log(JSON.stringify(value));
  const page = async (path, after) => (await request(path + '?' + new URLSearchParams({ limit: String(flags.limit ?? 50), ...(after ? { after } : {}) }))).json();
  if (command === 'list') output(await page('', flags.after));
  else if (command === 'get') {
    const context = await (await request('/' + id(args[0]))).json();
    const items = []; let after;
    do { const result = await page(`/${args[0]}/items`, after); items.push(...result.records); after = result.hasMore ? result.cursor : undefined; } while (after);
    output({ context, items });
  } else if (command === 'watch') {
    let after = flags.after;
    while (true) {
      const result = await page('', after);
      // A page is a single checkpoint: the consumer commits this cursor after all records are processed.
      if (result.records.length) output({ type: 'contexts.created', contexts: result.records, cursor: result.cursor });
      after = result.cursor ?? after;
      if (result.hasMore) continue;
      if (flags.once) break;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  } else if (command === 'create' || command === 'append') {
    let text = flags.text;
    if (flags.file === '-') { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); text = Buffer.concat(chunks).toString('utf8'); }
    else if (flags.file) text = await readFile(flags.file, 'utf8');
    if (!text) throw new InputError('Supply --text or --file');
    const item = { id: id(flags['item-id'] ?? randomUUID()), content: { kind: flags.code ? 'code' : 'text', text } };
    const contextId = id(command === 'create' ? flags.id ?? randomUUID() : args[0]);
    const result = await request(command === 'create' ? '' : `/${contextId}/items`, 'POST', command === 'create' ? { id: contextId, item } : item);
    output({ context: await result.json(), itemId: item.id });
  } else if (command === 'rename') output(await (await request('/' + id(args[0]), 'PATCH', { title: flags.title })).json());
  else if (command === 'delete') { await request('/' + id(args[0]) + (args[1] ? '/items/' + id(args[1]) : ''), 'DELETE'); output({ deleted: true }); }
  else if (command === 'download') {
    if (!args[2]) throw new InputError('Output path required');
    const response = await request(`/${id(args[0])}/items/${id(args[1])}/content`, 'GET', undefined, true);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(args[2], { flags: 'wx', mode: 0o600 }));
    output({ saved: args[2] });
  } else if (command === 'upload') {
    const contextId = id(args[0]); const path = args[1]; const size = (await stat(path)).size;
    const itemId = id(flags['item-id'] ?? randomUUID());
    await request(`/${contextId}/items`, 'POST', { id: itemId, content: { kind: 'attachment', name: basename(path), size, contentType: flags.type ?? 'application/octet-stream' } });
    await request(`/${contextId}/items/${itemId}/content`, 'PUT', createReadStream(path), true);
    output({ contextId, itemId, uploaded: true });
  } else throw new InputError('Unknown command; run help');
} catch (error) {
  // Do not print fetch exceptions or request objects: they can contain credentials.
  console.error(error instanceof InputError ? error.message : 'Command failed; check the input files, connectivity and private configuration');
  process.exitCode = 1;
}
