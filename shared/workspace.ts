import type { DraftContent, Mail, Rule } from "./types.js";
export type CommitmentStatus = "needs-reply" | "needs-work" | "waiting" | "done" | "cancelled";
export type CommitmentChange = {
  at: number;
  status: CommitmentStatus;
  dueAt?: number;
  dueDate?: string;
  followUpAt?: number;
  reason: string;
  text: string;
  evidenceMailIds: string[];
};
export type Commitment = {
  id: string;
  accountId: string;
  sourceMailId: string;
  text: string;
  reason: string;
  status: CommitmentStatus;
  dueAt?: number;
  dueDate?: string;
  followUpAt?: number;
  evidenceMailIds: string[];
  projectId?: string;
  revision: number;
  updatedAt: number;
  history: CommitmentChange[];
  sourceUnavailable?: boolean;
};
export type Project = {
  id: string;
  name: string;
  sourceMailIds: string[];
  accountIds: string[];
  crossAccountConfirmed: boolean;
  revision: number;
  updatedAt: number;
};
export type ProjectDecision = {
  id: string;
  projectId: string;
  text: string;
  sourceMailIds: string[];
  createdAt: number;
};
export type SentCoverage = {
  accountId: string;
  count: number;
  bound: number;
  observedAt: number;
  truncated: boolean;
  earliest?: number;
  error?: string;
};
export type Conversation = {
  accountId: string;
  messages: Mail[];
  gaps: string[];
  coverage?: SentCoverage;
};
export type AgentTool = "list_accounts" | "list_emails" | "search_emails" | "read_email" | "get_thread" | "reply_to_email" | "archive_email" | "mark_read" | "propose_draft" | "list_projects" | "list_commitments" | "create_project" | "track_commitment";
export type AgentGrant = {
  id: string;
  name: string;
  accountIds: string[];
  tools: AgentTool[];
  token: string;
  createdAt: number;
};
export type AgentAction = "send" | "draft" | "archive" | "read";
export type AgentPayload = DraftContent & {
  accountId: string;
  cc?: string[];
};
export type AgentProposal = {
  id: string;
  agentId: string;
  accountId: string;
  action: AgentAction;
  payload: AgentPayload | {
    mailId: string;
  };
  sourceMailId?: string;
  sourceFingerprint?: string;
  sourceChanged?: boolean;
  digest: string;
  createdAt: number;
  status: "pending" | "executing" | "succeeded" | "failed" | "unknown" | "rejected";
  receipt?: {
    at: number;
    message: string;
    draftId?: string;
  };
};
export type RulePreview = {
  rule: Omit<Rule, "id">;
  digest: string;
  count: number;
  examples: {
    id: string;
    subject: string;
    reason: string;
  }[];
};
export type Workspace = {
  commitments: Commitment[];
  projects: Project[];
  decisions: ProjectDecision[];
  coverage: SentCoverage[];
  proposals: AgentProposal[];
};
