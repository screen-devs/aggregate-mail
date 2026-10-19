import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { Readable } from 'node:stream';
import { run } from './emc2.mjs';

const token = 'synthetic-cli-token';
async function invoke(args, options = {}) {
  let stdout = '', stderr = '';
  const code = await run(args, { env: { EMC2_MCP_TOKEN: token },
    out: { write: (v) => { stdout += v; } }, err: { write: (v) => { stderr += v; } }, ...options });
  return { code, stdout, stderr };
}

test('help, validation and private input fail before connecting without echoing arguments', async () => {
  assert.match((await invoke(['help'], { env: {} })).stdout, /Usage: emc2/);
  for (const args of [ ['unknown-secret'], ['archive', 'id'], ['read'], ['list', '--limit', '0'],
    ['list', '--limit', '1e2'], ['list', '--offset', '-1'], ['list', '--category', 'invalid'],
    ['read', 'id', '--unread'], ['accounts', 'extra'], ['accounts', '--confirm'],
    ['status', '--token', 'secret'], ['status', '--url', 'https://127.0.0.1/mcp'],
    ['status', '--url', 'http://example.com/mcp'], ['status', '--url', 'http://secret@localhost/mcp'],
    ['status', '--url', 'http://localhost/mcp?secret'], ['status', '--url', 'http://localhost/api/state'] ]) {
    const result = await invoke(args);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /unknown-secret|example.com|secret@/);
  }
  assert.equal((await invoke(['status'], { env: {} })).code, 2);
  assert.equal((await invoke(['status'], { env: { EMC2_MCP_TOKEN: 'invalid\"token' } })).code, 2);
  assert.equal((await invoke(['status', '--token-stdin'], { stdin: Readable.from(['x'.repeat(4097)]) })).code, 2);
});

test('linked package entrypoint runs help', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'emc2-cli-link-'));
  try {
    const linked = path.join(directory, 'checkout');
    await symlink(fileURLToPath(new URL('..', import.meta.url)), linked,
      process.platform === 'win32' ? 'junction' : 'dir');
    const { stdout } = await promisify(execFile)(process.execPath,
      [path.join(linked, 'scripts', 'emc2.mjs'), 'help']);
    assert.match(stdout, /Usage: emc2/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI uses the real authenticated MCP contract with isolated synthetic encrypted mail', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'emc2-cli-'));
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    import express from 'express';
    const { put, closeStore, all } = await import('./server/store.ts');
    const { providers } = await import('./server/providers.ts');
    const { mountMcp, authorizeMcp } = await import('./server/mcp.ts');
    providers.gmail.update = async () => {};
    put('account', 'fixture-account', { id:'fixture-account', email:'user@example.com', provider:'gmail', credentials:{refreshToken:'fixture-hidden-credential'} });
    put('mail', 'fixture-mail', { id:'fixture-mail', accountId:'fixture-account', remoteId:'1', sender:'Alice', address:'alice@example.com', to:'user@example.com', subject:'Synthetic meeting', preview:'Preview', body:'Synthetic full body', date:1700000000000, unread:true, category:'important', relevance:3, reason:'Team', archived:false, snoozedUntil:null });
    put('mcp', 'settings', { enabled:true, allowSending:false, token:process.env.EMC2_MCP_TOKEN });
    const app = express(); app.use(express.json()); app.use('/mcp', authorizeMcp); mountMcp(app, () => {}, () => {});
    const server = app.listen(0, '127.0.0.1', () => console.log(server.address().port));
    process.on('message', () => server.close(() => { closeStore(); process.disconnect(); }));
  `], { cwd: new URL('..', import.meta.url), env: { ...process.env,
    EMC2_MCP_TOKEN: token, MAIL_DATA_DIR: directory,
    MAIL_CONFIG_PATH: path.join(directory, 'settings.env'), MAIL_DATA_KEY: Buffer.alloc(32, 8).toString('base64'),
  }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  let childError = '';
  child.stderr.on('data', (v) => { childError += v; });
  const lines = createInterface({ input: child.stdout });
  try {
    const [line] = await Promise.race([once(lines, 'line'), exited.then(() => { throw new Error(childError); })]);
    const url = `http://127.0.0.1:${Number(line)}/mcp`;
    const call = (args, options) => invoke([...args, '--url', url, '--json'], options);
    const executable = await promisify(execFile)(process.execPath, ['scripts/emc2.mjs', 'status', '--url', url, '--json'], { cwd: new URL('..', import.meta.url), env: { ...process.env, EMC2_MCP_TOKEN: token } });
    assert.equal(JSON.parse(executable.stdout).connected, true);
    const status = await call(['status']);
    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).tools.length, 8);
    assert.doesNotMatch(status.stdout, /fixture-account|fixture-hidden|synthetic-cli-token/);
    const accounts = await call(['accounts', '--token-stdin'], { env: {}, stdin: Readable.from([token + '\n']) });
    assert.equal(accounts.code, 0, accounts.stderr);
    assert.equal(JSON.parse(accounts.stdout)[0].id, 'fixture-account');
    assert.doesNotMatch(accounts.stdout, /credentials|fixture-hidden/);
    for (const args of [['list', '--account', 'fixture-account', '--unread', '--limit', '1'], ['search', 'meeting']]) {
      const result = await call(args);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).emails[0].id, 'fixture-mail');
    }
    assert.equal(JSON.parse((await call(['search', 'absent'])).stdout).emails.length, 0);
    const read = await call(['read', 'fixture-mail']);
    assert.equal(JSON.parse(read.stdout).body, 'Synthetic full body');
    assert.equal(JSON.parse(read.stdout).unread, true);
    assert.equal(JSON.parse((await call(['thread', 'fixture-mail'])).stdout).emails.length, 1);
    const unauthorized = await call(['status'], { env: { EMC2_MCP_TOKEN: 'wrong-token' } });
    assert.equal(unauthorized.code, 1);
    assert.doesNotMatch(unauthorized.stderr, /wrong-token/);
    assert.equal((await call(['read', 'missing'])).code, 1);
    assert.equal((await call(['mark-read', 'fixture-mail', '--confirm'])).code, 0);
    assert.equal(JSON.parse((await call(['read', 'fixture-mail'])).stdout).unread, false);
    assert.equal((await call(['archive', 'fixture-mail', '--confirm'])).code, 0);
    assert.equal(JSON.parse((await call(['read', 'fixture-mail'])).stdout).category, 'archive');
  } finally {
    lines.close();
    if (child.connected) child.send('stop');
    const [code] = await exited;
    assert.equal(code, 0, childError);
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(handler, work) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await work(`http://127.0.0.1:${server.address().port}/mcp`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('feature detection, pending proposals, rejection, token redaction and uncertain action never retry', async () => {
  let mode = 'pending', calls = 0;
  await fixture(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    if (rpc.method === 'tools/list') result = { tools: mode === 'missing' ? [] : [{ name: 'archive_email', inputSchema: { type: 'object' } }] };
    if (rpc.method === 'tools/call') {
      calls++;
      assert.equal(rpc.params.name, 'archive_email');
      assert.deepEqual(rpc.params.arguments, { id: 'fixture' });
      if (mode === 'disconnect') { req.socket.destroy(); return; }
      result = { content: [{ type: 'text', text: JSON.stringify({ status: 'pending', proposalId: 'proposal', reflected: token }) }], ...(mode === 'error' ? { isError: true } : {}), ...(mode === 'mixed' ? { structuredContent: { status: 'pending', proposalId: 'proposal' }, content: [{ type: 'text', text: 'Approval required in Emc²; do not retry.' }] } : {}) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  }, async (url) => {
    const call = () => invoke(['archive', 'fixture', '--confirm', '--json', '--url', url]);
    const pending = await call();
    assert.equal(pending.code, 0, pending.stderr);
    assert.equal(JSON.parse(pending.stdout).status, 'pending');
    assert.doesNotMatch(pending.stdout, new RegExp(token));
    assert.doesNotMatch(pending.stdout, /completed/);
    mode = 'mixed';
    const mixed = await call();
    assert.equal(mixed.code, 0, mixed.stderr);
    assert.equal(JSON.parse(mixed.stdout).structuredContent.status, 'pending');
    assert.match(mixed.stdout, /Approval required/);
    mode = 'missing';
    assert.equal((await call()).code, 1); assert.equal(calls, 2);
    mode = 'error';
    assert.equal((await call()).code, 1); assert.equal(calls, 3);
    mode = 'disconnect';
    const uncertain = await call();
    assert.equal(uncertain.code, 1); assert.match(uncertain.stderr, /may already exist/);
    assert.equal(calls, 4);
  });
});

test('redirects never reach the destination with bearer authentication', async () => {
  let destinationRequests = 0;
  await fixture((_req, res) => { destinationRequests++; res.writeHead(500).end(); }, async (destination) => {
    await fixture((_req, res) => res.writeHead(307, { Location: destination }).end(), async (url) => {
      assert.equal((await invoke(['status', '--url', url])).code, 1);
      assert.equal(destinationRequests, 0);
    });
  });
});
