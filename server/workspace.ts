import { sameImapAccount } from "./imap-watch.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import type { Commitment, Project, AgentAction, AgentPayload, AgentProposal, AgentTool, Conversation, RulePreview } from "../shared/workspace.js";
import type { Mail, Rule } from "../shared/types.js";
import { all, get, readMail, put, remove, transaction, account } from "./store.js";
import { findMail, updateMessage, runMailWork } from "./mail-actions.js";
import { createDraft, contentSchema } from "./drafts.js";
import { providers, sendSchema } from "./providers.js";
import { matchingRule } from "../shared/rules.js";
import { validDate } from "../shared/commitment-dates.js";
class WorkspaceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
export class AgentPermissionError extends WorkspaceError {
  constructor(readonly tool: AgentTool) {
    super(403, "This agent has no grant for that account and tool.");
  }
}
const fail = (status: number, message: string): never => {
  throw new WorkspaceError(status, message);
};
const text = z.string().trim().min(1).max(2000);
const ids = z.array(z.string().min(1).max(300)).max(200);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const status = z.enum(["needs-reply", "needs-work", "waiting", "done", "cancelled"]);
const timestamp = z.number().int().min(0).max(253402300799999);
const dateOnly = z.string().refine(validDate, "Choose a valid calendar date.");
const commitmentInput = z.object({ accountId: text, sourceMailId: text, text, reason: text, status, dueAt: timestamp.optional(), dueDate: dateOnly.optional(), followUpAt: timestamp.optional(), evidenceMailIds: ids.default([]), projectId: text.optional() }).strict();
const oneDeadline = (input: { dueAt?: number | null; dueDate?: string | null }) => input.dueAt === undefined || input.dueDate === undefined;
const commitmentSchema = commitmentInput.refine(oneDeadline, "Use one deadline field.");
export const agentCommitmentSchema = commitmentInput.extend({ requestId: z.uuid(), status: z.enum(["needs-reply", "needs-work", "waiting"]) }).strict().refine(oneDeadline, "Use one deadline field.");
const projectSchema = z.object({ name: text, sourceMailIds: ids.min(1), confirmAccountIds: ids.optional() }).strict();
export const agentProjectSchema = projectSchema.omit({ confirmAccountIds: true }).extend({ requestId: z.uuid(), accountId: text }).strict();
const patchCommitment = commitmentInput.omit({ accountId: true, sourceMailId: true }).partial().extend({ revision, evidenceMailIds: ids.optional(), dueAt: timestamp.nullable().optional(), dueDate: dateOnly.nullable().optional(), followUpAt: timestamp.nullable().optional(), projectId: text.nullable().optional() }).strict().refine(oneDeadline, "Use one deadline field.");
function deadlineFields(input: { dueAt?: number | null; dueDate?: string | null }) {
  if (input.dueDate !== undefined)
    return { dueDate: input.dueDate ?? undefined, dueAt: input.dueDate ? Date.parse(`${input.dueDate}T12:00:00Z`) : undefined };
  if (input.dueAt !== undefined)
    return { dueAt: input.dueAt ?? undefined, dueDate: input.dueAt === null ? undefined : new Date(input.dueAt).toISOString().slice(0, 10) };
  return {};
}
export const ruleSchema = z.object({ sender: z.email().max(320), instruction: z.string().trim().min(1).max(500), category: z.enum(["important", "other"]), relevance: z.union([z.literal(1), z.literal(2), z.literal(3)]), accountId: text, condition: z.union([z.object({ field: z.enum(["subject", "body", "recipient"]), contains: z.string().trim().min(1).max(300) }).strict(), z.object({ field: z.enum(["hasAttachment", "directQuestion"]) }).strict()]).optional() }).strict();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function conversation(id: string, view?: Map<string, Mail>): Conversation {
  const source = view ? view.get(id) : findMail(id);
  if (!source) throw new Error("Message not found.");
  const candidates = [...(view?.values() ?? all("mail"))].filter((m) => m.accountId === source.accountId);
  const selected = new Map([[source.id, source]]);
  let changed = true;
  while (changed) {
    changed = false;
    const known = new Set([...selected.values()].flatMap((m) => [m.messageId, m.inReplyTo, ...(m.references || [])]).filter(Boolean));
    const threads = new Set([...selected.values()].map((m) => m.threadId).filter(Boolean));
    for (const m of candidates)
      if (!selected.has(m.id) && ((m.threadId && threads.has(m.threadId)) || [m.messageId, m.inReplyTo, ...(m.references || [])].some((value) => value && known.has(value)))) {
        selected.set(m.id, m);
        changed = true;
      }
  }
  const messages = [...selected.values()].sort((a, b) => a.date - b.date || a.id.localeCompare(b.id));
  const observedIds = new Set(messages.map((m) => m.messageId).filter(Boolean));
  const missing = new Set(messages.flatMap((m) => [m.inReplyTo, ...(m.references || [])]).filter((value): value is string => Boolean(value) && !observedIds.has(value)));
  const coverage = get("coverage", source.accountId);
  const gaps = ["Local evidence only. Inbox and bounded Sent imports do not prove conversation completeness.", ...[...missing].map((value) => `Referenced message unavailable: ${value}`)];
  if (!coverage)
    gaps.push("Sent evidence has not been imported.");
  if (coverage?.error)
    gaps.push(coverage.error);
  if (coverage?.truncated)
    gaps.push(`Sent evidence is limited to ${coverage.bound} messages.`);
  return { accountId: source.accountId, messages, gaps, coverage };
}
export const fingerprint = (id: string, view?: Map<string, Mail>) => digest(conversation(id, view).messages.map(({ id, accountId, remoteId, messageId, inReplyTo, references, threadId, to, cc, replyTo, address, subject, body, attachments, direction }) => ({ id, accountId, remoteId, messageId, inReplyTo, references, threadId, to, cc, replyTo, address, subject, body, attachments, direction })));
function sourceIds(values: string[], accountId?: string) {
  for (const id of values) {
    const m = get("mail", id);
    if (!m || (accountId && m.accountId !== accountId))
      fail(400, "Choose available source messages from the permitted account.");
  }
}
function checkProject(projectId: string | undefined, accountId: string) {
  if (projectId && !get("project", projectId)?.accountIds.includes(accountId))
    fail(400, "Choose a project containing this account.");
}
async function visibleProposals() {
  const proposals = all("proposal");
  if (!proposals.some(p => p.sourceMailId)) return proposals.map(p => ({ ...p, sourceChanged: false }));
  const view = new Map((await readMail()).map(m => [m.id, m]));
  const fingerprints = new Map<string, string>();
  return proposals.map(proposal => {
    const id = proposal.sourceMailId;
    if (id && view.has(id) && !fingerprints.has(id)) fingerprints.set(id, fingerprint(id, view));
    return { ...proposal, sourceChanged: Boolean(id && (!view.has(id) || fingerprints.get(id) !== proposal.sourceFingerprint)) };
  });
}
function history(c: Commitment) {
  return { at: c.updatedAt, status: c.status, dueAt: c.dueAt, dueDate: c.dueDate, followUpAt: c.followUpAt, text: c.text, reason: c.reason, evidenceMailIds: [...c.evidenceMailIds] };
}
function projectSources(values: string[], confirmation?: string[], previous?: Project) {
  sourceIds(values);
  const accountIds = [...new Set(values.map((id) => findMail(id).accountId))].sort();
  if (!accountIds.length)
    fail(400, "Select at least one source message.");
  const unchanged = previous && JSON.stringify(previous.accountIds) === JSON.stringify(accountIds) && previous.crossAccountConfirmed;
  if (accountIds.length > 1 && !unchanged && JSON.stringify([...(confirmation || [])].sort()) !== JSON.stringify(accountIds))
    fail(409, "Confirm the exact account set before combining these sources.");
  return { accountIds, crossAccountConfirmed: accountIds.length > 1 };
}
function createCommitment(input: z.infer<typeof commitmentSchema>, id: string = randomUUID()): Commitment {
  account(input.accountId);
  sourceIds([input.sourceMailId, ...input.evidenceMailIds], input.accountId);
  checkProject(input.projectId, input.accountId);
  const item: Commitment = { ...input, ...deadlineFields(input), id, revision: 1, updatedAt: Date.now(), history: [] };
  item.history.push(history(item));
  put("commitment", item.id, item);
  return item;
}
function createProject(input: z.infer<typeof projectSchema>, id: string = randomUUID()): Project {
  const { confirmAccountIds, ...fields } = input;
  const item: Project = { ...fields, ...projectSources(input.sourceMailIds, confirmAccountIds), id, revision: 1, updatedAt: Date.now() };
  put("project", item.id, item);
  return item;
}
function projectInAccount(project: Project, accountId: string) {
  return project.accountIds.length === 1 && project.accountIds[0] === accountId && project.sourceMailIds.length > 0 && project.sourceMailIds.every((id) => get("mail", id)?.accountId === accountId);
}
function commitmentInAccount(item: Commitment, accountId: string) {
  const project = item.projectId ? get("project", item.projectId) : undefined;
  return item.accountId === accountId && [item.sourceMailId, ...item.evidenceMailIds, ...item.history.flatMap((entry) => entry.evidenceMailIds)].every((id) => get("mail", id)?.accountId === accountId) && (!item.projectId || Boolean(project && projectInAccount(project, accountId)));
}
export function listAgentProjects(agentId: string, accountId: string) {
  assertAgent(agentId, "list_projects", accountId);
  return all("project").filter((item) => projectInAccount(item, accountId));
}
export function listAgentCommitments(agentId: string, accountId: string) {
  assertAgent(agentId, "list_commitments", accountId);
  return all("commitment").filter((item) => commitmentInAccount(item, accountId));
}
export function createAgentProject(agentId: string, value: unknown) {
  const { requestId, accountId, ...input } = agentProjectSchema.parse(value);
  assertAgent(agentId, "create_project", accountId);
  sourceIds(input.sourceMailIds, accountId);
  const id = `agent-${digest({ agentId, tool: "create_project", requestId })}`;
  return transaction(() => {
    const existing = get("project", id);
    if (existing) {
      if (existing.revision !== 1 || !projectInAccount(existing, accountId) || digest({ name: existing.name, sourceMailIds: existing.sourceMailIds }) !== digest(input))
        return fail(409, "Creation request conflicts with saved work. Read saved work before continuing.");
      return existing;
    }
    return createProject(input, id);
  });
}
export function trackAgentCommitment(agentId: string, value: unknown) {
  const { requestId, ...input } = agentCommitmentSchema.parse(value);
  assertAgent(agentId, "track_commitment", input.accountId);
  sourceIds([input.sourceMailId, ...input.evidenceMailIds], input.accountId);
  const project = input.projectId ? get("project", input.projectId) : undefined;
  if (input.projectId && (!project || !projectInAccount(project, input.accountId)))
    return fail(400, "Choose a single-account project with available sources.");
  const id = `agent-${digest({ agentId, tool: "track_commitment", requestId })}`;
  return transaction(() => {
    const existing = get("commitment", id);
    if (existing) {
      const { id: _id, revision: _revision, updatedAt: _updatedAt, history: _history, ...fields } = existing;
      if (existing.revision !== 1 || !commitmentInAccount(existing, input.accountId) || digest(commitmentInput.parse(fields)) !== digest(commitmentInput.parse({ ...input, ...deadlineFields(input) })))
        return fail(409, "Creation request conflicts with saved work. Read saved work before continuing.");
      return existing;
    }
    return createCommitment(input, id);
  });
}
export function previewRule(value: unknown): RulePreview {
  const rule = ruleSchema.parse(value);
  if (rule.accountId)
    account(rule.accountId);
  const existing = all("rule");
  const candidate = { ...rule, id: "preview", createdAt: Math.max(Date.now(), ...existing.map((r) => (r.createdAt || 0) + 1)) };
  const competing = existing.filter((r) => !(r.accountId === rule.accountId && r.sender.toLowerCase() === rule.sender.toLowerCase() && JSON.stringify(r.condition) === JSON.stringify(rule.condition)));
  const matches = all("mail").filter((m) => matchingRule(m, [...competing, candidate])?.id === candidate.id);
  return { rule, digest: digest({ rule, existing, examples: matches.map((m) => [m.id, m.subject, m.body, m.to, m.attachments]) }), count: matches.length, examples: matches.slice(0, 10).map((m) => ({ id: m.id, subject: m.subject, reason: rule.condition?.field === "directQuestion" ? "Contains a question mark (deterministic heuristic)." : `Matches sender${rule.condition ? ` and ${rule.condition.field}` : ""}.` })) };
}
const toolFor = (action: AgentAction): AgentTool => ({ send: "reply_to_email", draft: "propose_draft", archive: "archive_email", read: "mark_read" } as const)[action];
export function assertAgent(agentId: string, tool: AgentTool, accountId?: string) {
  const grant = get("agent", agentId);
  if (!grant || !grant.tools.includes(tool) || (accountId && !grant.accountIds.includes(accountId)) || (accountId && !get("account", accountId)))
    throw new AgentPermissionError(tool);
  return grant!;
}
export function propose(agentId: string, action: AgentAction, value: unknown, sourceMailId?: string): AgentProposal {
  let accountId: string;
  let payload: AgentProposal["payload"];
  if (action === "draft") {
    const { accountId: id, ...content } = z.object({ accountId: text }).passthrough().parse(value);
    payload = { ...contentSchema.parse(content), accountId: id };
    accountId = id;
  }
  else if (action === "send") {
    payload = sendSchema.strict().parse(value);
    accountId = payload.accountId;
  }
  else {
    payload = z.object({ mailId: text }).strict().parse(value);
    const m = findMail(payload.mailId);
    accountId = m.accountId;
    sourceMailId = m.id;
  }
  assertAgent(agentId, toolFor(action), accountId);
  if (sourceMailId)
    sourceIds([sourceMailId], accountId);
  const content = { id: randomUUID(), agentId, accountId, action, payload, sourceMailId, sourceFingerprint: sourceMailId ? fingerprint(sourceMailId) : undefined, createdAt: Date.now() };
  const proposal: AgentProposal = { ...content, digest: digest(content), status: "pending" };
  put("proposal", proposal.id, proposal);
  return proposal;
}
async function approve(id: string, expected: string) {
  const proposal = transaction(() => {
    const current = get("proposal", id);
    if (!current)
      return fail(404, "Proposal not found.");
    if (current.status !== "pending" || current.digest !== expected)
      return fail(409, "Proposal changed or has already been consumed.");
    assertAgent(current.agentId, toolFor(current.action), current.accountId);
    if (!all("mcp")[0]?.enabled)
      return fail(403, "MCP is disabled. Agent approvals are revoked.");
    if (current.sourceMailId && (!get("mail", current.sourceMailId) || fingerprint(current.sourceMailId) !== current.sourceFingerprint))
      return fail(409, "Conversation evidence changed. Request a fresh proposal.");
    const next = { ...current, status: "executing" as const, receipt: { at: Date.now(), message: "Approval consumed. Execution started; interruption must not be retried." } };
    put("proposal", id, next);
    return next;
  });
  const validateExecution = () => {
    assertAgent(proposal.agentId, toolFor(proposal.action), proposal.accountId);
    if (!all("mcp")[0]?.enabled)
      fail(403, "MCP was disabled before execution.");
    if (proposal.sourceMailId && (!get("mail", proposal.sourceMailId) || fingerprint(proposal.sourceMailId) !== proposal.sourceFingerprint))
      fail(409, "Conversation evidence changed before execution.");
  };
  try {
    validateExecution();
    let draftId: string | undefined;
    let message = "Action completed.";
    // Approved agent replies become editable local drafts; only the user's own Send delivers them.
    if (proposal.action === "draft" || proposal.action === "send") {
      const { accountId, ...content } = proposal.payload as AgentPayload;
      draftId = createDraft(accountId, content).id;
      if (proposal.action === "send")
        message = "Saved to Drafts. Not sent. Edit and send it from the composer.";
    }
    else
      await updateMessage((proposal.payload as {
        mailId: string;
      }).mailId, { action: proposal.action === "read" ? "read" : "archive" }, validateExecution);
    const completed: AgentProposal = { ...proposal, status: "succeeded", receipt: { at: Date.now(), message, ...(draftId ? { draftId } : {}) } };
    if (get("proposal", id))
      put("proposal", id, completed);
    return completed;
  }
  catch (error) {
    const failed: AgentProposal = { ...proposal, status: "failed", receipt: { at: Date.now(), message: "Execution failed. Check the source and account before proposing again." } };
    if (get("proposal", id))
      put("proposal", id, failed);
    return failed;
  }
}
export function mountWorkspace(app: express.Express) {
  const router = express.Router();
  router.get("/workspace", async (_req, res) => res.json({ commitments: all("commitment").map((c) => ({ ...c, sourceUnavailable: !get("mail", c.sourceMailId) })), projects: all("project"), decisions: all("decision"), coverage: all("coverage"), proposals: await visibleProposals() }));
  router.post("/commitments", (req, res) => {
    res.status(201).json(createCommitment(commitmentSchema.parse(req.body)));
  });
  router.patch("/commitments/:id", (req, res) => {
    const { revision: expected, ...input } = patchCommitment.parse(req.body);
    const item = transaction(() => {
      const current = get("commitment", req.params.id);
      if (!current)
        return fail(404, "Commitment not found.");
      if (current.revision !== expected)
        return fail(409, "Commitment changed. Read before saving.");
      if (input.evidenceMailIds)
        sourceIds(input.evidenceMailIds.filter((id) => !current.evidenceMailIds.includes(id)), current.accountId);
      checkProject(input.projectId ?? undefined, current.accountId);
      const next: Commitment = { ...current, ...input, dueAt: current.dueAt, dueDate: current.dueDate, ...deadlineFields(input), followUpAt: input.followUpAt === null ? undefined : input.followUpAt ?? current.followUpAt, projectId: input.projectId === null ? undefined : input.projectId ?? current.projectId, revision: expected + 1, updatedAt: Date.now() };
      next.history = [...current.history, history(next)];
      put("commitment", next.id, next);
      return next;
    });
    res.json(item);
  });
  router.post("/projects", (req, res) => {
    res.status(201).json(createProject(projectSchema.parse(req.body)));
  });
  router.patch("/projects/:id", (req, res) => {
    const { revision: expected, confirmAccountIds, ...input } = projectSchema.partial().extend({ revision }).strict().parse(req.body);
    const item = transaction(() => {
      const current = get("project", req.params.id);
      if (!current)
        return fail(404, "Project not found.");
      if (current.revision !== expected)
        return fail(409, "Project changed. Read before saving.");
      const sources = input.sourceMailIds ?? current.sourceMailIds;
      const resultingAccounts = projectSources(sources, confirmAccountIds, current);
      if (all("decision").some((d) => d.projectId === current.id && d.sourceMailIds.some((id) => !sources.includes(id))))
        return fail(409, "A recorded decision still cites these sources. Keep them in the project.");
      if (all("commitment").some((c) => c.projectId === current.id && !resultingAccounts.accountIds.includes(c.accountId)))
        return fail(409, "This account still has project commitments. Reassign them before removing its sources.");
      const next = { ...current, ...input, ...resultingAccounts, revision: expected + 1, updatedAt: Date.now() };
      put("project", next.id, next);
      return next;
    });
    res.json(item);
  });
  router.post("/projects/:id/decisions", (req, res) => {
    const input = z.object({ text, sourceMailIds: ids.min(1) }).strict().parse(req.body);
    const project = get("project", req.params.id);
    if (!project)
      return fail(404, "Project not found.");
    if (input.sourceMailIds.some((id) => !project.sourceMailIds.includes(id)))
      return fail(400, "Decision sources must be explicitly selected project sources.");
    const item = { ...input, id: randomUUID(), projectId: project.id, createdAt: Date.now() };
    put("decision", item.id, item);
    res.status(201).json(item);
  });
  router.get("/messages/:id/conversation", (req, res) => res.json(conversation(req.params.id)));
  router.post("/accounts/:accountId/sent/sync", async (req, res) => {
    const { bound } = z.object({ bound: z.number().int().min(1).max(100).default(50) }).strict().parse(req.body);
    const a = account(req.params.accountId);
    const coverage = await runMailWork(async () => {
      if (!all("account").some((current) => sameImapAccount(current, a)))
        return fail(409, "Account changed before import.");
      try {
        const imported = await providers[a.provider].sent(a, bound);
        if (!all("account").some((current) => sameImapAccount(current, a)))
          return fail(409, "Account changed during import.");
        for (const m of imported.messages) {
          const old = get("mail", m.id);
          put("mail", m.id, { ...m, category: old?.category || "other", relevance: old?.relevance || 1, reason: old?.reason || "Sent evidence", unread: old?.unread ?? (m.labelIds?.includes("UNREAD") || m.unread), labelIds: old?.labelIds ?? m.labelIds, archived: old?.archived ?? !m.labelIds?.includes("INBOX"), snoozedUntil: old?.snoozedUntil || null, ...(old?.pinned ? { pinned: true } : {}), direction: old ? old.direction ?? "received" : m.labelIds?.includes("INBOX") ? "received" : "sent" });
        }
        const value = { accountId: a.id, count: imported.messages.length, bound, observedAt: Date.now(), truncated: imported.truncated, earliest: imported.messages.length ? Math.min(...imported.messages.map((m) => m.date)) : undefined };
        put("coverage", a.id, value);
        return value;
      }
      catch {
        if (!all("account").some((current) => sameImapAccount(current, a)))
          return fail(409, "Account changed during import.");
        const value = { accountId: a.id, count: 0, bound, observedAt: Date.now(), truncated: true, error: "Sent import failed. Existing evidence is retained; coverage is unknown." };
        put("coverage", a.id, value);
        return value;
      }
    });
    res.json(coverage);
  });
  router.post("/messages/:id/conversation/expand", async (req, res) => {
    z.object({}).strict().parse(req.body);
    const mail = findMail(req.params.id);
    const a = account(mail.accountId);
    if (a.provider !== "gmail" || !mail.threadId)
      return fail(400, "On-demand expansion requires a Gmail conversation.");
    await runMailWork(async () => {
      if (!all("account").some((current) => sameImapAccount(current, a)))
        return fail(409, "Account changed before conversation expansion.");
      const messages = await providers.gmail.thread(a, mail.threadId!);
      if (!all("account").some((current) => sameImapAccount(current, a)))
        return fail(409, "Account changed during expansion.");
      for (const m of messages) {
        const old = get("mail", m.id);
        put("mail", m.id, { ...m, category: old?.category || "important", relevance: old?.relevance || 2, reason: old?.reason || "Conversation evidence", archived: old?.archived ?? !m.labelIds?.includes("INBOX"), snoozedUntil: old?.snoozedUntil || null, ...(old?.pinned ? { pinned: true } : {}) });
      }
    });
    res.json(conversation(mail.id));
  });
  router.get("/messages/:id/attachments/:attachmentId", (req, res) => {
    const m = findMail(req.params.id);
    const metadata = m.attachments?.find((a) => a.id === req.params.attachmentId);
    const attachment = get("attachment", `${m.id}:${req.params.attachmentId}`);
    if (!metadata || metadata.unavailable || !attachment || attachment.accountId !== m.accountId)
      return fail(404, "Attachment bytes unavailable. They were not downloaded within the import limit.");
    res.set({ "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(metadata.filename)}`, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" }).send(Buffer.from(attachment.content, "base64"));
  });
  router.post("/rules/preview", (req, res) => res.json(previewRule(req.body)));
  router.post("/rules", (req, res) => {
    const { previewDigest, applyExisting, ...input } = ruleSchema.extend({ previewDigest: z.string().length(64), applyExisting: z.boolean() }).strict().parse(req.body);
    const preview = previewRule(input);
    if (preview.digest !== previewDigest)
      return fail(409, "Rule inputs or matching evidence changed. Preview again.");
    const old = all("rule").find((r) => r.accountId === input.accountId && r.sender.toLowerCase() === input.sender.toLowerCase() && JSON.stringify(r.condition) === JSON.stringify(input.condition));
    const rule: Rule = {
      ...input, id: old?.id || randomUUID(), createdAt: Math.max(Date.now(), ...all("rule").map((r) => (r.createdAt || 0) + 1)), // Cached IDs preserve future-only semantics across later syncs and live tab matching.
      ...(!applyExisting ? { excludedMailIds: all("mail").filter((m) => m.accountId === input.accountId).map((m) => m.id) } : {})
    };
    put("rule", rule.id, rule);
    const rules = all("rule");
    if (applyExisting)
      for (const m of all("mail"))
        if (matchingRule(m, rules)?.id === rule.id)
          put("mail", m.id, { ...m, category: rule.category, relevance: rule.relevance, reason: rule.instruction });
    res.json({ ok: true });
  });
  const agentTools = z.enum(["list_accounts", "list_emails", "search_emails", "read_email", "get_thread", "reply_to_email", "archive_email", "mark_read", "propose_draft", "list_projects", "list_commitments", "create_project", "track_commitment"]);
  router.get("/agent/grants", (_req, res) => res.json(all("agent")));
  router.post("/agent/grants", (req, res) => {
    const input = z.object({ name: text, accountIds: ids.default([]), tools: z.array(agentTools).max(20).default(["list_accounts", "list_emails", "search_emails", "read_email", "get_thread"]) }).strict().parse(req.body);
    input.accountIds.forEach(account);
    const grant = { ...input, id: randomUUID(), token: randomBytes(32).toString("hex"), createdAt: Date.now() };
    put("agent", grant.id, grant);
    res.status(201).json(grant);
  });
  // Access edits apply on the next MCP call; approval rechecks pending proposals against the current grant.
  router.patch("/agent/grants/:id", (req, res) => {
    const input = z.object({ name: text.optional(), accountIds: ids.min(1).optional(), tools: z.array(agentTools).min(1).max(20).optional() }).strict().parse(req.body);
    input.accountIds?.forEach(account);
    const grant = transaction(() => {
      const current = get("agent", req.params.id);
      if (!current)
        return fail(404, "Assistant not found.");
      const next = { ...current, ...(input.name ? { name: input.name } : {}), ...(input.accountIds ? { accountIds: [...new Set(input.accountIds)] } : {}), ...(input.tools ? { tools: [...new Set(input.tools)] } : {}) };
      put("agent", next.id, next);
      return next;
    });
    res.json(grant);
  });
  router.delete("/agent/grants/:id", (req, res) => {
    transaction(() => {
      remove("agentProvider", req.params.id);
      remove("agent", req.params.id);
    });
    res.json({ ok: true });
  });
  router.get("/agent/proposals", async (_req, res) => res.json(await visibleProposals()));
  router.post("/agent/proposals/:id/approve", async (req, res) => {
    const { digest } = z.object({ digest: z.string().length(64) }).strict().parse(req.body);
    res.json(await approve(req.params.id, digest));
  });
  router.post("/agent/proposals/:id/reject", (req, res) => {
    const { digest } = z.object({ digest: z.string().length(64) }).strict().parse(req.body);
    const current = get("proposal", req.params.id);
    if (!current)
      return fail(404, "Proposal not found.");
    if (current.status !== "pending" || current.digest !== digest)
      return fail(409, "Proposal changed or consumed.");
    const next = { ...current, status: "rejected" as const, receipt: { at: Date.now(), message: "Rejected by the user." } };
    put("proposal", next.id, next);
    res.json(next);
  });
  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof WorkspaceError)
      res.status(error.status).json({ error: error.message });
    else
      next(error);
  });
  app.use("/api", router);
}
