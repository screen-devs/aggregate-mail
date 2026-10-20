import type { Draft, DraftContent } from "../../shared/types";
import type { Api } from "../api";

export type Compose = DraftContent & { accountId: string };
export type DraftProgress = {
  phase: "idle" | "saving" | "saved" | "error";
  message: string;
};

export function composeContent(value: Compose): Compose {
  return {
    accountId: value.accountId,
    ...(value.cc !== undefined ? { cc: value.cc.slice() } : {}),
    ...(value.attachments !== undefined ? { attachments: value.attachments.map((item) => ({ ...item })) } : {}),
    to: value.to,
    subject: value.subject,
    body: value.body,
    inReplyTo: value.inReplyTo,
    threadId: value.threadId,
    references: value.references?.slice(),
    sendUnknown: Boolean(value.sendUnknown),
  };
}

const saveError = "Draft could not be saved. Your changes are still here. Retry before closing.";
const createError = "Draft save could not be confirmed. Recover the possible saved draft or save a separate copy before closing.";
const conflictError = "Draft changed or is unavailable. Your changes are still here. Recover it or save a separate copy.";
const discardError = "Draft could not be discarded. Your changes are still here. Try discarding again.";
const same = (left: Compose, right: Compose) =>
  JSON.stringify(composeContent(left)) === JSON.stringify(composeContent(right));

export class DraftSession {
  public content: Compose;
  public stored: Draft | undefined;
  private readonly accountId: string;
  private running: Promise<void> | undefined;
  private failure: Error | undefined;
  private inFlight: Compose | undefined;
  private failedPut: { before: Draft; attempted: Compose } | undefined;
  private createUnknown = false;
  private deleteUnknown = false;
  private discarding = false;
  private discarded = false;
  private discardTask: Promise<void> | undefined;

  constructor(
    private readonly api: Api,
    initial: Compose | Draft,
    private readonly notify: (progress: DraftProgress) => void,
  ) {
    this.accountId = initial.accountId;
    this.content = composeContent(initial);
    if ("id" in initial && "revision" in initial) {
      this.stored = {
        ...this.content, id: initial.id, revision: initial.revision,
        updatedAt: initial.updatedAt, sendUnknown: Boolean(initial.sendUnknown),
      };
    }
  }

  private get needsSave(): boolean {
    if (this.stored) return !same(this.content, this.stored);
    const value = this.content;
    return Boolean(value.to || value.subject || value.body || value.inReplyTo ||
      value.threadId || value.references?.length || value.cc?.length || value.attachments?.length || value.sendUnknown);
  }

  get dirty(): boolean {
    return !this.discarded && Boolean(this.failure || this.inFlight ||
      this.failedPut || this.deleteUnknown || this.needsSave);
  }

  change(next: Compose): void {
    if (this.discarded) return;
    if (next.accountId !== this.accountId) throw new Error("A draft cannot change accounts.");
    this.content = composeContent({
      ...next, sendUnknown: this.content.sendUnknown || this.stored?.sendUnknown || next.sendUnknown,
    });
    this.start();
    if (!this.running && !this.failure && !this.discarding) this.settled();
  }

  async flush(): Promise<void> {
    this.start();
    while (this.running) await this.running;
    if (this.discardTask) await this.discardTask;
    if (this.failure) throw this.failure;
  }

  async retry(): Promise<void> {
    if (this.discarded) return;
    if (this.running || this.discarding) return this.flush();
    if (this.createUnknown || this.deleteUnknown) throw this.failure!;
    this.failure = undefined;
    this.run(async () => {
      try {
        if (this.failedPut) await this.reconcilePut();
      } catch {
        this.fail(conflictError);
        return;
      }
      await this.save();
    });
    return this.flush();
  }

  discard(): Promise<void> {
    if (this.discarded) return Promise.resolve();
    if (this.discardTask) return this.discardTask;
    this.discarding = true;
    const active = this.running;
    this.discardTask = Promise.resolve().then(async () => {
      await active;
      try {
        if (this.createUnknown) throw new Error(createError);
        if (this.failedPut) await this.reconcilePut();
        if (this.stored) {
          if (this.deleteUnknown) {
            let current: Draft;
            try {
              current = await this.api<Draft>(this.path(this.stored.id));
            } catch (error) {
              if (typeof error === "object" && error !== null &&
                "status" in error && error.status === 404) {
                this.finishDiscard();
                return;
              }
              throw error;
            }
            this.observeUncertainty(current);
            if (current.id !== this.stored.id || current.accountId !== this.accountId ||
              current.revision !== this.stored.revision || !same(current, this.stored))
              throw new Error(conflictError);
          }
          this.deleteUnknown = true;
          await this.api(this.path(this.stored.id), "DELETE", {
            revision: this.stored.revision, confirmUnknown: true,
          });
        }
        this.finishDiscard();
      } catch {
        this.fail(this.createUnknown ? createError : discardError);
        throw this.failure;
      }
    }).finally(() => {
      this.discarding = false;
      this.discardTask = undefined;
    });
    return this.discardTask;
  }

  private path(id?: string): string {
    const base = `/accounts/${encodeURIComponent(this.accountId)}/drafts`;
    return id === undefined ? base : `${base}/${encodeURIComponent(id)}`;
  }

  private start(): void {
    if (!this.running && !this.failure && !this.discarding && !this.discarded && this.needsSave)
      this.run(() => this.save());
  }

  private run(work: () => Promise<void>): void {
    this.running = Promise.resolve().then(work).finally(() => {
      this.running = undefined;
      this.start();
    });
  }

  private async save(): Promise<void> {
    while (!this.discarding && !this.discarded && !this.failure && this.needsSave) {
      const attempted = composeContent(this.content);
      const { accountId: _accountId, ...content } = attempted;
      const before = this.stored;
      this.inFlight = attempted;
      this.notify({ phase: "saving", message: "Saving draft…" });
      try {
        const stored = before
          ? await this.api<Draft>(this.path(before.id), "PUT", { ...content, revision: before.revision })
          : await this.api<Draft>(this.path(), "POST", content);
        this.stored = { ...stored, ...composeContent(stored), sendUnknown: Boolean(stored.sendUnknown) };
        this.observeUncertainty(stored);
      } catch {
        if (before) this.failedPut = { before, attempted };
        else this.createUnknown = true;
        this.fail(before ? saveError : createError);
      } finally {
        this.inFlight = undefined;
      }
    }
    if (!this.failure && !this.discarding && !this.discarded) this.settled();
  }

  private async reconcilePut(): Promise<void> {
    const { before, attempted } = this.failedPut!;
    const current = await this.api<Draft>(this.path(before.id));
    this.observeUncertainty(current);
    if (current.id !== before.id || current.accountId !== this.accountId || !(
      (current.revision === before.revision + 1 && same(current, attempted)) ||
      (current.revision === before.revision && same(current, before))
    )) throw new Error(conflictError);
    this.stored = { ...current, ...composeContent(current), sendUnknown: Boolean(current.sendUnknown) };
    this.failedPut = undefined;
  }

  private observeUncertainty(value: Draft): void {
    if (value.sendUnknown) this.content = composeContent({ ...this.content, sendUnknown: true });
  }

  private fail(message: string): void {
    this.failure = new Error(message);
    this.notify({ phase: "error", message });
  }

  private settled(): void {
    this.notify(this.stored
      ? { phase: "saved", message: "Draft saved." }
      : { phase: "idle", message: "" });
  }

  private finishDiscard(): void {
    this.discarded = true;
    this.stored = undefined;
    this.failedPut = undefined;
    this.deleteUnknown = false;
    this.failure = undefined;
    this.notify({ phase: "idle", message: "" });
  }
}
