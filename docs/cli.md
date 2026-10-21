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

Open Emc² Settings, MCP, and enable MCP. On legacy apps, use the shared MCP
bearer token. On V2, create or select an agent grant, choose the permitted account
and required tools, and use **that agent grant's bearer token** for the CLI.
The shared MCP token can authenticate `status` without an agent identity, but
does not authorize scoped work or draft tools. Each work tool is default-off;
enable only those you intend to use. Keep the app running. Do not pass the token as an argument or save it in a script or shell
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
Discovery does not prove permission. The app may advertise a tool and still
reject it because its explicit account/tool grant is off. There are no automatic retries. If the connection fails
after an action request, check Emc² and the provider before retrying; an action
or proposal may already exist. Each HTTP request has a 15-second timeout.

## Projects and commitments

These commands need an app advertising the four scoped work tools. They fail
without calling an unavailable tool on older apps. Each tool needs its own grant;
listing tools with `status` does not check grants.

```sh
emc2 projects --account 'account-id'
emc2 commitments --account 'account-id'
emc2 create-project project.json --confirm
emc2 track-commitment commitment.json --confirm
```

Creation **saves local work immediately**. It is not a proposal and needs no
later per-item approval. `--confirm` authorizes that save. Projects and all
source/evidence messages must belong to one allowed account. Lists are scoped
by the app and can omit unavailable or mixed-account evidence. Commitments
include closed records; the CLI cannot update, complete, cancel or delete them.

Example `project.json` (replace the synthetic account and message IDs):

```json
{
  "requestId": "2ad866b0-cb93-4f75-95a8-96093fe40e25",
  "accountId": "account-id",
  "name": "Project name",
  "sourceMailIds": ["message-id"]
}
```

Example `commitment.json`:

```json
{
  "requestId": "ef4c7efc-5c62-4676-8830-f060bc41d55a",
  "accountId": "account-id",
  "sourceMailId": "message-id",
  "text": "Prepare the estimate",
  "reason": "Customer requested an estimate",
  "status": "needs-work",
  "dueDate": "2026-11-01"
}
```

Generate a fresh UUID **once per intended creation** with
`node -e "console.log(require('node:crypto').randomUUID())"`, put it in the file,
and retain that file. Do not reuse the example UUID for unrelated work. These
caller-owned files can contain private text; protect and dispose of them yourself.
The CLI reads them and never saves credentials or a request log.

Creation input is strict JSON, at most 2 MiB. Unknown fields fail before
connecting. Work text is trimmed and limited to 2000 characters. Project
`sourceMailIds` requires 1..200 IDs; optional commitment `evidenceMailIds`
accepts 0..200 and defaults to `[]`. Mail IDs accept 1..300 characters.
Commitment status must be `needs-reply`, `needs-work` or `waiting`.
Optional `projectId` links same-account work. Use either a real `dueDate`
(`YYYY-MM-DD`) or `dueAt` (epoch milliseconds), never both. Optional
`followUpAt` is also epoch milliseconds. Timestamps must be integers in
0..253402300799999. Reminders are local, with no external calendar action.

After an error or lost response, list scoped saved work and check Emc² before
continuing. Keep the original request ID and identical input. Never generate a
new UUID to retry an uncertain creation. The app accepts identical replay only
while the saved record is unchanged at revision 1 and current grants and sources
still validate. An edited record or changed payload can conflict. A sanitized
error does not reliably distinguish a denied grant from a conflict.

## Draft proposals

```sh
emc2 propose-draft draft.json --confirm
```

Requires the explicit `propose_draft` tool and grant. Example `draft.json`:

```json
{
  "accountId": "account-id",
  "content": {
    "to": "recipient@example.com",
    "subject": "Estimate",
    "body": "Here is the draft for review."
  }
}
```

This requests an encrypted draft proposal for review in Emc². It never sends.
A pending proposal is not a saved, approved draft. Optional `sourceMailId`
links source mail; content accepts `cc`, `inReplyTo`, `threadId` and `references`.
Recipient and subject may be incomplete or empty. Body is plain text, up to
1,000,000 characters. Attachments and `sendUnknown` input are not supported.
If the response is lost, inspect Emc² before requesting again; draft proposals
have no caller request ID and repeating one may create another proposal.

## Remaining workflow stages

| Workflow | CLI support |
| --- | --- |
| Cached mail | List, search, read and thread |
| Organization | Confirmed read/archive requests through existing gates |
| Local work | Scoped lists and confirmed project/commitment creation |
| Drafts | Request a draft proposal for app review |
| Reply/send | Needs a contract that explicitly guarantees reviewed behavior |
| Draft list/edit/delete, sync, further organization | Needs scoped app tools |
| Installation | Checkout plus optional `npm link`; no installer-provided command |

No generic tool caller or proposal approval is exposed. The integrated V2 server
exposes 13 tools with explicit account and tool grants. Feature detection preserves older-app compatibility. No server,
store or desktop changes are included in the CLI work.

## Output and exit codes

Success writes indented JSON to stdout. `--json` writes compact JSON for
scripts. Successful tool data is preserved, including pending status and
warnings. Responses with structured data retain both `structuredContent` and
`content` so accompanying warnings remain available. A zero exit code means a successful MCP response, not provider
completion or delivery. Errors write a non-secret explanation to stderr without
raw server errors. The bearer token is redacted if reflected in successful data.

- `0`: help, connected status or a successful tool result.
- `1`: unavailable tool, authentication/transport failure or app tool error.
- `2`: invalid command/options or missing/invalid token input or invalid JSON file.

Synthetic tests exercise the real MCP server with an isolated encrypted store
and stubbed provider updates. Additional fixtures cover V2 pending proposals,
missing tools, rejected requests, redirects and a lost action response without
retry. They do not establish native installation, live provider behavior or
V2 installed-app acceptance. Work/draft fixtures independently model the frozen
uncommitted V2 contract; they do not run that server or prove its persistence.
