/**
 * Core schema skeleton (PRD §5.5). Owners extend their own tables in their module PRs.
 * Rule: secrets are never stored here — only Key Vault secret names/versions.
 */
import { sql } from 'drizzle-orm';
import { pgTable, text, uuid, timestamp, jsonb, integer, boolean, bigint, uniqueIndex, index } from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () => uuid('tenant_id').notNull();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// ---- Platform (T-39) ----
export const tenants = pgTable('tenants', {
  id: id(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('Pacific/Auckland'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: id(),
  tenantId: tenantId(),
  entraOid: text('entra_oid').notNull(),
  displayName: text('display_name').notNull(),
  roles: jsonb('roles').$type<string[]>().notNull().default([]),
  projectScopes: jsonb('project_scopes').$type<string[]>().notNull().default([]),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('users_tenant_oid').on(t.tenantId, t.entraOid)]);

export const llmConfig = pgTable('llm_config', {
  tenantId: uuid('tenant_id').primaryKey(),
  provider: text('provider'),
  endpoint: text('endpoint'),
  keyVaultSecret: text('key_vault_secret'),
  keyVaultVersion: text('key_vault_version'),
  keyLast4: text('key_last4'),
  primaryModel: text('primary_model'),
  economyModel: text('economy_model'),
  retrieval: text('retrieval').notNull().default('keyword'),
  status: text('status').notNull().default('unconfigured'),
  monthlyCapMicroUsd: bigint('monthly_cap_micro_usd', { mode: 'number' }),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const modelCapabilities = pgTable('model_capabilities', {
  provider: text('provider').notNull(),
  modelId: text('model_id').notNull(),
  capabilities: jsonb('capabilities').notNull(),
  status: text('status').notNull(), // verified | unverified | retired
  testedAt: timestamp('tested_at', { withTimezone: true }),
  platformVersion: text('platform_version'),
}, (t) => [uniqueIndex('model_cap_pk').on(t.provider, t.modelId)]);

/** Budget ledger: bounded reservation then settlement (PRD §3.1). */
export const llmBudget = pgTable('llm_budget', {
  tenantId: uuid('tenant_id').notNull(),
  month: text('month').notNull(), // YYYY-MM
  capMicroUsd: bigint('cap_micro_usd', { mode: 'number' }).notNull(),
  reservedMicroUsd: bigint('reserved_micro_usd', { mode: 'number' }).notNull().default(0),
  spentMicroUsd: bigint('spent_micro_usd', { mode: 'number' }).notNull().default(0),
}, (t) => [uniqueIndex('llm_budget_pk').on(t.tenantId, t.month)]);

export const llmUsage = pgTable('llm_usage', {
  id: id(),
  tenantId: tenantId(),
  taskId: uuid('task_id'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  reservedMicroUsd: bigint('reserved_micro_usd', { mode: 'number' }).notNull(),
  costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }),
  status: text('status').notNull(), // reserved | settled | released | frozen_unknown
  month: text('month').notNull(), // budget month reserved against (migration 0003)
  at: createdAt(),
});

/** Append-only. App role has INSERT/SELECT only (see migrations/roles.sql). */
export const auditLog = pgTable('audit_log', {
  id: id(),
  tenantId: tenantId(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  objectType: text('object_type').notNull(),
  objectId: text('object_id').notNull(),
  versionRef: text('version_ref'),
  result: text('result').notNull(),
  detail: jsonb('detail').notNull().default({}),
  at: createdAt(),
}, (t) => [index('audit_object').on(t.tenantId, t.objectType, t.objectId)]);

// ---- Employees & tools (T-39 follow-up) ----
export const employees = pgTable('employees', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  duty: text('duty').notNull(),
  promptVersionId: uuid('prompt_version_id'),
  modelTier: text('model_tier').notNull().default('default'),
  knowledgeScope: jsonb('knowledge_scope').notNull().default({}),
  runtimeKind: text('runtime_kind').notNull().default('managed'),
  status: text('status').notNull().default('unconnected'),
  ownerUserId: uuid('owner_user_id'),
  createdAt: createdAt(),
});

export const tools = pgTable('tools', {
  id: text('id').primaryKey(), // stable toolId
  tenantId: tenantId(),
  name: text('name').notNull(),
  contract: jsonb('contract').notNull(),
  stage: text('stage').notNull().default('placeholder'),
  maintainer: uuid('maintainer'),
  reviewer: uuid('reviewer'),
  createdAt: createdAt(),
});

// ---- Knowledge (T-40 owns and extends) ----
export const connections = pgTable('connections', {
  id: id(),
  tenantId: tenantId(),
  pluginId: text('plugin_id').notNull(),
  config: jsonb('config').notNull().default({}),
  credentialRef: text('credential_ref'),
  scope: jsonb('scope').notNull().default({}),
  status: text('status').notNull().default('draft'),
  cursor: text('cursor'),
  confirmedBy: uuid('confirmed_by'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
});

export const sourceItems = pgTable('source_items', {
  id: id(),
  connectionId: uuid('connection_id').notNull(),
  externalId: text('external_id').notNull(),
  version: text('version').notNull(),
  title: text('title').notNull(),
  locator: text('locator').notNull(),
  acl: jsonb('acl'),
  aclStatus: text('acl_status').notNull().default('unknown'),
  contentHash: text('content_hash'),
  status: text('status').notNull().default('new'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }),
}, (t) => [uniqueIndex('source_item_ext').on(t.connectionId, t.externalId, t.version)]);

// ---- Runtime (T-41 owns and extends) ----
export const tasks = pgTable('tasks', {
  id: id(),
  tenantId: tenantId(),
  instanceId: uuid('instance_id'),
  roomMessageId: uuid('room_message_id'),
  employeeId: uuid('employee_id'),
  status: text('status').notNull().default('assigned'),
  leaseOwner: text('lease_owner'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  attempt: integer('attempt').notNull().default(0),
  identitySnapshot: jsonb('identity_snapshot'),
  deadLetter: boolean('dead_letter').notNull().default(false),
  kind: text('kind'),
  payload: jsonb('payload'),
  notBefore: timestamp('not_before', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index('tasks_claim').on(t.status, t.leaseUntil),
  uniqueIndex('tasks_open_work').on(
    t.kind,
    t.tenantId,
    sql`(coalesce(${t.payload}->>'operationId', ''))`,
    sql`(coalesce(${t.payload}->>'runId', ''))`,
  ).where(sql`${t.deadLetter} = false AND ${t.status} IN ('assigned', 'running')`),
]);

// Command room rows (T-41): text ids match the room module; (room_id, client_message_id) is the dedup key.
export const roomMessages = pgTable('room_messages', {
  id: text('id').primaryKey(),
  seq: integer('seq').notNull(),
  tenantId: text('tenant_id').notNull(),
  roomId: text('room_id').notNull(),
  author: text('author').notNull(),
  body: text('body').notNull(),
  clientMessageId: text('client_message_id').notNull(),
  mentions: jsonb('mentions').notNull(),
  taskIds: jsonb('task_ids').notNull(),
  // message | reply | report | review | cancel; NULL on rows from before migration 0006
  kind: text('kind'),
}, (t) => [uniqueIndex('room_messages_dedup').on(t.roomId, t.clientMessageId)]);

export const roomTasks = pgTable('room_tasks', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  roomId: text('room_id').notNull(),
  projectId: text('project_id'),
  messageId: text('message_id').notNull(),
  assigneeUserId: text('assignee_user_id').notNull(),
  employeeId: text('employee_id').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  waitingReason: text('waiting_reason'),
  // who asked, the task it continues, the prompt snapshot, approval need, who accepted it (migration 0006)
  context: jsonb('context').notNull().default({}),
});

export const roomMembers = pgTable('room_members', {
  roomId: text('room_id').notNull(),
  userId: text('user_id').notNull(),
}, (t) => [uniqueIndex('room_members_pk').on(t.roomId, t.userId)]);

export const humanWorkItems = pgTable('human_work_items', {
  id: id(),
  tenantId: tenantId(),
  kind: text('kind').notNull(),
  renderer: text('renderer').notNull(),
  taskId: uuid('task_id'),
  target: jsonb('target').notNull(),
  payloadVersion: integer('payload_version').notNull().default(1),
  assignee: uuid('assignee'),
  dueAt: timestamp('due_at', { withTimezone: true }),
  waitingOn: text('waiting_on'),
  status: text('status').notNull().default('open'),
  decision: jsonb('decision'),
  createdAt: createdAt(),
});
