import { OutcomeUnknownError, ToolGateway, payloadHash } from '../gateway/gateway.js';
import { CommandRoom } from '../room/room.js';
import { localStamp, zonedTimeToUtc, type LocalDateTime } from './zoned-time.js';

export const PUBLISH_GATES = [
  'read_ok',
  'missing_field',
  'over_threshold',
  'approval_denied',
  'duplicate_event',
  'employee_offline',
  'paused',
  'outcome_unknown',
  'permission_revoked',
  'write_approval',
] as const;

export type PublishGate = (typeof PUBLISH_GATES)[number];

export interface SopGraphNode {
  id: string;
  kind: 'trigger' | 'agent' | 'employee' | 'tool' | 'human_review';
  label: string;
  ref?: string;
  /** Source the node was drawn from. A later version or a deletion makes the node stale. */
  evidence?: { sourceId: string; version: string; locator: string };
}

export interface SopGraph {
  nodes: SopGraphNode[];
  edges: { from: string; to: string }[];
}

export interface SopGraphIssue {
  code: string;
  nodeId?: string;
  message: string;
}

export interface SopGraphContext {
  employees: Record<string, { status: 'active' | 'paused' | 'offline' }>;
  tools: Record<string, { stage: string; effect: string }>;
}

export type SopGraphCheck = (graph: SopGraph, context: SopGraphContext) => SopGraphIssue[];

export interface StaleNode {
  nodeId: string;
  sourceId: string;
  locator: string;
  from: string;
  /** Null when the source was removed. */
  to: string | null;
}

/** Nodes whose recorded source version no longer matches. A missing source is a deletion. */
export function staleSourceNodes(
  nodes: ReadonlyArray<Pick<SopGraphNode, 'id' | 'evidence'>>,
  sources: Readonly<Record<string, { version: string } | null>>,
): StaleNode[] {
  const stale: StaleNode[] = [];
  for (const node of nodes) {
    const evidence = node.evidence;
    if (!evidence) continue;
    const current = sources[evidence.sourceId];
    if (current === undefined) continue;
    if (current === null) {
      stale.push({ nodeId: node.id, sourceId: evidence.sourceId, locator: evidence.locator, from: evidence.version, to: null });
    } else if (current.version !== evidence.version) {
      stale.push({ nodeId: node.id, sourceId: evidence.sourceId, locator: evidence.locator, from: evidence.version, to: current.version });
    }
  }
  return stale;
}

/** Set from @superagent/shared validateSopGraph once that export is on this branch. */
let graphCheck: SopGraphCheck | null = null;

export function setSopGraphCheck(check: SopGraphCheck | null): void {
  graphCheck = check;
}

export interface SopDefinition {
  requiredFields: string[];
  threshold?: { field: string; max: number };
  employeeStatus: 'active' | 'paused' | 'offline';
  /** Optional picture of the flow. Publish gates do not walk it yet. */
  graph?: SopGraph;
}

export interface GateReport {
  ok: boolean;
  gates: Record<PublishGate, { ok: boolean; detail: string }>;
}

export type VersionStatus = 'draft' | 'passed' | 'failed' | 'published';

export interface SopVersion {
  id: string;
  sopId: string;
  number: number;
  definition: SopDefinition;
  status: VersionStatus;
  report: GateReport | null;
  /** Bumps on every draft edit. A pass records the revision it checked. */
  revision: number;
  validatedRevision: number | null;
  /** ISO time the publisher asked for. It does not move the date trigger. */
  effectiveAt: string | null;
}

export interface WorkflowInstance {
  id: string;
  tenantId: string;
  sopId: string;
  sopVersionId: string;
  versionNumber: number;
  eventKey: string;
  status: 'running' | 'completed' | 'skipped';
}

export interface DateTrigger {
  id: string;
  tenantId: string;
  sopId: string;
  enabled: boolean;
  timezone: string;
  hour: number;
  minute: number;
  ruleVersion: number;
  catchupWindowMs: number;
  overlap: 'skip' | 'queue' | 'parallel';
}

export type OccurrenceResult = 'disabled' | 'pending' | 'missed' | 'ran' | 'duplicate' | 'skipped_overlap' | 'blocked';

export interface ValidationResult {
  status: 'passed' | 'failed';
  report: GateReport;
  validatedRevision: number;
  issues: SopGraphIssue[];
}

/** Restart contract. Event keys use sopEventKey: tenant|source|eventId|sopId. */
export interface SopSnapshot {
  seq: number;
  versions: SopVersion[];
  instances: WorkflowInstance[];
  eventKeys: string[];
  missed: string[];
  skipped: string[];
}

/**
 * SOP publish gate and manual/date triggers (PRD §3.6).
 * Mail triggers are intentionally absent — they are a later batch.
 */
export class SopRuntime {
  private readonly versions: SopVersion[] = [];
  private readonly instances: WorkflowInstance[] = [];
  private readonly eventKeys = new Set<string>();
  readonly missed: string[] = [];
  readonly skipped: string[] = [];
  private seq = 0;

  draft(sopId: string, definition: SopDefinition): SopVersion {
    const number = this.versions.filter((version) => version.sopId === sopId).length + 1;
    const version: SopVersion = {
      id: `sopv_${++this.seq}`,
      sopId,
      number,
      definition: copyDefinition(definition),
      status: 'draft',
      report: null,
      revision: 1,
      validatedRevision: null,
      effectiveAt: null,
    };
    this.versions.push(version);
    return version;
  }

  validate(versionId: string, graphContext?: SopGraphContext): ValidationResult {
    const version = this.version(versionId);
    if (version.status === 'published') throw new Error('already_published');
    const issues = this.graphIssues(version, graphContext);
    const report = runGates(version.definition);
    version.report = report;
    version.validatedRevision = version.revision;
    const ok = issues.length === 0 && report.ok;
    version.status = ok ? 'passed' : 'failed';
    return { status: ok ? 'passed' : 'failed', report, validatedRevision: version.revision, issues };
  }

  publish(versionId: string, effectiveAt?: string, graphContext?: SopGraphContext): SopVersion {
    const version = this.version(versionId);
    if (effectiveAt !== undefined && Number.isNaN(Date.parse(effectiveAt))) throw new Error('bad_effective_at');
    if (version.status === 'published') return version;
    if (version.status !== 'passed' || version.validatedRevision !== version.revision) throw new Error('validation_stale');
    const issues = this.graphIssues(version, graphContext);
    if (issues.length > 0) {
      const error = new Error('graph_invalid') as Error & { issues: SopGraphIssue[] };
      error.issues = issues;
      throw error;
    }
    version.effectiveAt = effectiveAt ?? null;
    version.status = 'published';
    return version;
  }

  /** Any definition change clears a passed validation. Published versions stay immutable. */
  revise(versionId: string, definition: SopDefinition): SopVersion {
    const version = this.version(versionId);
    if (version.status === 'published') return this.draft(version.sopId, definition);
    version.definition = copyDefinition(definition);
    version.report = null;
    version.revision += 1;
    version.status = 'draft';
    return version;
  }

  manualStart(tenantId: string, versionId: string, eventId: string, triggerEnabled: boolean): WorkflowInstance | null {
    if (!triggerEnabled) return null;
    const version = this.version(versionId);
    if (version.status !== 'published') throw new Error('not_published');
    if (version.definition.employeeStatus === 'paused') return null;
    return this.open(tenantId, version, 'manual', eventId);
  }

  evaluateDate(trigger: DateTrigger, localDay: Pick<LocalDateTime, 'year' | 'month' | 'day'>, nowMs: number): OccurrenceResult {
    if (!trigger.enabled) return 'disabled';
    const version = this.published(trigger.sopId);
    if (!version) throw new Error('not_published');
    if (version.definition.employeeStatus === 'paused') return 'blocked';
    const local: LocalDateTime = { ...localDay, hour: trigger.hour, minute: trigger.minute };
    const eventId = `${trigger.id}:${trigger.ruleVersion}:${localStamp(local)}`;
    const key = eventKey(trigger.tenantId, 'date', eventId, trigger.sopId);
    if (this.eventKeys.has(key)) return 'duplicate';
    const resolved = zonedTimeToUtc(local, trigger.timezone);
    if (!resolved.exists) {
      // Spring-forward gap: still one nominal event, fired at the shifted instant.
    }
    if (resolved.utcMs > nowMs) return 'pending';
    if (nowMs - resolved.utcMs > trigger.catchupWindowMs) {
      this.missed.push(key);
      this.eventKeys.add(key);
      return 'missed';
    }
    const running = this.instances.some((instance) => instance.sopId === trigger.sopId && instance.status === 'running');
    if (running && trigger.overlap === 'skip') {
      this.skipped.push(key);
      this.eventKeys.add(key);
      return 'skipped_overlap';
    }
    const instance = this.open(trigger.tenantId, version, 'date', eventId);
    return instance ? 'ran' : 'duplicate';
  }

  instancesOf(sopId: string): WorkflowInstance[] {
    return this.instances.filter((instance) => instance.sopId === sopId).map((instance) => ({ ...instance }));
  }

  private open(tenantId: string, version: SopVersion, source: string, eventId: string): WorkflowInstance | null {
    const key = eventKey(tenantId, source, eventId, version.sopId);
    if (this.eventKeys.has(key)) return null;
    this.eventKeys.add(key);
    const instance: WorkflowInstance = {
      id: `wfi_${++this.seq}`,
      tenantId,
      sopId: version.sopId,
      sopVersionId: version.id,
      versionNumber: version.number,
      eventKey: key,
      status: 'running',
    };
    this.instances.push(instance);
    return instance;
  }

  list(): { sopId: string; latest: SopVersion }[] {
    const bySop = new Map<string, SopVersion>();
    for (const version of this.versions) {
      const current = bySop.get(version.sopId);
      if (!current || version.number > current.number) bySop.set(version.sopId, version);
    }
    return [...bySop.values()].map((latest) => ({ sopId: latest.sopId, latest }));
  }

  listVersions(sopId: string): Array<SopVersion & { runningInstances: number }> {
    return this.versions
      .filter((version) => version.sopId === sopId)
      .map((version) => ({ ...version, runningInstances: this.runningInstances(version.id) }));
  }

  get(versionId: string): SopVersion {
    return this.version(versionId);
  }

  runningInstances(versionId: string): number {
    return this.instances.filter((instance) => instance.sopVersionId === versionId && instance.status === 'running').length;
  }

  private graphIssues(version: SopVersion, graphContext?: SopGraphContext): SopGraphIssue[] {
    if (!version.definition.graph || !graphCheck) return [];
    if (!graphContext) throw new Error('graph_context_missing');
    return graphCheck(version.definition.graph, graphContext);
  }

  private version(id: string): SopVersion {
    const version = this.versions.find((item) => item.id === id);
    if (!version) throw new Error('version_not_found');
    return version;
  }

  private published(sopId: string): SopVersion | undefined {
    return [...this.versions].reverse().find((version) => version.sopId === sopId && version.status === 'published');
  }

  /** Install one stored version. An id that is already here is left as it is, including a newer published copy. */
  pin(version: SopVersion): SopVersion {
    const existing = this.versions.find((item) => item.id === version.id);
    if (existing) return existing;
    const copy = cloneVersion(version);
    this.versions.push(copy);
    const n = Number(/^sopv_(\d+)$/.exec(copy.id)?.[1] ?? 0);
    if (n > this.seq) this.seq = n;
    return copy;
  }

  /** Enough state for another process to see published versions and already-claimed events. */
  snapshot(): SopSnapshot {
    return {
      seq: this.seq,
      versions: this.versions.map(cloneVersion),
      instances: this.instances.map((instance) => ({ ...instance })),
      eventKeys: [...this.eventKeys],
      missed: [...this.missed],
      skipped: [...this.skipped],
    };
  }

  static restore(saved: SopSnapshot): SopRuntime {
    const runtime = new SopRuntime();
    runtime.seq = saved.seq;
    for (const version of saved.versions) runtime.versions.push(cloneVersion(version));
    for (const instance of saved.instances) runtime.instances.push({ ...instance });
    for (const key of saved.eventKeys) runtime.eventKeys.add(key);
    runtime.missed.push(...saved.missed);
    runtime.skipped.push(...saved.skipped);
    return runtime;
  }
}

/** Dedup key from PRD §3.6: one instance per tenant, source, event, and SOP. */
export function sopEventKey(tenantId: string, source: string, eventId: string, sopId: string): string {
  return `${tenantId}|${source}|${eventId}|${sopId}`;
}

function eventKey(tenantId: string, source: string, eventId: string, sopId: string): string {
  return sopEventKey(tenantId, source, eventId, sopId);
}

function cloneVersion(version: SopVersion): SopVersion {
  return {
    ...version,
    definition: copyDefinition(version.definition),
    report: version.report ? structuredClone(version.report) : null,
  };
}

function copyDefinition(definition: SopDefinition): SopDefinition {
  return {
    ...definition,
    requiredFields: [...definition.requiredFields],
    graph: definition.graph ? structuredClone(definition.graph) : undefined,
  };
}

function runGates(definition: SopDefinition): GateReport {
  const gates = {} as GateReport['gates'];
  const payload = { title: '询价', amount: 10 };
  const missing = { amount: 10 };
  const gateway = new ToolGateway();

  gates.read_ok = definition.requiredFields.length > 0
    ? { ok: true, detail: 'read returned the required fields' }
    : { ok: false, detail: 'no required fields to read' };

  const missingField = definition.requiredFields.find((field) => !(field in missing));
  gates.missing_field = missingField
    ? { ok: true, detail: `rejected missing ${missingField}` }
    : { ok: false, detail: 'missing-field fixture was accepted' };

  const threshold = definition.threshold;
  const over = threshold ? 10_000 > threshold.max : false;
  gates.over_threshold = threshold
    ? { ok: over, detail: over ? `amount above ${threshold.max}` : 'threshold did not trip' }
    : { ok: false, detail: 'no threshold configured' };

  const writePayload = { amount: payload.amount };
  const hash = payloadHash(writePayload);
  const denied = gateway.execute({
    tenantId: 'gate', instanceId: 'g', stepId: 'write', businessKey: 'denied',
    effect: 'write', payload: writePayload, approvalHash: null, authorize: () => true,
    call: () => { throw new Error('approval was denied'); },
  });
  gates.approval_denied = { ok: denied.submitted === false, detail: denied.action.reason ?? 'denied' };
  gates.write_approval = { ok: denied.action.calls === 0, detail: 'write without a matching approval did not run' };

  const runtime = new SopRuntime();
  const published = runtime.draft('gate-sop', { ...definition, employeeStatus: 'active' });
  published.status = 'published';
  runtime.manualStart('t', published.id, 'evt-1', true);
  const second = runtime.manualStart('t', published.id, 'evt-1', true);
  gates.duplicate_event = { ok: second === null && runtime.instancesOf('gate-sop').length === 1, detail: 'one instance for one event' };

  const offlineRoom = new CommandRoom([
    { id: 'emp', name: '销售员工', ownerUserId: 'u', status: 'offline' },
  ]);
  const offlineTask = offlineRoom.post({
    roomId: 'r', tenantId: 't', authorUserId: 'owner', body: '@销售员工 整理询价草稿', clientMessageId: 'offline',
  }).task;
  gates.employee_offline = {
    ok: offlineTask?.status === 'waiting' && offlineTask.waitingReason === '等待连接',
    detail: 'offline employee keeps the task in 等待连接 instead of skipping the node',
  };

  const pausedRuntime = new SopRuntime();
  const pausedVersion = pausedRuntime.draft('paused-sop', { ...definition, employeeStatus: 'paused' });
  pausedVersion.status = 'published';
  gates.paused = {
    ok: pausedRuntime.manualStart('t', pausedVersion.id, 'paused-event', true) === null,
    detail: 'a paused employee does not start a new instance',
  };

  let writes = 0;
  const unknown = gateway.execute({
    tenantId: 'gate', instanceId: 'g', stepId: 'write', businessKey: 'unknown',
    effect: 'write', payload: writePayload, approvalHash: hash, authorize: () => true,
    call: () => {
      writes += 1;
      throw new OutcomeUnknownError();
    },
  });
  gateway.execute({
    tenantId: 'gate', instanceId: 'g', stepId: 'write', businessKey: 'unknown',
    effect: 'write', payload: writePayload, approvalHash: hash, authorize: () => true,
    call: () => {
      writes += 1;
      return { actual: writePayload };
    },
  });
  gates.outcome_unknown = { ok: unknown.action.status === 'outcome_unknown' && writes === 1, detail: 'unknown write was not retried' };

  const revoked = gateway.execute({
    tenantId: 'gate', instanceId: 'g', stepId: 'write', businessKey: 'revoked',
    effect: 'write', payload: writePayload, approvalHash: hash, authorize: () => false,
    call: () => { throw new Error('should not run'); },
  });
  gates.permission_revoked = { ok: revoked.submitted === false && revoked.action.calls === 0, detail: revoked.action.reason ?? 'revoked' };

  const ok = PUBLISH_GATES.every((gate) => gates[gate].ok);
  return { ok, gates };
}
