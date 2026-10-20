import assert from "node:assert/strict";
import { test } from "node:test";
import type { Draft, DraftContent } from "../shared/types";
import type { Api } from "./api";
import { composeContent, DraftSession, type Compose, type DraftProgress } from "./compose/draft-session";

const initial: Compose = {
  accountId: "synthetic", to: "recipient@example.com", subject: "Synthetic subject", body: "Synthetic body",
};
const blank: Compose = { accountId: initial.accountId, to: "", subject: "", body: "" };
const rawError = "Synthetic private response must never reach progress";
const saved = (content: Compose = initial, revision = 4): Draft => ({
  ...composeContent(content), id: "synthetic-draft", revision, updatedAt: 1,
  sendUnknown: Boolean(content.sendUnknown),
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
type Request = { url: string; method: string; body?: unknown };
type Intercept = (request: Request, commit: () => unknown) => unknown | Promise<unknown>;

function fixture(record?: Draft) {
  let remote = record && structuredClone(record);
  let active = 0;
  let maxActive = 0;
  const requests: Request[] = [];
  const progress: DraftProgress[] = [];
  const control: { intercept?: Intercept } = {};
  const apply = (request: Request): unknown => {
    if (request.method === "POST") {
      const content = request.body as DraftContent;
      for (const key of Object.keys(content))
        assert.ok(["to", "cc", "attachments", "subject", "body", "inReplyTo", "threadId", "references", "sendUnknown"].includes(key));
      remote = saved({ ...content, accountId: initial.accountId }, 1);
      return structuredClone(remote);
    }
    if (!remote) throw Object.assign(new Error(rawError), { status: 404 });
    if (request.method === "GET") return structuredClone(remote);
    const input = request.body as DraftContent & { revision: number; confirmUnknown?: boolean };
    if (input.revision !== remote.revision)
      throw Object.assign(new Error(rawError), { status: 409 });
    if (request.method === "PUT") {
      const { revision, ...content } = input;
      assert.ok(!("accountId" in content));
      if (remote.sendUnknown && content.sendUnknown === false)
        throw Object.assign(new Error(rawError), { status: 409 });
      remote = {
        ...content, id: remote.id, accountId: remote.accountId, updatedAt: remote.updatedAt + 1,
        revision: revision + 1, sendUnknown: remote.sendUnknown || Boolean(content.sendUnknown),
      };
      return structuredClone(remote);
    }
    assert.equal(request.method, "DELETE");
    assert.equal(input.confirmUnknown, true);
    remote = undefined;
    return { ok: true };
  };
  const api: Api = async <T,>(url: string, method = "GET", body?: unknown): Promise<T> => {
    const request = { url, method, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) };
    requests.push(request);
    if (method !== "GET") maxActive = Math.max(maxActive, ++active);
    try {
      return await (control.intercept ? control.intercept(request, () => apply(request)) : apply(request)) as T;
    } finally {
      if (method !== "GET") active--;
    }
  };
  return {
    api, requests, progress, control,
    get remote() { return remote; },
    set remote(value: Draft | undefined) { remote = value; },
    get maxActive() { return maxActive; },
    session: (content: Compose | Draft = initial) => new DraftSession(api, content, (value) => progress.push(value)),
    methods: () => requests.map((request) => request.method),
  };
}

test("content normalization strips metadata, orders fields and copies reply references", () => {
  const draft = saved({ ...initial, inReplyTo: "synthetic-parent", threadId: "synthetic-thread", references: ["synthetic-ref"] });
  const normalized = composeContent(draft);
  assert.deepEqual(Object.keys(normalized), [
    "accountId", "to", "subject", "body", "inReplyTo", "threadId", "references", "sendUnknown",
  ]);
  assert.equal(normalized.sendUnknown, false);
  assert.equal("id" in normalized, false);
  assert.equal("revision" in normalized, false);
  assert.equal("updatedAt" in normalized, false);
  draft.references!.push("later-reference");
  assert.deepEqual(normalized.references, ["synthetic-ref"]);
  assert.equal(JSON.stringify(normalized), JSON.stringify(composeContent({
    references: ["synthetic-ref"], threadId: "synthetic-thread", inReplyTo: "synthetic-parent", ...initial,
  })));
});

test("constructors are silent; blank new composers and unchanged recovery do not write", async () => {
  const f = fixture();
  const fresh = f.session();
  assert.equal(fresh.dirty, true);
  assert.deepEqual(f.requests, []);
  assert.equal(f.progress.length, 0);
  const empty = f.session(blank);
  assert.equal(empty.dirty, false);
  empty.change(blank);
  await empty.flush();
  assert.deepEqual(f.methods(), []);
  assert.equal(f.progress.at(-1)?.phase, "idle");
  f.progress.length = 0;
  const recovered = f.session(saved());
  assert.equal(recovered.stored?.revision, 4);
  assert.equal(recovered.dirty, false);
  assert.equal(f.progress.length, 0);
  recovered.change(recovered.content);
  await recovered.flush();
  assert.deepEqual(f.methods(), []);
  assert.equal(f.progress.at(-1)?.phase, "saved");
});

test("create writes content only and preserves reply metadata", async () => {
  const f = fixture();
  const content = { ...initial, inReplyTo: "synthetic-parent", threadId: "synthetic-thread", references: ["synthetic-ref"] };
  const session = f.session(content);
  session.change(content);
  content.references.push("mutated-after-change");
  await session.flush();
  assert.deepEqual(f.methods(), ["POST"]);
  assert.equal(f.requests[0].url, "/accounts/synthetic/drafts");
  assert.deepEqual(f.requests[0].body, {
    to: initial.to, subject: initial.subject, body: initial.body, inReplyTo: "synthetic-parent",
    threadId: "synthetic-thread", references: ["synthetic-ref"], sendUnknown: false,
  });
  assert.equal(session.stored?.revision, 1);
  assert.equal(session.dirty, false);
  assert.equal(f.progress.at(-1)?.phase, "saved");
});

test("writes serialize and coalesce; older acknowledgements leave the newest edit dirty", async () => {
  const f = fixture();
  const first = deferred();
  const second = deferred();
  f.control.intercept = async (request, commit) => {
    await (request.method === "POST" ? first.promise : second.promise);
    return commit();
  };
  const session = f.session();
  session.change(initial);
  await tick();
  session.change({ ...initial, body: "intermediate" });
  session.change({ ...initial, body: "newest" });
  assert.equal(session.content.body, "newest");
  assert.deepEqual(f.methods(), ["POST"]);
  const flushed = session.flush();
  first.resolve();
  await tick();
  assert.deepEqual(f.methods(), ["POST", "PUT"]);
  assert.equal(session.stored?.body, initial.body);
  assert.equal(session.dirty, true);
  assert.equal(f.progress.some((value) => value.phase === "saved"), false);
  assert.deepEqual(f.requests[1].body, {
    to: initial.to, subject: initial.subject, body: "newest", sendUnknown: false, revision: 1,
  });
  second.resolve();
  await flushed;
  assert.equal(session.stored?.body, "newest");
  assert.equal(session.stored?.revision, 2);
  assert.equal(session.dirty, false);
  assert.equal(f.maxActive, 1);
});

test("reverting to acknowledged text during an active write stays dirty until the reversion is saved", async () => {
  const f = fixture(saved());
  const release = deferred();
  f.control.intercept = async (_request, commit) => {
    await release.promise;
    return commit();
  };
  const session = f.session(saved());
  session.change({ ...initial, body: "temporary edit" });
  await tick();
  session.change(initial);
  assert.equal(session.dirty, true);
  release.resolve();
  await session.flush();
  assert.deepEqual(f.methods(), ["PUT", "PUT"]);
  assert.equal(f.remote?.body, initial.body);
  assert.equal(f.remote?.revision, 6);
  assert.equal(session.dirty, false);
});

test("clearing a saved draft persists empty strings and removes omitted reply fields", async () => {
  const record = saved({ ...initial, inReplyTo: "synthetic-parent", threadId: "synthetic-thread", references: ["synthetic-ref"] });
  const f = fixture(record);
  const session = f.session(record);
  session.change(blank);
  await session.flush();
  assert.deepEqual(f.methods(), ["PUT"]);
  assert.deepEqual(f.requests[0].body, { to: "", subject: "", body: "", sendUnknown: false, revision: 4 });
  assert.equal(f.remote?.inReplyTo, undefined);
  assert.equal(f.remote?.threadId, undefined);
  assert.equal(f.remote?.references, undefined);
  assert.equal(session.dirty, false);
});

test("failed and lost POST acknowledgements pause and never create a second copy", async (t) => {
  for (const committed of [false, true]) await t.test(`committed=${committed}`, async () => {
    const f = fixture();
    f.control.intercept = (_request, commit) => {
      if (committed) commit();
      throw new Error(rawError);
    };
    const session = f.session();
    session.change(initial);
    await assert.rejects(session.flush(), /separate copy/);
    session.change({ ...initial, body: "retained latest edit" });
    await tick();
    await assert.rejects(session.retry(), /separate copy/);
    await assert.rejects(session.flush(), /separate copy/);
    await assert.rejects(session.discard(), /separate copy/);
    assert.deepEqual(f.methods(), ["POST"]);
    assert.equal(Boolean(f.remote), committed);
    assert.equal(session.content.body, "retained latest edit");
    assert.equal(session.dirty, true);
    assert.equal(JSON.stringify(f.progress).includes(rawError), false);
    assert.equal(f.progress.at(-1)?.phase, "error");
  });
});

test("failed PUT retains content and pauses; explicit retry reads unchanged revision before saving latest edits", async () => {
  const f = fixture(saved());
  let fail = true;
  f.control.intercept = (_request, commit) => {
    if (fail) { fail = false; throw new Error(rawError); }
    return commit();
  };
  const session = f.session(saved());
  session.change({ ...initial, body: "first edit" });
  await assert.rejects(session.flush(), (error: Error) => !error.message.includes(rawError));
  session.change({ ...initial, body: "latest edit" });
  await tick();
  assert.deepEqual(f.methods(), ["PUT"]);
  assert.equal(session.dirty, true);
  await Promise.all([session.retry(), session.retry()]);
  assert.deepEqual(f.methods(), ["PUT", "GET", "PUT"]);
  assert.equal((f.requests[2].body as { revision: number }).revision, 4);
  assert.equal(f.remote?.body, "latest edit");
  assert.equal(session.dirty, false);
  assert.equal(JSON.stringify(f.progress).includes(rawError), false);
  assert.equal(f.maxActive, 1);
});

test("lost PUT acknowledgement accepts only its exact next revision and then drains newer edits", async (t) => {
  for (const newerEdit of [false, true]) await t.test(`newerEdit=${newerEdit}`, async () => {
    const f = fixture(saved());
    let lose = true;
    f.control.intercept = (_request, commit) => {
      const result = commit();
      if (lose) { lose = false; throw new Error(rawError); }
      return result;
    };
    const session = f.session(saved());
    session.change({ ...initial, body: "attempted" });
    await assert.rejects(session.flush());
    if (newerEdit) session.change({ ...initial, body: "newest" });
    await session.retry();
    assert.deepEqual(f.methods(), newerEdit ? ["PUT", "GET", "PUT"] : ["PUT", "GET"]);
    assert.equal(session.stored?.revision, newerEdit ? 6 : 5);
    assert.equal(session.content.body, newerEdit ? "newest" : "attempted");
    assert.equal(f.remote?.body, session.content.body);
    assert.equal(session.dirty, false);
    if (newerEdit) assert.equal((f.requests[2].body as { revision: number }).revision, 5);
  });
});

test("failed PUT reconciled to unchanged original needs no write when the local edit was reverted", async () => {
  const f = fixture(saved());
  f.control.intercept = (request, commit) => {
    if (request.method === "PUT") throw new Error(rawError);
    return commit();
  };
  const session = f.session(saved());
  session.change({ ...initial, body: "attempted" });
  await assert.rejects(session.flush());
  session.change(initial);
  await session.retry();
  assert.deepEqual(f.methods(), ["PUT", "GET"]);
  assert.equal(session.dirty, false);
});

test("conflicting, unexpected or missing PUT recovery never overwrites or recreates", async (t) => {
  const cases: [string, Draft | undefined][] = [
    ["same revision with changed text", saved({ ...initial, body: "external" }, 4)],
    ["next revision with conflicting text", saved({ ...initial, body: "external" }, 5)],
    ["next revision with conflicting reply metadata", saved({ ...initial, body: "attempted", references: ["external"] }, 5)],
    ["two revision advances with matching text", saved({ ...initial, body: "attempted" }, 6)],
    ["regressed revision", saved(initial, 3)],
    ["missing record", undefined],
    ["different account", { ...saved({ ...initial, body: "attempted" }, 5), accountId: "other-synthetic" }],
    ["different id", { ...saved({ ...initial, body: "attempted" }, 5), id: "other-draft" }],
  ];
  for (const [name, remote] of cases) await t.test(name, async () => {
    const f = fixture(saved());
    f.control.intercept = (request, commit) => {
      if (request.method !== "GET") throw new Error(rawError);
      return commit();
    };
    const session = f.session(saved());
    session.change({ ...initial, body: "attempted" });
    await assert.rejects(session.flush());
    f.remote = remote;
    await assert.rejects(session.retry(), /changed or is unavailable/);
    session.change({ ...initial, body: "retained newest" });
    await assert.rejects(session.flush());
    await assert.rejects(session.discard(), /could not be discarded/);
    assert.deepEqual(f.methods(), ["PUT", "GET", "GET"]);
    assert.deepEqual(f.remote, remote);
    assert.equal(session.stored?.revision, 4);
    assert.equal(session.content.body, "retained newest");
    assert.equal(session.dirty, true);
    assert.equal(JSON.stringify(f.progress).includes(rawError), false);
  });
});

test("a failed reconciliation read preserves paused state and safe errors", async () => {
  const f = fixture(saved());
  f.control.intercept = () => { throw new Error(rawError); };
  const session = f.session(saved());
  session.change({ ...initial, body: "attempted" });
  await assert.rejects(session.flush());
  await assert.rejects(session.retry(), /changed or is unavailable/);
  session.change({ ...initial, body: "latest" });
  await tick();
  assert.deepEqual(f.methods(), ["PUT", "GET"]);
  assert.equal(session.dirty, true);
  assert.equal(session.content.body, "latest");
  assert.equal(JSON.stringify(f.progress).includes(rawError), false);
  f.control.intercept = undefined;
  await session.retry();
  assert.deepEqual(f.methods(), ["PUT", "GET", "GET", "PUT"]);
  assert.equal(f.remote?.body, "latest");
});

test("discard waits active creation, cancels queued edits, and prevents resurrection", async () => {
  const f = fixture();
  const created = deferred();
  const deleted = deferred();
  f.control.intercept = async (request, commit) => {
    await (request.method === "POST" ? created.promise : deleted.promise);
    return commit();
  };
  const session = f.session();
  session.change(initial);
  await tick();
  session.change({ ...initial, body: "queued edit" });
  const discarded = session.discard();
  assert.equal(session.discard(), discarded);
  await tick();
  assert.deepEqual(f.methods(), ["POST"]);
  created.resolve();
  await tick();
  assert.deepEqual(f.methods(), ["POST", "DELETE"]);
  assert.deepEqual(f.requests[1].body, { revision: 1, confirmUnknown: true });
  session.change({ ...initial, body: "edit during deletion" });
  deleted.resolve();
  await discarded;
  const contentAfterDiscard = structuredClone(session.content);
  session.change({ ...initial, body: "late edit" });
  await session.retry();
  await session.flush();
  await session.discard();
  assert.deepEqual(f.methods(), ["POST", "DELETE"]);
  assert.deepEqual(session.content, contentAfterDiscard);
  assert.equal(f.remote, undefined);
  assert.equal(session.stored, undefined);
  assert.equal(session.dirty, false);
  assert.equal(f.maxActive, 1);
});

test("discard before a queued create starts makes no record", async () => {
  const f = fixture();
  const session = f.session();
  session.change(initial);
  await session.discard();
  await session.flush();
  assert.deepEqual(f.methods(), []);
  assert.equal(session.dirty, false);
});

test("discard reconciles ambiguous PUT before deleting only the known revision", async (t) => {
  for (const committed of [false, true]) await t.test(`committed=${committed}`, async () => {
    const f = fixture(saved());
    const release = deferred();
    f.control.intercept = async (request, commit) => {
      if (request.method === "PUT") {
        await release.promise;
        if (committed) commit();
        throw new Error(rawError);
      }
      return commit();
    };
    const session = f.session(saved());
    session.change({ ...initial, body: "attempted" });
    await tick();
    session.change({ ...initial, body: "queued" });
    const discarded = session.discard();
    release.resolve();
    await discarded;
    assert.deepEqual(f.methods(), ["PUT", "GET", "DELETE"]);
    assert.deepEqual(f.requests[2].body, { revision: committed ? 5 : 4, confirmUnknown: true });
    assert.equal(session.dirty, false);
    assert.equal(f.remote, undefined);
  });
});

test("lost DELETE response retains session until a repeated discard confirms 404", async () => {
  const f = fixture(saved());
  f.control.intercept = (request, commit) => {
    const result = commit();
    if (request.method === "DELETE") throw new Error(rawError);
    return result;
  };
  const session = f.session(saved());
  await assert.rejects(session.discard(), /could not be discarded/);
  assert.equal(session.dirty, true);
  assert.equal(session.stored?.revision, 4);
  session.change({ ...initial, body: "retained after failure" });
  await assert.rejects(session.retry());
  await assert.rejects(session.flush());
  assert.deepEqual(f.methods(), ["DELETE"]);
  await session.discard();
  assert.deepEqual(f.methods(), ["DELETE", "GET"]);
  assert.equal(session.dirty, false);
  session.change(initial);
  await session.flush();
  assert.deepEqual(f.methods(), ["DELETE", "GET"]);
  assert.equal(JSON.stringify(f.progress).includes(rawError), false);
});

test("a failed DELETE can repeat only after GET confirms the exact original snapshot", async (t) => {
  for (const conflict of [false, true]) await t.test(`conflict=${conflict}`, async () => {
    const f = fixture(saved());
    let fail = true;
    f.control.intercept = (request, commit) => {
      if (request.method === "DELETE" && fail) { fail = false; throw new Error(rawError); }
      return commit();
    };
    const session = f.session(saved());
    await assert.rejects(session.discard());
    if (conflict) f.remote = saved({ ...initial, body: "external", sendUnknown: true }, 5);
    if (conflict) {
      await assert.rejects(session.discard());
      assert.deepEqual(f.methods(), ["DELETE", "GET"]);
      assert.equal(session.content.sendUnknown, true);
      assert.equal(session.content.body, initial.body);
      assert.equal(session.dirty, true);
      assert.equal(f.remote?.body, "external");
    } else {
      await session.discard();
      assert.deepEqual(f.methods(), ["DELETE", "GET", "DELETE"]);
      assert.deepEqual(f.requests[2].body, { revision: 4, confirmUnknown: true });
      assert.equal(session.dirty, false);
    }
  });
});

test("an external edit racing DELETE is never deleted and cannot resume autosave", async () => {
  const f = fixture(saved());
  f.control.intercept = (_request, commit) => {
    f.remote = saved({ ...initial, body: "external edit" }, 5);
    return commit();
  };
  const session = f.session(saved());
  await assert.rejects(session.discard());
  session.change({ ...initial, body: "local preserved" });
  await assert.rejects(session.flush());
  await assert.rejects(session.retry());
  assert.deepEqual(f.methods(), ["DELETE"]);
  assert.equal(f.remote?.body, "external edit");
  assert.equal(session.content.body, "local preserved");
  assert.equal(session.dirty, true);
});

test("uncertainty is sticky through recovery, in-flight edits and conflicting reconciliation", async (t) => {
  await t.test("recovered marker", async () => {
    const record = saved({ ...initial, sendUnknown: true });
    const f = fixture(record);
    const session = f.session(record);
    session.change({ ...initial, body: "edited", sendUnknown: false });
    await session.flush();
    assert.equal(session.content.sendUnknown, true);
    assert.equal(f.remote?.sendUnknown, true);
    assert.equal((f.requests[0].body as DraftContent).sendUnknown, true);
    await session.discard();
    assert.deepEqual(f.requests[1].body, { revision: 5, confirmUnknown: true });
  });
  await t.test("in-flight marker", async () => {
    const f = fixture(saved());
    const release = deferred();
    f.control.intercept = async (_request, commit) => { await release.promise; return commit(); };
    const session = f.session(saved());
    session.change({ ...initial, sendUnknown: true });
    await tick();
    session.change({ ...initial, body: "newest", sendUnknown: false });
    release.resolve();
    await session.flush();
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every((request) => (request.body as DraftContent).sendUnknown === true));
    assert.equal(session.content.sendUnknown, true);
  });
  await t.test("observed conflicting marker", async () => {
    const f = fixture(saved());
    f.control.intercept = (request, commit) => {
      if (request.method === "PUT") throw new Error(rawError);
      return commit();
    };
    const session = f.session(saved());
    session.change({ ...initial, body: "local" });
    await assert.rejects(session.flush());
    f.remote = saved({ ...initial, body: "external", sendUnknown: true }, 5);
    await assert.rejects(session.retry());
    session.change({ ...initial, body: "latest", sendUnknown: false });
    assert.equal(session.content.sendUnknown, true);
    assert.equal(session.stored?.revision, 4);
    assert.deepEqual(f.methods(), ["PUT", "GET"]);
    assert.equal(f.remote?.body, "external");
  });
});

test("sessions reject mixed accounts synchronously and encode the bound account in routes", async () => {
  const f = fixture(saved());
  const session = f.session(saved());
  assert.throws(() => session.change({ ...initial, accountId: "other-synthetic" }), /cannot change accounts/);
  assert.deepEqual(session.content, composeContent(initial));
  assert.deepEqual(f.methods(), []);
  session.change({ ...initial, body: "bound edit" });
  await session.flush();
  assert.equal(f.requests[0].url, "/accounts/synthetic/drafts/synthetic-draft");
  const routes: string[] = [];
  const api: Api = async <T,>(url: string): Promise<T> => {
    routes.push(url);
    return saved({ ...initial, accountId: "synthetic/account" }, 1) as T;
  };
  const encoded = new DraftSession(api, { ...initial, accountId: "synthetic/account" }, () => {});
  encoded.change(encoded.content);
  await encoded.flush();
  assert.deepEqual(routes, ["/accounts/synthetic%2Faccount/drafts"]);
});

test('Cc and attachments survive draft snapshots, save changes and attachment-only drafts', async () => {
 const attachments = [{ filename: 'note.txt', contentType: 'text/plain', content: 'bm90ZQ==' }];
 const f = fixture();
 const session=f.session({...blank, cc:['copy@example.com'], attachments});
 attachments[0].filename='changed.txt';
 assert.equal(session.content.attachments?.[0].filename,'note.txt');
 session.change(session.content); await session.flush();
 assert.deepEqual(f.remote?.cc,['copy@example.com']);
 assert.equal(f.remote?.attachments?.[0].filename,'note.txt');
 session.change({...session.content,cc:['other@example.com']}); await session.flush();
 assert.deepEqual(f.remote?.cc,['other@example.com']);
 const attachmentOnly=fixture(); const only=attachmentOnly.session({...blank,attachments});
 only.change(only.content); await only.flush(); assert.equal(attachmentOnly.requests.length,1);
});
