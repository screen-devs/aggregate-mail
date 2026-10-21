import { isDeepStrictEqual } from "node:util";
import type { Invitation } from "../shared/invitations.js";
import { generateICalendar, invitationSchema } from "./ical.js";
import { randomUUID } from "node:crypto";
import express from "express";
import { attachmentsSchema } from "./providers.js";
import { z } from "zod";
import type { Draft, DraftSummary } from "../shared/types.js";
import { all, get, put, remove, transaction } from "./store.js";

export const MAX_DRAFTS_PER_ACCOUNT = 100;
const accountIdSchema = z.string().min(1).max(200);
const draftIdSchema = z.uuid();
const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
// Drafts are incomplete text, not send requests. Send validation still happens at /api/send.
export const contentSchema = z.object({
  invitation: invitationSchema.refine((value) => {
    if (value.method === "REPLY" && value.attendees.length !== 1) return false;
    try {
      generateICalendar(value, { stamp: "2000-01-01T00:00:00.000Z", replyingAttendee: value.method === "REPLY" ? value.attendees[0].email : undefined });
      return true;
    } catch { return false; }
  }).optional(),
  to: z.string().max(10000),
  cc: z.array(z.string().max(320)).max(100).optional(),
  attachments: attachmentsSchema.optional(),
  subject: z.string().max(998),
  body: z.string().max(1000000),
  inReplyTo: z.string().max(998).optional(),
  threadId: z.string().max(100).optional(),
  references: z.array(z.string().max(998)).max(100).optional(),
  sendUnknown: z.boolean().optional(),
}).strict();
const saveSchema = contentSchema.extend({ revision: revisionSchema.max(Number.MAX_SAFE_INTEGER - 1) });
const deleteSchema = z.object({
  revision: revisionSchema,
  confirmUnknown: z.literal(true).optional(),
}).strict();

class DraftError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function requireAccount(accountId: string) {
  accountIdSchema.parse(accountId);
  if (!get("account", accountId)) throw new DraftError(404, "Account not found.");
}
export function readDraft(accountId: string, id: string): Draft {
  requireAccount(accountId);
  draftIdSchema.parse(id);
  const draft = get("draft", id);
  if (!draft || draft.accountId !== accountId) throw new DraftError(404, "Draft not found.");
  return draft;
}
export function listDrafts(accountId: string): DraftSummary[] {
  requireAccount(accountId);
  return all("draft").filter((draft) => draft.accountId === accountId)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .map(({ id, accountId, revision, updatedAt, to, cc, subject, body, attachments, sendUnknown }) =>
      ({ id, accountId, revision, updatedAt, to, cc, subject, sendUnknown,
        preview: body.replace(/\s+/g, " ").trim().slice(0, 200), attachmentCount: attachments?.length || 0 }));
}
export function createDraft(accountId: string, value: unknown): Draft {
  return transaction(() => createDraftInTransaction(accountId, value));
}
// Calendar preparation commits its event, replay receipt and ordinary draft atomically.
export function createDraftInTransaction(accountId: string, value: unknown, invitation?: Invitation, calendarContext?: Draft["calendarContext"]): Draft {
  const content = contentSchema.parse(value);
  if (content.invitation) throw new DraftError(400, "Prepare calendar drafts from their event or source email.");
  requireAccount(accountId);
  if (listDrafts(accountId).length >= MAX_DRAFTS_PER_ACCOUNT)
    throw new DraftError(409, "Draft limit reached. Explicitly delete a draft before creating another.");
  const draft: Draft = {
    ...content, ...(invitation ? { invitation, calendarContext } : {}), id: randomUUID(), accountId, revision: 1,
    updatedAt: Date.now(), sendUnknown: content.sendUnknown ?? false,
  };
  put("draft", draft.id, draft);
  return draft;
}
export function saveDraft(accountId: string, id: string, value: unknown): Draft {
  const { revision, ...content } = saveSchema.parse(value);
  return transaction(() => {
    const current = readDraft(accountId, id);
    if (current.revision !== revision) throw new DraftError(409, "Draft changed. Read it before saving again.");
    if (!isDeepStrictEqual(current.invitation, content.invitation)) throw new DraftError(409, "Calendar details cannot be changed in the composer. Prepare from the event again.");
    if (current.invitation && (current.to !== content.to || !isDeepStrictEqual(current.cc, content.cc))) throw new DraftError(409, "Calendar recipients are bound to this reviewed invitation.");
    if (current.sendUnknown && content.sendUnknown === false)
      throw new DraftError(409, "Unknown send status cannot be cleared by editing.");
    const draft: Draft = {
      ...content, ...(current.calendarContext ? { calendarContext: current.calendarContext } : {}), id, accountId, revision: revision + 1,
      updatedAt: Date.now(), sendUnknown: current.sendUnknown || content.sendUnknown === true,
    };
    put("draft", id, draft);
    return draft;
  });
}
export function deleteDraft(accountId: string, id: string, value: unknown) {
  const input = deleteSchema.parse(value);
  transaction(() => {
    const current = readDraft(accountId, id);
    if (current.revision !== input.revision) throw new DraftError(409, "Draft changed. Read it before deleting.");
    if (current.sendUnknown && !input.confirmUnknown)
      throw new DraftError(409, "Confirm discarding a draft whose send status is unknown.");
    remove("draft", id);
  });
}

export function mountDrafts(app: express.Express, onChanged: () => void) {
  const router = express.Router({ mergeParams: true });
  type Params = { accountId: string; id: string };
  // These routes inherit /api session, origin, CSRF, update and cache guards.
  router.get<Pick<Params, "accountId">>("/", (req, res) => { res.json(listDrafts(req.params.accountId)); });
  router.post<Pick<Params, "accountId">>("/", (req, res) => {
    const draft = createDraft(req.params.accountId, req.body);
    onChanged();
    res.status(201).json(draft);
  });
  router.get<Params>("/:id", (req, res) => { res.json(readDraft(req.params.accountId, req.params.id)); });
  router.put<Params>("/:id", (req, res) => { res.json(saveDraft(req.params.accountId, req.params.id, req.body)); });
  router.delete<Params>("/:id", (req, res) => {
    deleteDraft(req.params.accountId, req.params.id, req.body);
    onChanged();
    res.json({ ok: true });
  });
  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof DraftError) res.status(error.status).json({ error: error.message });
    else if (error instanceof z.ZodError) res.status(400).json({ error: "Invalid draft request." });
    else next(error);
  });
  app.use("/api/accounts/:accountId/drafts", router);
}
