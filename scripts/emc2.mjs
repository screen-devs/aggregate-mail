#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { fileInput } from './emc2-input.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const help = `Usage: emc2 <command> [arguments] [options]

  help                      Show this help without connecting
  status                    Check authentication and list available tool names
  accounts                  List accounts without credentials
  list                      List cached mail, newest first
  search <query>            Search cached sender, address, subject and body
  read <id>                 Read cached mail without marking it read
  thread <id>               Read a cached conversation
  mark-read <id> --confirm   Request mark-read through the app's existing gate
  archive <id> --confirm     Request archive through the app's existing gate
  projects --account <id>    List scoped local projects
  commitments --account <id> List scoped local work, including closed records
  create-project <file> --confirm   Save a local project immediately
  track-commitment <file> --confirm Save local open work immediately
  propose-draft <file> --confirm    Request a draft proposal for app review

Options:
  --url <url>       Local MCP endpoint (default http://127.0.0.1:32145/mcp)
  --token-stdin     Read bearer token from standard input, never an argument
  --json           Compact JSON output (default: indented JSON)
  --account <id>   Filter list/search or scope projects/commitments
  --category <c>   important, other, snoozed or archive (list/search)
  --unread         Only unread mail (list/search)
  --limit <n>      Page size, 1..100 (default 25)
  --offset <n>     Page offset, 0 or greater (default 0)
  --confirm        Explicitly request an action or creation; never approves proposals
  --help, -h       Show help

Enable MCP in Emc² Settings and keep the app running. Supply its bearer token
with --token-stdin or the transient EMC2_MCP_TOKEN environment variable.
Actions may complete immediately on legacy apps or return pending proposals on
V2. Inspect the result and review proposals in Emc². Never assume completion.
Work creation files require a stable UUID requestId. Keep the original file.
Discovery does not imply permission; each tool needs its app grant.
No automatic retries. After uncertain creation, list scoped saved work first.
Draft proposals never send. After an uncertain action, check Emc² first.
`;

function command(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
    url: { type: 'string' }, 'token-stdin': { type: 'boolean' },
    account: { type: 'string' }, category: { type: 'string' },
    unread: { type: 'boolean' }, limit: { type: 'string' }, offset: { type: 'string' },
    confirm: { type: 'boolean' },
  } });
  const [name = 'help', argument] = positionals;
  if (values.help || name === 'help') return { help: true };
  const tools = { accounts: 'list_accounts', list: 'list_emails', search: 'search_emails',
    read: 'read_email', thread: 'get_thread', 'mark-read': 'mark_read', archive: 'archive_email',
    projects: 'list_projects', commitments: 'list_commitments', 'create-project': 'create_project',
    'track-commitment': 'track_commitment', 'propose-draft': 'propose_draft' };
  if (name !== 'status' && !Object.hasOwn(tools, name)) throw new Error();
  const file = ['create-project', 'track-commitment', 'propose-draft'].includes(name);
  const scoped = ['projects', 'commitments'].includes(name);
  const needsArgument = file || ['search', 'read', 'thread', 'mark-read', 'archive'].includes(name);
  if (positionals.length !== (needsArgument ? 2 : 1) || (needsArgument && !argument?.trim())) throw new Error();
  const paged = ['list', 'search'].includes(name);
  const mutation = file || ['mark-read', 'archive'].includes(name);
  for (const option of Object.keys(values)) {
    if (option === 'account' && !paged && !scoped) throw new Error();
    if (['category', 'unread', 'limit', 'offset'].includes(option) && !paged) throw new Error();
    if (option === 'confirm' && !mutation) throw new Error();
  }
  if (mutation && !values.confirm) throw new Error();
  const input = file ? fileInput(name, argument) : {};
  if (scoped) {
    if (!values.account?.trim() || values.account.trim().length > 2000) throw new Error();
    input.accountId = values.account.trim();
  }
  if (paged) {
    for (const [flag, fallback, min, max] of [['limit', 25, 1, 100], ['offset', 0, 0, Number.MAX_SAFE_INTEGER]]) {
      const raw = values[flag];
      const value = raw === undefined ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error();
      input[flag] = value;
    }
    if (values.category && !['important', 'other', 'snoozed', 'archive'].includes(values.category)) throw new Error();
    if (values.category) input.category = values.category;
    if (values.account) input.accountId = values.account;
    input.unreadOnly = !!values.unread;
  }
  if (name === 'search') {
    if (argument.trim().length > 2000) throw new Error();
    input.query = argument;
  } else if (needsArgument && !file) input.id = argument;
  if (name === 'read') input.markRead = false;
  const url = new URL(values.url || 'http://127.0.0.1:32145/mcp');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/mcp' || url.search || url.hash) throw new Error();
  return { name, tool: tools[name], input, values, url, mutation, creation: ['create-project', 'track-commitment'].includes(name) };
}

export async function run(args, { env = process.env, stdin = process.stdin, out = process.stdout, err = process.stderr } = {}) {
  let request;
  try { request = command(args); } catch {
    err.write('Invalid command, options or JSON input. Run emc2 help. Actions and creation require --confirm.\n');
    return 2;
  }
  if (request.help) { out.write(help); return 0; }
  const { values, url } = request;
  let token = env.EMC2_MCP_TOKEN;
  if (values['token-stdin']) {
    if (stdin.isTTY) { err.write('Pipe the MCP token from a private secret source to standard input.\n'); return 2; }
    const chunks = [];
    let size = 0;
    for await (const chunk of stdin) {
      size += Buffer.byteLength(chunk);
      if (size > 4096) { err.write('Invalid MCP token input.\n'); return 2; }
      chunks.push(chunk);
    }
    token = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString().trim();
  }
  if (!token || token.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
    err.write('Supply a valid MCP token via --token-stdin or EMC2_MCP_TOKEN.\n'); return 2;
  }
  const client = new Client({ name: 'emc2-cli', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    // Reject redirects so a local endpoint cannot forward the bearer token.
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([
      ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(15000),
    ]) }),
    reconnectionOptions: { maxRetries: 0 },
  });
  try {
    await client.connect(transport);
    const names = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      names.push(...page.tools.map((tool) => tool.name));
      if (page.nextCursor && page.nextCursor === cursor) throw new Error();
      cursor = page.nextCursor;
    } while (cursor);
    let result;
    if (request.name === 'status') result = { connected: true, tools: names };
    else {
      if (!names.includes(request.tool)) {
        err.write('This app does not advertise the required tool. No action requested.\n'); return 1;
      }
      const response = await client.callTool({ name: request.tool, arguments: request.input });
      if (response.isError) {
        err.write(request.creation
          ? 'Creation not confirmed. List scoped saved work; retain the original requestId and identical input. Never retry with a new UUID.\n'
          : 'App rejected the operation. Check Emc²; do not retry an uncertain action.\n'); return 1;
      }
      // Preserve pending proposals and warnings verbatim; acceptance is not completion.
      result = response.structuredContent === undefined ? response.content.map((part) => {
        if (part.type !== 'text') return part;
        try { return JSON.parse(part.text); } catch { return part.text; }
      }) : { structuredContent: response.structuredContent, content: response.content };
      if (Array.isArray(result) && result.length === 1) result = result[0];
    }
    // Never echo the bearer token, even if a faulty endpoint reflects it.
    out.write(JSON.stringify(result, null, values.json ? 0 : 2).split(token).join('[redacted]') + '\n');
    return 0;
  } catch {
    err.write(request.creation
      ? 'Creation not confirmed. List scoped saved work; retain the original requestId and identical input. Never retry with a new UUID.\n'
      : request.mutation
      ? 'No confirmed action result. Check Emc² before retrying; a proposal or action may already exist.\n'
      : 'MCP connection or request failed. Check the running app, MCP setting and token.\n');
    return 1;
  } finally { await client.close().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
