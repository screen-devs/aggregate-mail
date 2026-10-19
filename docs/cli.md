# Emc² CLI

The CLI uses the running app's authenticated local MCP endpoint. It needs Node
24 or newer and the source checkout's locked dependencies (`npm ci`). It does
not open the database, read app keys, start a service or connect accounts.
Desktop installers do not install this command on PATH.

Run `npm run cli -- help` or `node scripts/emc2.mjs help` from the checkout.
Optionally run `npm link` to expose the package's `emc2` command on PATH. This
changes your local npm links; the package remains private and is not published.
The examples below use the direct Node entrypoint and work without linking.

## Connect privately

Open Emc² Settings, MCP, enable MCP, and copy its bearer token. Keep the app
running. Do not pass the token as an argument or save it in a script or shell
configuration. The CLI never saves credentials.

In Bash, read the token without echo or shell-history exposure:

```sh
read -rs -p 'MCP token: ' EMC2_MCP_TOKEN
echo
export EMC2_MCP_TOKEN
node scripts/emc2.mjs status
# Clear it when finished:
unset EMC2_MCP_TOKEN
```

In PowerShell 7, use `$env:EMC2_MCP_TOKEN = Read-Host -MaskInput 'MCP token'`,
then `node scripts/emc2.mjs status`. Clear it with
`Remove-Item Env:EMC2_MCP_TOKEN` when finished. An environment variable remains
visible to processes with sufficient access. For a secret manager, pipe its
plain token output directly to the command with `--token-stdin` instead. Do
not use `echo <token>` or paste the token into a command line.

`status` checks MCP authentication and reports only `connected` and available
tool names. It does not retrieve mail or account settings. Help needs no token.
The default URL is `http://127.0.0.1:32145/mcp`. Use `--url` for a different
local port. Only HTTP, `127.0.0.1` or `localhost`, and the exact `/mcp` path are
accepted. URL credentials, query strings and redirects are rejected.

## Read cached mail

```sh
node scripts/emc2.mjs accounts
node scripts/emc2.mjs list --unread --limit 25 --offset 0
node scripts/emc2.mjs search 'meeting' --category important --json
node scripts/emc2.mjs read 'message-id'
node scripts/emc2.mjs thread 'message-id'
```

`list` and `search` accept `--account <id>`, `--category important|other|snoozed|archive`,
`--unread`, `--limit 1..100` and `--offset 0..`. Results include `nextOffset`;
pass that value as the next offset until it is null. Search uses the MCP
case-insensitive substring contract, not the desktop's advanced search syntax.
Only cached mail is covered. The CLI does not refresh the provider.

`read` always sends `markRead: false`. These commands output private mail and
addresses on request; the desktop's hidden-text preference does not redact CLI
output. Treat terminal output, pipes and saved files accordingly. JSON escapes
mail control characters rather than rendering terminal escape sequences.

## Request mailbox actions

```sh
node scripts/emc2.mjs mark-read 'message-id' --confirm
node scripts/emc2.mjs archive 'message-id' --confirm
```

These are explicit requests through the advertised `mark_read` and
`archive_email` tools. Archive never means delete. On legacy apps these tools
can immediately change the provider and cache. On V2 they can return immutable
pending proposals. The CLI preserves the app's result and does not approve
proposals or label an accepted request as a completed mailbox change. Review
pending proposals in Emc². `--confirm` only confirms making the request.

Tools are discovered before use; a missing tool fails without calling it.
The CLI exposes no generic tool caller, proposal approval, reply or send command.
Project and commitment APIs are not present on this source baseline and are
not implemented here. There are no automatic retries. If the connection fails
after an action request, check Emc² and the provider before retrying; an action
or proposal may already exist. Each HTTP request has a 15-second timeout.

## Output and exit codes

Success writes indented JSON to stdout. `--json` writes compact JSON for
scripts. Successful tool data is preserved, including pending status and
warnings. Responses with structured data retain both `structuredContent` and
`content` so accompanying warnings remain available. A zero exit code means a successful MCP response, not provider
completion or delivery. Errors write a non-secret explanation to stderr without
raw server errors. The bearer token is redacted if reflected in successful data.

- `0`: help, connected status or a successful tool result.
- `1`: unavailable tool, authentication/transport failure or app tool error.
- `2`: invalid command/options or missing/invalid token input.

Synthetic tests exercise the real MCP server with an isolated encrypted store
and stubbed provider updates. Additional fixtures cover V2 pending proposals,
missing tools, rejected requests, redirects and a lost action response without
retry. They do not establish native installation, live provider behavior or
V2 installed-app acceptance.
