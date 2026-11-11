/**
 * Tool card lifecycle (PRD §3.5): placeholder → acquire → test → release → deploy → install → available.
 * One stable toolId through every route. Gates cannot be skipped; a contract change invalidates the candidate and its
 * tests; the developer can never release their own tool; a failed health check blocks installation; changing an
 * employee's binding drops that installation back to "install". Running instances keep the version they started with.
 */
import type { ToolContract, ToolRoute, ToolStage } from '@superagent/shared';
import { digestOf } from '../sandbox/guards.js';
import { validateProcedure, type Procedure } from '../sandbox/replay.js';

export interface Candidate {
  route: ToolRoute;
  developer: string; // user or employee id that produced it
  artifact: string; // serialized artifact (never executed here)
  digest: string;
  contractVersion: number;
  test?: { passed: boolean; failed: string[]; at: string };
}

export interface Release {
  version: string; // semver-like "1.0.0", "1.1.0"
  digest: string;
  contractVersion: number;
  releasedBy: string;
  deploy?: { healthy: boolean; at: string };
}

export interface Installation {
  employeeId: string;
  version: string;
  binding: { credentialRef: string; scope: Record<string, unknown>; version: number } | null;
  status: 'installed' | 'available';
}

export interface ToolCard {
  toolId: string;
  name: string;
  contract: ToolContract & { version: number; confirmed: boolean; acceptanceCases: string[] };
  consumers: string[];
  maintainer: string;
  candidate: Candidate | null;
  releases: Release[];
  activeVersion: string | null;
  installations: Installation[];
  state: 'active' | 'paused' | 'retired' | 'cancelled';
}

export class GateError extends Error {}

export interface AcquireInput {
  route: ToolRoute;
  developer: string;
  artifact: string;
  /** For agent_dev: is the developer employee online with an isolated workspace? */
  developerOnline?: boolean;
}

export class ToolService {
  private tools = new Map<string, ToolCard>();
  private seq = 0;
  constructor(private now: () => Date = () => new Date()) {}

  createPlaceholder(input: { name: string; contract: ToolContract; acceptanceCases: string[]; consumers: string[]; maintainer: string }): ToolCard {
    const toolId = input.contract.toolId || `tool-${++this.seq}`;
    if (this.tools.has(toolId)) throw new GateError(`tool ${toolId} already exists`);
    const card: ToolCard = {
      toolId,
      name: input.name,
      contract: { ...input.contract, toolId, version: 1, confirmed: false, acceptanceCases: input.acceptanceCases },
      consumers: input.consumers,
      maintainer: input.maintainer,
      candidate: null,
      releases: [],
      activeVersion: null,
      installations: [],
      state: 'active',
    };
    this.tools.set(toolId, card);
    return card;
  }

  list(): ToolCard[] {
    return [...this.tools.values()];
  }

  get(toolId: string): ToolCard {
    const t = this.tools.get(toolId);
    if (!t) throw new GateError(`tool ${toolId} not found`);
    return t;
  }

  confirmContract(toolId: string): void {
    const t = this.get(toolId);
    if (!t.contract.acceptanceCases.length) throw new GateError('contract needs at least one acceptance case');
    t.contract.confirmed = true;
  }

  /** Any contract change is a new contract version: candidate and tests are invalidated. */
  reviseContract(toolId: string, patch: Partial<ToolContract> & { acceptanceCases?: string[] }): void {
    const t = this.get(toolId);
    t.contract = { ...t.contract, ...patch, toolId, version: t.contract.version + 1, confirmed: false, acceptanceCases: patch.acceptanceCases ?? t.contract.acceptanceCases };
    t.candidate = null;
  }

  acquire(toolId: string, a: AcquireInput): Candidate {
    const t = this.get(toolId);
    if (!t.contract.confirmed) throw new GateError('confirm the contract before acquiring');
    if (a.route === 'agent_dev' && !a.developerOnline) throw new GateError('developer employee is not online with an isolated workspace');
    if (a.route === 'browser_record') {
      const p = JSON.parse(a.artifact) as Procedure;
      validateProcedure(p);
      if ((p.effect === 'write') !== (t.contract.effect === 'write' || t.contract.effect === 'external')) throw new GateError('recorded effect does not match the contract');
    }
    if (a.route === 'db_query') {
      const q = JSON.parse(a.artifact) as { template: string; readOnly: boolean };
      if (!q.readOnly || t.contract.effect !== 'read') throw new GateError('database route only produces read-only query tools');
    }
    // 'import' and 'existing': artifact stored as-is with its digest; nothing is executed here.
    t.candidate = { route: a.route, developer: a.developer, artifact: a.artifact, digest: digestOf(a.artifact), contractVersion: t.contract.version };
    return t.candidate;
  }

  recordTest(toolId: string, results: Record<string, boolean>): void {
    const t = this.get(toolId);
    if (!t.candidate) throw new GateError('no candidate to test');
    const missing = t.contract.acceptanceCases.filter((c) => !(c in results));
    const failed = Object.entries(results).filter(([, ok]) => !ok).map(([c]) => c);
    t.candidate.test = { passed: missing.length === 0 && failed.length === 0, failed: [...failed, ...missing.map((m) => `${m} (not run)`)], at: this.now().toISOString() };
  }

  release(toolId: string, reviewer: string): Release {
    const t = this.get(toolId);
    const c = t.candidate;
    if (!c) throw new GateError('no candidate');
    if (c.contractVersion !== t.contract.version) throw new GateError('candidate was built for an older contract');
    if (!c.test?.passed) throw new GateError('acceptance tests have not passed');
    if (reviewer === c.developer) throw new GateError('the developer cannot release their own tool');
    const [major, minor] = (t.releases.at(-1)?.version ?? '0.0.0').split('.').map(Number) as [number, number];
    const version = t.releases.length === 0 ? '1.0.0' : `${major}.${minor + 1}.0`;
    const r: Release = { version, digest: c.digest, contractVersion: c.contractVersion, releasedBy: reviewer };
    t.releases.push(r);
    t.candidate = null;
    return r;
  }

  recordDeploy(toolId: string, version: string, healthy: boolean, artifact: string): void {
    const r = this.release_(toolId, version);
    if (digestOf(artifact) !== r.digest) throw new GateError('deployed artifact digest differs from the release');
    r.deploy = { healthy, at: this.now().toISOString() };
    if (healthy) this.get(toolId).activeVersion = version;
  }

  install(toolId: string, employeeId: string, version?: string): Installation {
    const t = this.get(toolId);
    const v = version ?? t.activeVersion;
    if (!v) throw new GateError('no healthy deployed version to install');
    if (!this.release_(toolId, v).deploy?.healthy) throw new GateError('execution environment health check has not passed');
    const existing = t.installations.find((i) => i.employeeId === employeeId);
    if (existing) {
      existing.version = v;
      existing.status = existing.binding ? 'available' : 'installed';
      return existing;
    }
    const inst: Installation = { employeeId, version: v, binding: null, status: 'installed' };
    t.installations.push(inst);
    return inst;
  }

  /** Per-employee account and scope. Any change re-runs the availability check; until then the tool is not callable. */
  bind(toolId: string, employeeId: string, credentialRef: string, scope: Record<string, unknown>, check: () => boolean): Installation {
    const inst = this.get(toolId).installations.find((i) => i.employeeId === employeeId);
    if (!inst) throw new GateError('install the tool for this employee first');
    const changed = !inst.binding || inst.binding.credentialRef !== credentialRef || JSON.stringify(inst.binding.scope) !== JSON.stringify(scope);
    if (changed) inst.binding = { credentialRef, scope, version: (inst.binding?.version ?? 0) + 1 };
    inst.status = 'installed';
    if (check()) inst.status = 'available';
    return inst;
  }

  rollback(toolId: string): string {
    const t = this.get(toolId);
    const healthy = t.releases.filter((r) => r.deploy?.healthy);
    const idx = healthy.findIndex((r) => r.version === t.activeVersion);
    const prev = idx > 0 ? healthy[idx - 1] : undefined;
    if (!prev) throw new GateError('no earlier healthy version');
    const rolledBack = t.activeVersion;
    t.activeVersion = prev.version;
    for (const inst of t.installations) {
      if (inst.version === rolledBack) {
        inst.version = prev.version;
      }
    }
    return prev.version;
  }

  pause(toolId: string): void {
    this.get(toolId).state = 'paused';
  }

  cancel(toolId: string): void {
    const t = this.get(toolId);
    if (t.releases.length) throw new GateError('released tools are retired, not cancelled');
    t.state = 'cancelled';
  }

  /** What an employee may actually call now. Placeholders and unbound installs are never callable. */
  callable(employeeId: string): { toolId: string; version: string; bindingVersion: number }[] {
    return [...this.tools.values()]
      .filter((t) => t.state === 'active')
      .flatMap((t) => t.installations.filter((i) => i.employeeId === employeeId && i.status === 'available' && i.binding).map((i) => ({ toolId: t.toolId, version: i.version, bindingVersion: i.binding!.version })));
  }

  /** The 7-step progress for the tool card, relative to the main consumer when given. */
  stage(toolId: string, employeeId?: string): { done: ToolStage[]; current: ToolStage; blocker?: string } {
    const t = this.get(toolId);
    const order: ToolStage[] = ['placeholder', 'acquire', 'test', 'release', 'deploy', 'install', 'available'];
    const at = (s: ToolStage, blocker?: string) => ({ done: order.slice(0, order.indexOf(s)), current: s, ...(blocker ? { blocker } : {}) });
    if (!t.contract.confirmed) return at('placeholder', 'contract not confirmed');
    const latest = t.releases.at(-1);
    if (!latest || t.candidate) {
      if (!t.candidate) return at('acquire');
      if (!t.candidate.test) return at('test');
      if (!t.candidate.test.passed) return at('test', `failed: ${t.candidate.test.failed.join(', ')}`);
      return at('release', 'waiting for an independent reviewer');
    }
    if (!latest.deploy) return at('deploy');
    if (!latest.deploy.healthy) return at('deploy', 'health check failed');
    const inst = employeeId ? t.installations.find((i) => i.employeeId === employeeId) : t.installations[0];
    if (!inst) return at('install');
    // Installed but not yet callable (first binding pending, or a changed binding whose check has not passed):
    // the card is back at "install" until the availability check passes for the current binding.
    if (inst.status !== 'available') return at('install', inst.binding ? `availability check failed for binding v${inst.binding.version}` : 'account binding required');
    return { done: order, current: 'available' };
  }

  private release_(toolId: string, version: string): Release {
    const r = this.get(toolId).releases.find((x) => x.version === version);
    if (!r) throw new GateError(`version ${version} not released`);
    return r;
  }
}
