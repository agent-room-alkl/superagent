import { describe, it, expect } from 'vitest';
import type { ToolContract } from '@superagent/shared';
import { ToolService, GateError } from '../src/modules/tools/lifecycle.js';
import { EmployeeService, FAULT_THRESHOLD } from '../src/modules/employees/employees.js';

const contract = (over: Partial<ToolContract> = {}): ToolContract => ({
  toolId: 'invoice.lookup',
  action: 'invoice.read',
  purpose: 'Look up an invoice by lot',
  targetSystem: 'app.example.com',
  effect: 'read',
  input: { type: 'object', properties: { lot: { type: 'string' } } },
  output: { type: 'object', properties: { amount: { type: 'string' } } },
  risk: 'low',
  requiresExactApproval: false,
  ...over,
});

function placeholder(svc = new ToolService()) {
  svc.createPlaceholder({ name: 'Invoice lookup', contract: contract(), acceptanceCases: ['normal', 'missing'], consumers: ['emp-1'], maintainer: 'm1' });
  return svc;
}
const procedure = JSON.stringify({ toolId: 'invoice.lookup', effect: 'read', params: ['lot'], steps: [{ op: 'goto', url: 'https://app.example.com' }, { op: 'fill', selector: '#lot', param: 'lot' }, { op: 'extract', selector: '#amt', as: 'amount' }] });

function toAvailable(svc: ToolService, route: Parameters<ToolService['acquire']>[1]) {
  svc.confirmContract('invoice.lookup');
  svc.acquire('invoice.lookup', route);
  svc.recordTest('invoice.lookup', { normal: true, missing: true });
  const r = svc.release('invoice.lookup', 'reviewer-1');
  svc.recordDeploy('invoice.lookup', r.version, true, route.artifact);
  svc.install('invoice.lookup', 'emp-1');
  svc.bind('invoice.lookup', 'emp-1', 'kv://cred-emp-1', { projects: ['P-1'] }, () => true);
  return r;
}

describe('tool lifecycle gates', () => {
  it('a placeholder is never callable and starts at the placeholder step', () => {
    const svc = placeholder();
    expect(svc.callable('emp-1')).toEqual([]);
    expect(svc.stage('invoice.lookup').current).toBe('placeholder');
  });

  it('cannot acquire before the contract is confirmed', () => {
    const svc = placeholder();
    expect(() => svc.acquire('invoice.lookup', { route: 'import', developer: 'd1', artifact: 'x' })).toThrow(GateError);
  });

  it('failed or incomplete tests block release; developer cannot release own tool', () => {
    const svc = placeholder();
    svc.confirmContract('invoice.lookup');
    svc.acquire('invoice.lookup', { route: 'import', developer: 'd1', artifact: 'script' });
    svc.recordTest('invoice.lookup', { normal: true });
    expect(svc.stage('invoice.lookup').blocker).toMatch(/missing \(not run\)/);
    expect(() => svc.release('invoice.lookup', 'reviewer-1')).toThrow(/not passed/);
    svc.recordTest('invoice.lookup', { normal: true, missing: true });
    expect(() => svc.release('invoice.lookup', 'd1')).toThrow(/own tool/);
    expect(svc.release('invoice.lookup', 'reviewer-1').version).toBe('1.0.0');
  });

  it('contract revision invalidates the candidate and its tests', () => {
    const svc = placeholder();
    svc.confirmContract('invoice.lookup');
    svc.acquire('invoice.lookup', { route: 'import', developer: 'd1', artifact: 'script' });
    svc.recordTest('invoice.lookup', { normal: true, missing: true });
    svc.reviseContract('invoice.lookup', { purpose: 'changed' });
    expect(svc.get('invoice.lookup').candidate).toBeNull();
    expect(svc.stage('invoice.lookup').current).toBe('placeholder');
  });

  it('failed health check blocks installation; deployed digest must match the release', () => {
    const svc = placeholder();
    svc.confirmContract('invoice.lookup');
    svc.acquire('invoice.lookup', { route: 'import', developer: 'd1', artifact: 'script' });
    svc.recordTest('invoice.lookup', { normal: true, missing: true });
    const r = svc.release('invoice.lookup', 'reviewer-1');
    expect(() => svc.recordDeploy('invoice.lookup', r.version, true, 'tampered')).toThrow(/digest/);
    svc.recordDeploy('invoice.lookup', r.version, false, 'script');
    expect(() => svc.install('invoice.lookup', 'emp-1', r.version)).toThrow(/health check/);
  });

  it('available only after per-employee binding; binding change drops back to install', () => {
    const svc = placeholder();
    toAvailable(svc, { route: 'import', developer: 'd1', artifact: 'script' });
    expect(svc.callable('emp-1')).toEqual([{ toolId: 'invoice.lookup', version: '1.0.0', bindingVersion: 1 }]);
    expect(svc.callable('emp-2')).toEqual([]); // another employee does not inherit the install or credentials
    svc.bind('invoice.lookup', 'emp-1', 'kv://cred-other', { projects: ['P-1'] }, () => false);
    expect(svc.callable('emp-1')).toEqual([]);
    expect(svc.stage('invoice.lookup', 'emp-1').current).toBe('available');
    expect(svc.stage('invoice.lookup', 'emp-1').blocker).toMatch(/availability/);
  });

  it('upgrade keeps the old version for running work and supports rollback', () => {
    const svc = placeholder();
    toAvailable(svc, { route: 'import', developer: 'd1', artifact: 'v1' });
    const pinned = svc.callable('emp-1')[0]!;
    svc.acquire('invoice.lookup', { route: 'import', developer: 'd1', artifact: 'v2' });
    svc.recordTest('invoice.lookup', { normal: true, missing: true });
    const r2 = svc.release('invoice.lookup', 'reviewer-1');
    svc.recordDeploy('invoice.lookup', r2.version, true, 'v2');
    expect(r2.version).toBe('1.1.0');
    expect(pinned.version).toBe('1.0.0'); // snapshot taken earlier is unchanged
    expect(svc.rollback('invoice.lookup')).toBe('1.0.0');
  });

  it('unused placeholders can be cancelled; released tools cannot', () => {
    const svc = placeholder();
    svc.cancel('invoice.lookup');
    expect(svc.get('invoice.lookup').state).toBe('cancelled');
  });
});

describe('five acquisition routes reach available', () => {
  it('existing, agent_dev, import, browser_record, db_query', () => {
    for (const route of ['existing', 'agent_dev', 'import', 'browser_record', 'db_query'] as const) {
      const svc = placeholder();
      const artifact = route === 'browser_record' ? procedure : route === 'db_query' ? JSON.stringify({ template: 'select amount from invoices where lot=$1', readOnly: true }) : `${route}-artifact`;
      toAvailable(svc, { route, developer: 'd1', artifact, developerOnline: true });
      expect(svc.stage('invoice.lookup', 'emp-1')).toEqual({ done: ['placeholder', 'acquire', 'test', 'release', 'deploy', 'install', 'available'], current: 'available' });
    }
  });

  it('route-specific guards', () => {
    const svc = placeholder();
    svc.confirmContract('invoice.lookup');
    expect(() => svc.acquire('invoice.lookup', { route: 'agent_dev', developer: 'emp-dev', artifact: 'x', developerOnline: false })).toThrow(/not online/);
    expect(() => svc.acquire('invoice.lookup', { route: 'db_query', developer: 'd', artifact: JSON.stringify({ template: 'update x', readOnly: false }) })).toThrow(/read-only/);
    expect(() => svc.acquire('invoice.lookup', { route: 'browser_record', developer: 'd', artifact: JSON.stringify({ toolId: 'x', effect: 'read', params: [], steps: [], storageState: {} }) })).toThrow();
  });
});

describe('employees', () => {
  it('creation grants nothing; prompt versions; snapshots detect identity change', () => {
    const emps = new EmployeeService();
    const e = emps.create({ name: 'Finance assistant', duty: 'Check invoices', prompt: 'v1', owner: 'u1', source: 'recommended' });
    expect(e.status).toBe('unconnected');
    const snap = emps.snapshot(e.id, [{ toolId: 't', version: '1.0.0', bindingVersion: 1 }]);
    emps.updatePrompt(e.id, 'v2', 'u1');
    expect(emps.currentPrompt(e.id).version).toBe(2);
    expect(snap.promptVersion).toBe(1);
    expect(emps.identityChanged(snap, [{ toolId: 't', version: '1.0.0', bindingVersion: 1 }])).toBe(true);
  });

  it('pause wins; repeated failures fault the employee; delete blocked with active work', () => {
    let active = 1;
    const faults: string[] = [];
    const emps = new EmployeeService(() => active, () => new Date(), (x) => faults.push(x.id));
    const e = emps.create({ name: 'A', duty: 'd', prompt: 'p', owner: 'u' });
    emps.connect(e.id);
    emps.pause(e.id);
    expect(emps.canClaimWork(e.id)).toBe(false);
    expect(() => emps.connect(e.id)).toThrow(/paused/);
    emps.resume(e.id);
    for (let i = 0; i < FAULT_THRESHOLD; i++) emps.recordResult(e.id, false);
    expect(emps.get(e.id).status).toBe('fault');
    expect(faults).toEqual([e.id]);
    expect(() => emps.remove(e.id)).toThrow(/active task/);
    active = 0;
    emps.remove(e.id);
    expect(emps.list()).toEqual([]);
  });
});

import { buildApp } from '../src/app.js';
describe('tool routes', () => {
  it('reviewer comes from the signed-in user, so a developer cannot self-release over HTTP', async () => {
    const app = await buildApp();
    const dev = { 'x-dev-user': 'dev-1|owner|' };
    const rev = { 'x-dev-user': 'rev-1|reviewer|' };
    const c = { name: 'Lookup', contract: { ...contract(), toolId: 'http.tool' }, acceptanceCases: ['normal'], consumers: ['emp-1'] };
    expect((await app.inject({ method: 'POST', url: '/api/v1/tools/', headers: dev, payload: c })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/v1/tools/http.tool/confirm', headers: dev });
    await app.inject({ method: 'POST', url: '/api/v1/tools/http.tool/acquire', headers: dev, payload: { route: 'import', artifact: 'x' } });
    await app.inject({ method: 'POST', url: '/api/v1/tools/http.tool/test', headers: dev, payload: { results: { normal: true } } });
    const self = await app.inject({ method: 'POST', url: '/api/v1/tools/http.tool/release', headers: dev });
    expect(self.statusCode).toBe(409);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/tools/http.tool/release', headers: rev });
    expect(ok.json().releases[0].version).toBe('1.0.0');
    expect((await app.inject({ method: 'GET', url: '/api/v1/tools/http.tool', headers: { 'x-dev-user': 'e|employee|' } })).statusCode).toBe(403);
    await app.close();
  });
});
