import { createHash } from "node:crypto";
import express from "express";
import { z } from "zod";
import type { CalendarEvent } from "../shared/calendar.js";
import type { Invitation, InvitationResponse } from "../shared/invitations.js";
import { trackMailWork } from "./mail-actions.js";
import { createDraftInTransaction, readDraft } from "./drafts.js";
import { all, get, put, transaction } from "./store.js";
import { GoogleCalendarWriteError, googleRSVP } from "./google-calendar.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class InvitationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const invitationFail = (status: number, message: string): never => { throw new InvitationError(status, message); };
const response = z.enum(["ACCEPTED", "TENTATIVE", "DECLINED"]);
const localResponse = <T extends InvitationResponse>(value: T) => ({ ACCEPTED: "accepted", TENTATIVE: "tentative", DECLINED: "declined", "NEEDS-ACTION": "needsAction" } as const)[value];
function source(id: string) {
  const mail = get("mail", id);
  const account = mail && get("account", mail.accountId);
  if (!mail || !account || mail.direction === "sent") return invitationFail(404, "Receiving account or source email unavailable.");
  const fingerprint = hash([mail.id, mail.accountId, mail.remoteId, mail.messageId, mail.address, mail.invitation]);
  return { mail, account, fingerprint };
}
function supported(id: string, expected?: string) {
  const value = source(id);
  if (expected && value.fingerprint !== expected) return invitationFail(409, "Source email changed. Reopen it before responding.");
  if (value.mail.invitation?.status !== "ok") return invitationFail(409, "This calendar message is unsupported. No response was prepared.");
  const invitation = value.mail.invitation.invitation;
  const own = value.account.email.toLowerCase();
  const organizer = invitation.organizer.toLowerCase();
  if (invitation.method === "REPLY") {
    if (organizer !== own || invitation.attendees.length !== 1 || invitation.attendees[0].email.toLowerCase() !== value.mail.address.toLowerCase()) return invitationFail(409, "The response identity does not match this account and sender.");
  } else if (organizer !== value.mail.address.toLowerCase() || !invitation.attendees.some((person) => person.email.toLowerCase() === own)) return invitationFail(409, "This account is not an identified attendee or the organizer does not match the sender.");
  return { ...value, invitation };
}
function localMatches(accountId: string, invite: Invitation) {
  return all("calendarEvent").filter((event) => event.accountId === accountId && event.uid === invite.uid && event.organizer?.toLowerCase() === invite.organizer.toLowerCase());
}
function remoteMatch(accountId: string, invite: Invitation) {
  const matches = new Map<string, CalendarEvent>();
  for (const window of all("googleCalendarWindow")) if (window.accountId === accountId && !window.stale)
    for (const event of window.events) if (event.uid === invite.uid && event.organizer?.toLowerCase() === invite.organizer.toLowerCase() && (event.sequence ?? 0) === invite.sequence && event.attendees.some((person) => person.self && person.email.toLowerCase() === get("account", accountId)?.email.toLowerCase())) matches.set(event.id, event);
  return matches.size === 1 ? [...matches.values()][0] : undefined;
}
export function prepareEventInvitation(id: string, expected: number, method: "REQUEST" | "CANCEL") {
  return transaction(() => {
    const event = get("calendarEvent", id);
    if (!event || event.source !== "local") return invitationFail(404, "Local event not found.");
    if (event.revision !== expected) return invitationFail(409, "Event changed. Refresh before preparing a draft.");
    const account = event.accountId && get("account", event.accountId);
    if (!account) return invitationFail(409, "Choose a connected account by editing this event before preparing an invitation.");
    if (event.organizer && event.organizer.toLowerCase() !== account.email.toLowerCase()) return invitationFail(409, "Only the organizer can prepare invitations or cancellations.");
    const key = hash(["draft", account.id, id, expected, method]);
    const old = get("calendarOperation", key);
    if (old?.draftId) return readDraft(account.id, old.draftId);
    if (event.cancelled) return invitationFail(409, "This event was cancelled.");
    const attendees = event.attendees.filter((person) => person.email.toLowerCase() !== account.email.toLowerCase());
    if (!attendees.length) return invitationFail(400, "Add an attendee before preparing an invitation.");
    const invitation: Invitation = { uid: event.uid || `${event.id}@emc2.invalid`, sequence: Math.max(event.revision - 1, (event.sequence ?? -1) + 1), method,
      organizer: account.email, attendees: attendees.map((person) => ({ email: person.email, response: "NEEDS-ACTION" })),
      title: event.title, start: event.start, end: event.end, allDay: event.allDay, location: event.location, notes: event.description, meetLink: event.meetLink };
    const draft = createDraftInTransaction(account.id, { to: attendees[0].email, cc: attendees.slice(1).map((person) => person.email), subject: `${method === "CANCEL" ? "Cancelled: " : "Invitation: "}${event.title}`, body: `${event.title}\n${event.start} to ${event.end}${event.location ? `\n${event.location}` : ""}${event.description ? `\n\n${event.description}` : ""}` }, invitation, { eventId: id, revision: expected });
    put("calendarOperation", key, { id: key, accountId: account.id, eventId: id, revision: expected, kind: method, draftId: draft.id, state: "complete" });
    put("calendarEvent", id, { ...event, uid: invitation.uid, organizer: invitation.organizer, sequence: invitation.sequence });
    return draft;
  });
}
export function prepareReply(id: string, fingerprint: string, answer: z.infer<typeof response>) {
  return transaction(() => {
    const { mail, account, invitation } = supported(id, fingerprint);
    if (invitation.method !== "REQUEST") return invitationFail(409, "Only an invitation request can receive an RSVP draft.");
    const matches = localMatches(account.id, invitation);
    if (matches.length > 1) return invitationFail(409, "More than one event matches this invitation. Review the calendar.");
    const current = matches[0];
    if (current && (current.cancelled || (current.sequence || 0) > invitation.sequence)) return invitationFail(409, "A newer invitation or cancellation is already saved.");
    const key = hash(["reply", account.id, invitation.uid, invitation.sequence, fingerprint, answer]);
    const old = get("calendarOperation", key);
    if (old?.draftId) {
      if (current?.myResponse !== localResponse(answer)) return invitationFail(409, "A later response is already saved. Review the current event and drafts.");
      return readDraft(account.id, old.draftId);
    }
    if (Date.parse(invitation.end) - Date.parse(invitation.start) > 14 * 86400000) return invitationFail(409, "This invitation exceeds the local 14-day event limit.");
    const own = invitation.attendees.find((person) => person.email.toLowerCase() === account.email.toLowerCase())!;
    const reply: Invitation = { ...invitation, method: "REPLY", attendees: [{ email: own.email, response: answer }] };
    const eventId = current?.id || `invite:${hash([account.id, invitation.uid, invitation.organizer.toLowerCase()])}`;
    const draft = createDraftInTransaction(account.id, { to: invitation.organizer, cc: [], subject: `${answer}: ${invitation.title}`, body: `${account.email}: ${answer}\n${invitation.title}\n${invitation.start} to ${invitation.end}`, inReplyTo: mail.messageId, references: mail.messageId ? [mail.messageId] : undefined, threadId: mail.threadId }, reply, { eventId, revision: (current?.revision || 0) + 1, sourceMailId: mail.id, sourceFingerprint: fingerprint });
    const event: CalendarEvent = { id: eventId, source: "local", accountId: account.id, sourceMailId: mail.id,
      uid: invitation.uid, sequence: invitation.sequence, organizer: invitation.organizer, title: invitation.title, start: invitation.start, end: invitation.end, allDay: invitation.allDay,
      location: invitation.location, description: invitation.notes, meetLink: invitation.meetLink, attendees: invitation.attendees.map((person) => ({ email: person.email, response: localResponse(person.email.toLowerCase() === own.email.toLowerCase() ? answer : person.response) })),
      myResponse: localResponse(answer), revision: (current?.revision || 0) + 1, updatedAt: Date.now() };
    put("calendarEvent", event.id, event);
    put("calendarOperation", key, { id: key, accountId: account.id, eventId: event.id, revision: event.revision, kind: "REPLY", draftId: draft.id, state: "complete" });
    return draft;
  });
}
export function applyCalendarMessage(id: string, fingerprint: string) {
  return transaction(() => {
    const { account, invitation } = supported(id, fingerprint);
    if (invitation.method === "REQUEST") return invitationFail(409, "Choose an RSVP instead.");
    const matches = localMatches(account.id, invitation);
    if (matches.length !== 1) return invitationFail(409, "No unique local event matches this message.");
    const event = matches[0];
    if ((event.sequence || 0) > invitation.sequence || invitation.method === "REPLY" && event.sequence !== invitation.sequence) return invitationFail(409, "This message does not match the current event sequence.");
    const key = hash(["apply", account.id, fingerprint]);
    if (get("calendarOperation", key)) return event;
    const next = invitation.method === "CANCEL" ? { ...event, cancelled: true, sequence: invitation.sequence } : { ...event, attendees: event.attendees.map((person) => person.email.toLowerCase() === invitation.attendees[0].email.toLowerCase() ? { ...person, response: localResponse(invitation.attendees[0].response) } : person) };
    if (invitation.method === "REPLY" && !event.attendees.some((person) => person.email.toLowerCase() === invitation.attendees[0].email.toLowerCase())) return invitationFail(409, "The sender is not an attendee of this event.");
    put("calendarEvent", event.id, { ...next, revision: event.revision + 1, updatedAt: Date.now() });
    put("calendarOperation", key, { id: key, accountId: account.id, eventId: event.id, revision: event.revision, kind: "apply", state: "complete" });
    return next;
  });
}
export function mountInvitations(app: express.Express) {
  const router = express.Router();
  router.post("/calendar/events/:id/invitation", (req, res) => {
    const input = z.object({ revision: z.number().int().positive(), method: z.enum(["REQUEST", "CANCEL"]) }).strict().parse(req.body);
    res.json(prepareEventInvitation(req.params.id, input.revision, input.method));
  });
  router.get("/calendar/invitations/:id", (req, res) => {
    const value = source(req.params.id);
    let eligible = true;
    try { supported(req.params.id); } catch { eligible = false; }
    const invitation = value.mail.invitation;
    const remote = invitation?.status === "ok" && eligible ? remoteMatch(value.account.id, invitation.invitation) : undefined;
    res.json({ invitation, fingerprint: value.fingerprint, eligible, google: remote && get("googleCalendar", value.account.id)?.access ? remote : undefined });
  });
  router.post("/calendar/invitations/:id/reply", (req, res) => {
    const input = z.object({ fingerprint: z.string().length(64), response }).strict().parse(req.body);
    res.json(prepareReply(req.params.id, input.fingerprint, input.response));
  });
  router.post("/calendar/invitations/:id/apply", (req, res) => {
    const input = z.object({ fingerprint: z.string().length(64) }).strict().parse(req.body);
    res.json(applyCalendarMessage(req.params.id, input.fingerprint));
  });
  router.post("/calendar/invitations/:id/google-rsvp", async (req, res) => {
    const input = z.object({ fingerprint: z.string().length(64), response, requestId: z.uuid(), reconcile: z.boolean().optional() }).strict().parse(req.body);
    const { account, invitation } = supported(req.params.id, input.fingerprint);
    if (invitation.method !== "REQUEST") return invitationFail(409, "Only invitation requests accept RSVP.");
    const remote = remoteMatch(account.id, invitation);
    if (!remote) return invitationFail(409, "No unique Google event matches. Prepare a local reply draft instead.");
    res.json(await trackMailWork(() => googleRSVP(account.id, remote, localResponse(input.response), input.requestId, input.reconcile, { mailId: req.params.id, fingerprint: input.fingerprint, current: () => {
      try { supported(req.params.id, input.fingerprint); return true; } catch { return false; }
    } })));
  });
  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof InvitationError || error instanceof GoogleCalendarWriteError) res.status(error.status).json({ error: error.message }); else next(error);
  });
  app.use("/api", router);
}
