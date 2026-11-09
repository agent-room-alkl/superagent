/**
 * Shared contracts for INNOPRO Super Agent.
 * Source of truth: docs/prd (PRD v1.3). Changes to these types go in a small, separate PR.
 */

// ---------- Roles & identity (PRD §1.2) ----------
export const ROLES = ['admin', 'owner', 'employee', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

export interface UserContext {
  tenantId: string;
  userId: string;
  roles: Role[];
  projectScopes: string[]; // empty = no project restriction granted
}

// ---------- LLM provider abstraction (PRD §5.4) ----------
export type LlmProviderId = 'anthropic' | 'openai' | 'azure-openai';

export interface ModelInfo {
  id: string;
  provider: LlmProviderId;
  displayName?: string;
  /** Capabilities proven by the platform allowlist test, not just listed by the provider. */
  verified: { chat: boolean; tools: boolean; structured: boolean; stream: boolean } | null;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxOutputTokens: number; // required: budget reservation is bounded by this (PRD §3.1)
  taskId?: string;
}

export interface ChatResponse {
  text: string;
  toolCalls: { id: string; name: string; input: unknown }[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
}

export interface LlmProvider {
  id: LlmProviderId;
  listModels(): Promise<ModelInfo[]>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  structured<T>(req: ChatRequest, schema: Record<string, unknown>): Promise<T>;
  embed?(texts: string[]): Promise<number[][]>;
}

// ---------- Knowledge source plugins (PRD §3.2) ----------
export type SourceChange = 'upsert' | 'deleted' | 'access_revoked';

export interface SourceItemRef {
  externalId: string;
  version: string;
  title: string;
  locator: string; // original-system link or path
  change: SourceChange;
}

export interface AclEntry {
  principal: string; // Entra object id or group id
  access: 'read';
}

export type AclResult = { status: 'known'; entries: AclEntry[] } | { status: 'unknown'; reason: string };

export type SourceErrorKind = 'auth' | 'scope' | 'throttled' | 'transient' | 'cursor_invalid' | 'not_found' | 'fatal';

export class SourceError extends Error {
  constructor(public kind: SourceErrorKind, message: string, public retryAfterMs?: number) {
    super(message);
    this.name = 'SourceError';
  }
}

export interface SourceContent {
  text: string;
  /** Position anchors so answers can cite page/line/table.column. */
  anchors: { start: number; end: number; locator: string }[];
  attachments?: SourceItemRef[];
}

export interface ConnectionConfig {
  connectionId: string;
  credentialRef: string | null; // Key Vault secret name; never a raw secret
  scope: Record<string, unknown>;
}

export interface KnowledgeSourcePlugin {
  manifest: {
    id: string;
    version: string;
    name: string;
    capabilities: { incremental: boolean; attachments: boolean; liveQuery: boolean; acl: boolean };
    permissions: string[]; // read-only permissions only
  };
  testConnection(conn: ConnectionConfig): Promise<{ ok: boolean; detail?: string }>;
  listItems(conn: ConnectionConfig, cursor?: string): Promise<{ items: SourceItemRef[]; nextCursor?: string }>;
  readItem(conn: ConnectionConfig, ref: SourceItemRef): Promise<SourceContent>;
  getAcl?(conn: ConnectionConfig, ref: SourceItemRef): Promise<AclResult>;
}

// ---------- Tools (PRD §3.5) ----------
export const TOOL_STAGES = ['placeholder', 'acquire', 'test', 'release', 'deploy', 'install', 'available'] as const;
export type ToolStage = (typeof TOOL_STAGES)[number];
export type ToolRoute = 'existing' | 'agent_dev' | 'import' | 'browser_record' | 'db_query';
export type ToolEffect = 'read' | 'draft' | 'write' | 'external';

export interface ToolContract {
  toolId: string;
  action: string;
  purpose: string;
  targetSystem: string;
  effect: ToolEffect;
  input: Record<string, unknown>; // JSON Schema
  output: Record<string, unknown>; // JSON Schema incl. read-back shape
  risk: 'low' | 'medium' | 'high';
  requiresExactApproval: boolean;
}

// ---------- Human work items (PRD §3.8) ----------
export const WORK_ITEM_KINDS = [
  'data_check',
  'action_approval',
  'manual_execution',
  'branch_choice',
  'exception_ruling',
  'supply_info',
  'deliverable_review',
] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];
export type WorkItemRenderer = 'field_diff' | 'batch_table' | 'document_preview' | 'issue_list';
export type WorkItemStatus = 'open' | 'in_progress' | 'needs_info' | 'decided' | 'closed' | 'expired' | 'withdrawn';

// ---------- Tasks & actions (PRD §3.7, §5.7) ----------
export type TaskStatus =
  | 'assigned'
  | 'running'
  | 'waiting'
  | 'reported'
  | 'reviewed'
  | 'rejected'
  | 'cancelled'
  | 'outcome_unknown';

export type ActionStatus = 'not_submitted' | 'executing' | 'confirmed' | 'failed' | 'outcome_unknown';

// ---------- Runtime roles (PRD §5.1) ----------
export const APP_ROLES = ['web', 'worker', 'browser'] as const;
export type AppRole = (typeof APP_ROLES)[number];
