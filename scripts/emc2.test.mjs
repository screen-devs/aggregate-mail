import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
    put('mcp', 'settings', { enabled:true, allowSending:false, token:'synthetic-global-discovery-token' });
    put('agent', 'fixture-agent', { id:'fixture-agent', name:'CLI fixture', accountIds:['fixture-account'], tools:['list_accounts','list_emails','search_emails','read_email','get_thread','mark_read','archive_email','list_projects','list_commitments','create_project','track_commitment','propose_draft'], token:process.env.EMC2_MCP_TOKEN, createdAt:1700000000000 });
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
    assert.deepEqual(JSON.parse(status.stdout).tools.length, 13);
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
    const discoveryOnly = await call(['projects', '--account', 'fixture-account'], { env: { EMC2_MCP_TOKEN: 'synthetic-global-discovery-token' } });
    assert.equal(discoveryOnly.code, 1);
    for (const command of ['mark-read', 'archive']) {
      const result = await call([command, 'fixture-mail', '--confirm']);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, 'pending');
    }
    const unchanged = JSON.parse((await call(['read', 'fixture-mail'])).stdout);
    assert.equal(unchanged.unread, true);
    assert.equal(unchanged.category, 'important');
    await inputFile(async (filename, save) => {
      await save(projectInput);
      const created = await call(['create-project', filename, '--confirm']);
      assert.equal(created.code, 0, created.stderr);
      const project = JSON.parse(created.stdout);
      assert.deepEqual(JSON.parse((await call(['create-project', filename, '--confirm'])).stdout), project);
      assert.equal(JSON.parse((await call(['projects', '--account', 'fixture-account'])).stdout).projects[0].id, project.id);
      await save({ ...commitmentInput, projectId: project.id });
      const tracked = await call(['track-commitment', filename, '--confirm']);
      assert.equal(tracked.code, 0, tracked.stderr);
      const commitment = JSON.parse(tracked.stdout);
      assert.deepEqual(JSON.parse((await call(['track-commitment', filename, '--confirm'])).stdout), commitment);
      assert.equal(JSON.parse((await call(['commitments', '--account', 'fixture-account'])).stdout).commitments[0].id, commitment.id);
      await save(draftInput);
      const draft = await call(['propose-draft', filename, '--confirm']);
      assert.equal(draft.code, 0, draft.stderr);
      assert.equal(JSON.parse(draft.stdout).status, 'pending');
    });
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

const projectInput = { requestId: '2ad866b0-cb93-4f75-95a8-96093fe40e25', accountId: 'fixture-account',
  name: 'Synthetic project', sourceMailIds: ['fixture-mail'] };
const commitmentInput = { requestId: 'ef4c7efc-5c62-4676-8830-f060bc41d55a', accountId: 'fixture-account',
  sourceMailId: 'fixture-mail', text: 'Send synthetic estimate', reason: 'Explicit request', status: 'needs-work' };
const draftInput = { accountId: 'fixture-account', sourceMailId: 'fixture-mail',
  content: { to: 'recipient@example.com', subject: 'Synthetic draft', body: 'Draft for review' } };

async function inputFile(work) {
  const directory = await mkdtemp(path.join(tmpdir(), 'emc2-cli-input-'));
  const filename = path.join(directory, 'input.json');
  try { await work(filename, (value) => writeFile(filename, JSON.stringify(value))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('work and draft validation rejects unsafe input before connecting and does not echo content', async () => {
  for (const args of [['projects'], ['commitments', '--account', ' '], ['projects', '--account', 'a', '--limit', '1'],
    ['create-project', 'absent.json'], ['propose-draft', 'absent.json'],
    ['create-project', 'absent.json', '--confirm']]) assert.equal((await invoke(args)).code, 2);
  await inputFile(async (filename, save) => {
    const invalid = [
      ['create-project', { ...projectInput, requestId: 'invalid' }],
      ['create-project', { ...projectInput, sourceMailIds: [] }],
      ['create-project', { ...projectInput, sourceMailIds: ['x'.repeat(301)] }],
      ['create-project', { ...projectInput, sourceMailIds: Array(201).fill('id') }],
      ['create-project', { ...projectInput, accountId: ' ' }],
      ['create-project', { ...projectInput, name: 'x'.repeat(2001) }],
      ['create-project', { ...projectInput, credentials: 'private-fixture' }],
      ['track-commitment', { ...commitmentInput, status: 'done' }],
      ['track-commitment', { ...commitmentInput, status: 'cancelled' }],
      ['track-commitment', { ...commitmentInput, dueDate: '2026-02-29' }],
      ['track-commitment', { ...commitmentInput, dueDate: '0000-01-01' }],
      ['track-commitment', { ...commitmentInput, dueDate: '2028-02-29', dueAt: 0 }],
      ['track-commitment', { ...commitmentInput, dueAt: -1 }],
      ['track-commitment', { ...commitmentInput, dueAt: 1.5 }],
      ['track-commitment', { ...commitmentInput, followUpAt: 253402300800000 }],
      ['track-commitment', { ...commitmentInput, evidenceMailIds: [''] }],
      ['propose-draft', { ...draftInput, content: { ...draftInput.content, sendUnknown: true } }],
      ['propose-draft', { ...draftInput, content: { ...draftInput.content, attachments: [] } }],
    ];
    for (const [command, value] of invalid) {
      await save(value);
      const result = await invoke([command, filename, '--confirm']);
      assert.equal(result.code, 2, command);
      assert.equal(result.stdout, '');
      assert.doesNotMatch(result.stderr, /private-fixture|Synthetic|input.json/);
    }
    await writeFile(filename, 'invalid JSON');
    assert.equal((await invoke(['create-project', filename, '--confirm'])).code, 2);
    await writeFile(filename, 'x'.repeat(2 * 1024 * 1024 + 1));
    assert.equal((await invoke(['create-project', filename, '--confirm'])).code, 2);
  });
});

test('feature-detected work commands preserve caller UUID, scoped reads, immediate saves and draft proposals', async () => {
  let expectedTool, expectedInput;
  let mode = 'success', calls = 0;
  await fixture(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    if (rpc.method === 'tools/list') result = { tools: mode === 'missing' ? [] : [{ name: expectedTool, inputSchema: { type: 'object' } }] };
    if (rpc.method === 'tools/call') {
      calls++;
      assert.equal(rpc.params.name, expectedTool);
      assert.deepEqual(rpc.params.arguments, expectedInput);
      if (mode === 'disconnect') { req.socket.destroy(); return; }
      const project = { id: 'project', name: 'Synthetic project', sourceMailIds: ['fixture-mail'],
        accountIds: ['fixture-account'], crossAccountConfirmed: false, revision: 1, updatedAt: 1700000000000 };
      const { requestId: _requestId, ...fields } = expectedInput;
      const commitment = { ...fields, evidenceMailIds: fields.evidenceMailIds || [],
        id: 'commitment', revision: 1, updatedAt: 1700000000000,
        ...(fields.dueDate ? { dueAt: Date.parse(`${fields.dueDate}T12:00:00Z`) } : {}),
        ...(fields.dueAt !== undefined ? { dueDate: new Date(fields.dueAt).toISOString().slice(0, 10) } : {}),
        history: [{ at: 1700000000000, text: fields.text, reason: fields.reason,
          status: fields.status, evidenceMailIds: fields.evidenceMailIds || [] }] };
      const value = expectedTool === 'list_projects' ? { projects: [project] }
        : expectedTool === 'list_commitments' ? { commitments: [{ accountId: commitmentInput.accountId, sourceMailId: commitmentInput.sourceMailId,
          text: commitmentInput.text, reason: commitmentInput.reason, id: 'closed', evidenceMailIds: [],
          revision: 1, updatedAt: 1700000000000, status: 'done', history: [] }] }
        : expectedTool === 'propose_draft' ? { id: 'proposal', agentId: 'fixture-agent', accountId: 'fixture-account',
          action: 'draft', payload: { ...draftInput.content, accountId: 'fixture-account' },
          sourceMailId: 'fixture-mail', digest: 'fixture-digest', createdAt: 1700000000000, status: 'pending' }
        : expectedTool === 'create_project' ? project : commitment;
      result = { content: [{ type: 'text', text: JSON.stringify(value) }], ...(mode === 'denied' ? { isError: true } : {}) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  }, async (url) => {
    const call = (args) => invoke([...args, '--url', url, '--json']);
    for (const [command, tool, key] of [['projects', 'list_projects', 'projects'], ['commitments', 'list_commitments', 'commitments']]) {
      expectedTool = tool; expectedInput = { accountId: 'fixture-account' };
      const result = await call([command, '--account', 'fixture-account']);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout)[key].length, 1);
      if (command === 'commitments') assert.equal(JSON.parse(result.stdout).commitments[0].status, 'done');
      mode = 'denied';
      const denied = await call([command, '--account', 'fixture-account']);
      assert.equal(denied.code, 1); assert.equal(denied.stdout, '');
      mode = 'success';
    }
    await inputFile(async (filename, save) => {
      for (const [command, tool, input] of [
        ['create-project', 'create_project', projectInput],
        ['track-commitment', 'track_commitment', { ...commitmentInput, evidenceMailIds: [], dueDate: '2028-02-29', followUpAt: 0, projectId: 'project' }],
        ['track-commitment', 'track_commitment', { ...commitmentInput, evidenceMailIds: ['evidence'], dueAt: 253402300799999 }],
        ['propose-draft', 'propose_draft', draftInput],
      ]) {
        await save(input); expectedTool = tool; expectedInput = input;
        const before = calls;
        mode = 'success';
        const result = await call([command, filename, '--confirm']);
        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        if (command === 'propose-draft') assert.equal(output.status, 'pending');
        else {
          assert.equal(Object.hasOwn(output, 'requestId'), false);
          assert.equal(output.revision, 1);
          if (command === 'track-commitment') assert.equal(output.status, input.status);
          else assert.deepEqual(output.accountIds, [input.accountId]);
        }
        assert.equal(calls, before + 1);
        mode = 'missing';
        assert.equal((await call([command, filename, '--confirm'])).code, 1);
        assert.equal(calls, before + 1);
        mode = 'denied';
        const denied = await call([command, filename, '--confirm']);
        assert.equal(denied.code, 1); assert.equal(denied.stdout, ''); assert.equal(calls, before + 2);
        mode = 'disconnect';
        const uncertain = await call([command, filename, '--confirm']);
        assert.equal(uncertain.code, 1); assert.equal(calls, before + 3);
        assert.match(uncertain.stderr, command === 'propose-draft' ? /may already exist/ : /original requestId and identical input/);
      }
      // The server default is materialized without inventing a fresh request ID.
      await save(commitmentInput); expectedTool = 'track_commitment'; expectedInput = { ...commitmentInput, evidenceMailIds: [] }; mode = 'success';
      assert.equal((await call(['track-commitment', filename, '--confirm'])).code, 0);
    });
  });
});
