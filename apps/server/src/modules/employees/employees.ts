/**
 * Digital employees (PRD §3.4). Prompt changes create new versions; running tasks keep the snapshot they claimed with.
 * Manual pause always wins; repeated failures move the employee to "fault"; deletion is blocked while work is active.
 */
export type EmployeeStatus = 'unconnected' | 'online' | 'busy' | 'waiting_auth' | 'paused' | 'fault';

export interface PromptVersion {
  version: number;
  text: string;
  createdBy: string;
  at: string;
}

export interface Employee {
  id: string;
  name: string;
  duty: string;
  modelTier: 'default' | 'primary' | 'economy';
  knowledgeScope: { sources: string[]; projects: string[] };
  owner: string;
  status: EmployeeStatus;
  prompts: PromptVersion[];
  consecutiveFailures: number;
  source: 'recommended' | 'manual';
}

export interface IdentitySnapshot {
  employeeId: string;
  promptVersion: number;
  modelTier: Employee['modelTier'];
  tools: { toolId: string; version: string; bindingVersion: number }[];
  takenAt: string;
}

export const FAULT_THRESHOLD = 3;

export class EmployeeService {
  private employees = new Map<string, Employee>();
  private seq = 0;
  constructor(
    private activeTaskCount: (employeeId: string) => number = () => 0,
    private now: () => Date = () => new Date(),
    private onFault?: (e: Employee) => void,
  ) {}

  create(input: { name: string; duty: string; prompt: string; owner: string; source?: Employee['source']; modelTier?: Employee['modelTier'] }): Employee {
    const e: Employee = {
      id: `emp-${++this.seq}`,
      name: input.name,
      duty: input.duty,
      modelTier: input.modelTier ?? 'default',
      knowledgeScope: { sources: [], projects: [] },
      owner: input.owner,
      status: 'unconnected', // creating an employee grants no runtime, tools or accounts
      prompts: [{ version: 1, text: input.prompt, createdBy: input.owner, at: this.now().toISOString() }],
      consecutiveFailures: 0,
      source: input.source ?? 'manual',
    };
    this.employees.set(e.id, e);
    return e;
  }

  get(id: string): Employee {
    const e = this.employees.get(id);
    if (!e) throw new Error(`employee ${id} not found`);
    return e;
  }

  list(): Employee[] {
    return [...this.employees.values()];
  }

  updatePrompt(id: string, text: string, by: string): PromptVersion {
    const e = this.get(id);
    const v: PromptVersion = { version: e.prompts.length + 1, text, createdBy: by, at: this.now().toISOString() };
    e.prompts.push(v);
    return v;
  }

  currentPrompt(id: string): PromptVersion {
    const p = this.get(id).prompts;
    return p[p.length - 1]!;
  }

  connect(id: string): void {
    const e = this.get(id);
    if (e.status === 'paused') throw new Error('employee is paused; resume first');
    e.status = 'online';
  }

  pause(id: string): void {
    this.get(id).status = 'paused';
  }

  resume(id: string): void {
    const e = this.get(id);
    if (e.status !== 'paused') return;
    e.status = 'online';
    e.consecutiveFailures = 0;
  }

  canClaimWork(id: string): boolean {
    return this.get(id).status === 'online';
  }

  recordResult(id: string, ok: boolean): void {
    const e = this.get(id);
    if (ok) {
      e.consecutiveFailures = 0;
      return;
    }
    e.consecutiveFailures++;
    if (e.consecutiveFailures >= FAULT_THRESHOLD && e.status !== 'paused') {
      e.status = 'fault';
      this.onFault?.(e);
    }
  }

  snapshot(id: string, tools: IdentitySnapshot['tools']): IdentitySnapshot {
    const e = this.get(id);
    return { employeeId: id, promptVersion: this.currentPrompt(id).version, modelTier: e.modelTier, tools, takenAt: this.now().toISOString() };
  }

  /** True if the identity changed since the snapshot (prompt, tier or any tool version/binding) — stop new actions. */
  identityChanged(snap: IdentitySnapshot, currentTools: IdentitySnapshot['tools']): boolean {
    const e = this.get(snap.employeeId);
    if (this.currentPrompt(e.id).version !== snap.promptVersion || e.modelTier !== snap.modelTier) return true;
    const key = (t: IdentitySnapshot['tools'][number]) => `${t.toolId}@${t.version}#${t.bindingVersion}`;
    return JSON.stringify(currentTools.map(key).sort()) !== JSON.stringify(snap.tools.map(key).sort());
  }

  remove(id: string): void {
    const n = this.activeTaskCount(id);
    if (n > 0) throw new Error(`employee has ${n} active task(s); reassign them before deleting`);
    this.employees.delete(id);
  }
}
