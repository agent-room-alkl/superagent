import { randomUUID } from 'node:crypto';
import { payloadHash } from '../gateway/gateway.js';
import { objectDue, validateRule, type DateRule } from './dates.js';
import type { Action, Collection, LongItem, Store } from './store.js';

export interface MailSource {
  id: string; tenant: string; mailbox: string; folder: string; sopId: string; projectId: string; objectId: string;
  assignee: string; reviewer: string; reminderMs: number;
  /** Server-approved calendar rule + object fields, never instructions obtained from email. */
  dueRule: DateRule; fields: Record<string, unknown>;
}
export interface Incoming { id: string; threadId: string; from: string; receivedAt: string; body: string }
export interface ActionDriver {
  authorize(action: Action): Promise<boolean>;
  /** Must re-authorize the current identity, bind the approved payload and use id as external idempotency key. */
  execute(action: Action): Promise<{ status: 'succeeded' | 'failed' | 'unknown'; evidence: string }>;
  /** Must only read. A timeout/crash never calls execute a second time. */
  readback(action: Action): Promise<{ status: 'succeeded' | 'failed' | 'unknown'; evidence: string }>;
}
const key = (...parts: string[]) => JSON.stringify(parts);
function validText(value: unknown, limit = 256): value is string { return typeof value === 'string' && value.length > 0 && value.length <= limit; }
export function validateSource(s: MailSource) {
  if (![s.id, s.tenant, s.mailbox, s.folder, s.sopId, s.projectId, s.objectId, s.assignee, s.reviewer].every(x => validText(x)) ||
    !Number.isFinite(s.reminderMs) || s.reminderMs < 60000) throw Error('invalid_mail_source');
  validateRule(s.dueRule); objectDue(s.dueRule, s.fields);
}

export class LongWork {
  constructor(readonly store: Store, private now: () => number = Date.now) {}
  snapshot(tenant: string) { return this.store.change(tenant, s => s); }
  /** Register an explicit business wait; this never sends mail or claims that the evidence was system-verified. */
  openWaiting(source: MailSource, input: { requestId: string; person: string; threadId: string; evidence: string }) {
    validateSource(source);
    if (![input.requestId, input.person, input.threadId].every(x => validText(x)) || !validText(input.evidence, 2048)) throw Error('invalid_wait');
    return this.store.change(source.tenant, s => {
      const old = s.items.find(i => i.sourceId === source.id && i.sopId === source.sopId && i.waitRequestId === input.requestId);
      if (old) {
        if (old.threadId !== input.threadId || old.person !== input.person.toLowerCase() || old.objectId !== source.objectId || old.projectId !== source.projectId || old.registrationEvidence !== input.evidence) throw Error('wait_request_conflict');
        return old;
      }
      const due = objectDue(source.dueRule, source.fields);
      const item: LongItem = { id: randomUUID(), sourceId: source.id, sopId: source.sopId, projectId: source.projectId, objectId: source.objectId,
        person: input.person.toLowerCase(), threadId: input.threadId, assignee: source.assignee, phase: 'initial', dueAt: due.dueAt,
        dateRuleId: due.ruleId, dateRuleVersion: due.ruleVersion, reminderMs: source.reminderMs, events: [], replies: [],
        original: { body: '人工登记等待；凭证未经系统核验，没有发送邮件。', receivedAt: new Date(this.now()).toISOString() },
        waitRequestId: input.requestId, registrationEvidence: input.evidence };
      s.items.push(item); return item;
    });
  }
  close(tenant: string, id: string, projectId: string, assignee: string) {
    return this.store.change(tenant, s => {
      const i = s.items.find(i => i.id === id && i.projectId === projectId); if (!i) throw Error('not_found');
      if (i.assignee !== assignee) throw Error('forbidden');
      if (s.exceptions.some(e => !e.resolvedTo && e.candidates.includes(id))) throw Error('unresolved_exception_conflict');
      i.phase = 'closed'; this.cancelPending(s.actions, i.id); return i;
    }, { prepareSop: true });
  }

  async ingest(source: MailSource, mail: Incoming) {
    validateSource(source);
    if (![mail.id, mail.threadId, mail.from].every(x => validText(x)) || !Number.isFinite(Date.parse(mail.receivedAt)) ||
      typeof mail.body !== 'string' || mail.body.length > 100000) throw Error('invalid_mail');
    return this.store.change(source.tenant, state => {
      const receipt = key(source.tenant, source.id, mail.id, source.sopId);
      if (state.receipts.includes(receipt)) return { duplicate: true };
      const objectCandidates = state.items.filter(i => i.sourceId === source.id && i.sopId === source.sopId && i.projectId === source.projectId &&
        i.objectId === source.objectId && i.person === mail.from.toLowerCase() && i.phase !== 'closed');
      const exact = objectCandidates.filter(i => i.threadId === mail.threadId || i.threadAliases?.includes(mail.threadId));
      const candidates = exact.length ? exact : objectCandidates;
      state.receipts.push(receipt);
      if (candidates.length > 1 || (candidates.length === 1 && exact.length === 0)) {
        const exception = { id: randomUUID(), kind: 'exception_ruling' as const, renderer: 'issue_list' as const, assignee: source.reviewer,
          eventId: mail.id, candidates: candidates.map(i => i.id), projectId: source.projectId, sourceId: source.id, sopId: source.sopId, resolvedTo: null };
        state.exceptions.push(exception);
        // Keep the incoming data until a reviewer decides; do not choose by fuzzy content.
        return { exception, incoming: this.addReplyAction(state.actions, source, mail, exception.id) };
      }
      if (candidates.length === 1) {
        const item = candidates[0]!;
        item.events.push(mail.id); item.replies.push({ eventId: mail.id, body: mail.body, receivedAt: mail.receivedAt }); item.phase = 'replied';
        this.cancelPending(state.actions, item.id);
        return { item, merged: true };
      }
      const due = objectDue(source.dueRule, source.fields);
      const item: LongItem = { id: randomUUID(), sourceId: source.id, sopId: source.sopId, projectId: source.projectId,
        objectId: source.objectId, person: mail.from.toLowerCase(), threadId: mail.threadId, assignee: source.assignee,
        phase: 'initial', dueAt: due.dueAt, dateRuleId: due.ruleId, dateRuleVersion: due.ruleVersion, reminderMs: source.reminderMs,
        original: { body: mail.body, receivedAt: mail.receivedAt }, events: [mail.id], replies: [] };
      state.items.push(item);
      return { item, merged: false };
    }, { prepareSop: true });
  }

  private addReplyAction(actions: Action[], source: MailSource, mail: Incoming, exceptionId: string) {
    const payload = { kind: 'ambiguous_incoming', mail, reviewer: source.reviewer, exceptionId };
    const action: Action = { id: randomUUID(), batchId: exceptionId, rowId: mail.id, projectId: source.projectId,
      payload, hash: payloadHash(payload), status: 'pending', approval: null };
    actions.push(action); return action.id;
  }
  private cancelPending(actions: Action[], batchId: string) {
    for (const a of actions) if (a.batchId === batchId && ['pending', 'approved'].includes(a.status)) {
      a.status = 'failed'; a.evidence = 'Cancelled before submission: the item no longer needs this request';
    }
  }

  resolve(tenant: string, exceptionId: string, itemId: string, projectId: string) {
    return this.store.change(tenant, s => {
      const e = s.exceptions.find(x => x.id === exceptionId && x.projectId === projectId);
      if (!e || !e.candidates.includes(itemId)) throw Error('not_found');
      if (e.resolvedTo && e.resolvedTo !== itemId) throw Error('already_resolved');
      const item = s.items.find(i => i.id === itemId)!;
      if (!e.resolvedTo) {
        const a = s.actions.find(a => a.batchId === exceptionId)!;
        const mail = a.payload.mail as unknown as Incoming;
        item.events.push(mail.id); item.replies.push({ eventId: mail.id, body: mail.body, receivedAt: mail.receivedAt }); item.phase = 'replied';
        if (item.threadId !== mail.threadId && !item.threadAliases?.includes(mail.threadId)) (item.threadAliases ??= []).push(mail.threadId);
        this.cancelPending(s.actions, item.id);
        e.resolvedTo = itemId; e.resolutionKind = 'existing'; a.status = 'succeeded'; a.evidence = 'Reviewer matched incoming data; no external action executed';
      }
      return item;
    });
  }

  resolveAsNew(source: MailSource, exceptionId: string) {
    validateSource(source);
    return this.store.change(source.tenant, s => {
      const e = s.exceptions.find(e => e.id === exceptionId && e.projectId === source.projectId);
      if (!e) throw Error('not_found');
      const candidate = s.items.find(i => e.candidates.includes(i.id));
      if ((e.sourceId ?? candidate?.sourceId) !== source.id || (e.sopId ?? candidate?.sopId) !== source.sopId) throw Error('not_found');
      if (candidate && candidate.objectId !== source.objectId) throw Error('source_changed_conflict');
      if (e.resolvedTo) {
        if (e.resolutionKind !== 'new') throw Error('already_resolved');
        return s.items.find(i => i.id === e.resolvedTo)!;
      }
      const action = s.actions.find(a => a.batchId === exceptionId)!;
      const mail = action.payload.mail as unknown as Incoming;
      const due = objectDue(source.dueRule, source.fields);
      const item: LongItem = { id: randomUUID(), sourceId: source.id, sopId: source.sopId, projectId: source.projectId,
        objectId: source.objectId, person: mail.from.toLowerCase(), threadId: mail.threadId, assignee: source.assignee,
        phase: 'initial', dueAt: due.dueAt, dateRuleId: due.ruleId, dateRuleVersion: due.ruleVersion, reminderMs: source.reminderMs,
        original: { body: mail.body, receivedAt: mail.receivedAt }, events: [mail.id], replies: [] };
      s.items.push(item); e.resolvedTo = item.id; e.resolutionKind = 'new';
      action.status = 'succeeded'; action.evidence = 'Reviewer classified incoming data as a new case; no external action executed';
      return item;
    }, { prepareSop: true });
  }

  saveRule(tenant: string, rule: DateRule) {
    validateRule(rule);
    return this.store.change(tenant, s => {
      if (s.rules.some(r => r.id === rule.id && r.version >= rule.version)) throw Error('rule_version_conflict');
      s.rules.push(structuredClone(rule)); return rule;
    });
  }
  dates(tenant: string, ruleId: string, version: number, objects: Array<{ id: string; fields: Record<string, unknown> }>) {
    return this.store.change(tenant, s => {
      const rule = s.rules.find(r => r.id === ruleId && r.version === version); if (!rule) throw Error('rule_not_found');
      return objects.map(o => ({ objectId: o.id, ...objectDue(rule, o.fields) }));
    });
  }

  createBatch(tenant: string, batchId: string, projectId: string, rows: Array<{ id: string; payload: Record<string, unknown> }>) {
    if (!validText(batchId) || !validText(projectId) || !Array.isArray(rows) || !rows.length || rows.length > 500 || new Set(rows.map(r => r.id)).size !== rows.length) throw Error('invalid_batch');
    return this.store.change(tenant, s => {
      const existing = s.actions.filter(a => a.batchId === batchId);
      if (existing.length) {
        if (existing.length !== rows.length || rows.some(r => !existing.some(a => a.rowId === r.id && a.projectId === projectId && a.hash === payloadHash(r.payload)))) throw Error('batch_conflict');
        return existing;
      }
      const actions = rows.map(row => {
        if (!validText(row.id) || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) throw Error('invalid_row');
        return { id: randomUUID(), batchId, rowId: row.id, projectId, payload: structuredClone(row.payload), hash: payloadHash(row.payload), status: 'pending' as const, approval: null };
      }); s.actions.push(...actions); return actions;
    });
  }
  approve(tenant: string, batchId: string, projectId: string, selected: Array<{ id: string; hash: string }>, by: string) {
    if (!Array.isArray(selected) || !selected.length || new Set(selected.map(x => x.id)).size !== selected.length) throw Error('invalid_selection');
    return this.store.change(tenant, s => {
      const actions = selected.map(row => {
        const a = s.actions.find(x => x.batchId === batchId && x.rowId === row.id && x.projectId === projectId);
        if (!a || a.hash !== row.hash || a.payload.kind === 'ambiguous_incoming') throw Error('approval_conflict');
        if (a.status !== 'pending' && a.status !== 'approved') throw Error('no_resubmit');
        return a;
      });
      for (const a of actions) { a.approval = { by, hash: a.hash }; a.status = 'approved'; } return actions;
    });
  }

  /** Commit intent before I/O. Concurrent callers and restart recovery can only read an uncertain result. */
  async run(tenant: string, actionId: string, projectId: string, driver: ActionDriver) {
    const claim = await this.store.change(tenant, s => {
      const a = s.actions.find(x => x.id === actionId && x.projectId === projectId); if (!a) throw Error('not_found');
      if (a.status === 'succeeded' || a.status === 'failed') return { action: a, mode: 'none' as const };
      if (a.status === 'executing' && (a.leaseUntil ?? 0) > this.now()) throw Error('action_in_progress_conflict');
      if (a.status === 'executing' || a.status === 'unknown') return { action: a, mode: 'read' as const };
      if (a.status !== 'approved' || a.approval?.hash !== a.hash || payloadHash(a.payload) !== a.hash) throw Error('not_approved');
      a.status = 'executing'; a.leaseUntil = this.now() + 60000; return { action: a, mode: 'write' as const };
    });
    if (claim.mode === 'none') return claim.action;
    if (!await driver.authorize(claim.action)) {
      if (claim.mode === 'write') await this.store.change(tenant, s => { const a = s.actions.find(x => x.id === actionId)!;
        if (a.status === 'executing') a.status = 'approved'; });
      throw Error('not_authorized');
    }
    let result: Awaited<ReturnType<ActionDriver['execute']>>;
    try {
      result = await (claim.mode === 'write' ? driver.execute(claim.action) : driver.readback(claim.action));
      // A successful submission is not success until the external system is read back.
      if (claim.mode === 'write' && result.status === 'succeeded') {
        if (!await driver.authorize(claim.action)) result = { status: 'unknown', evidence: 'Read-back authorization revoked; result is unverified' };
        else result = await driver.readback(claim.action);
      }
      if (!['succeeded', 'failed', 'unknown'].includes(result.status) || !validText(result.evidence, 100000)) throw Error('invalid_connector_result');
    }
    catch { result = { status: 'unknown', evidence: 'Connector outcome is unknown; only read-back is allowed' }; }
    return this.store.change(tenant, s => {
      const a = s.actions.find(x => x.id === actionId)!;
      // Never downgrade a known result if an overlapping recovery read was inconclusive.
      if (a.status !== 'succeeded' && a.status !== 'failed') { a.status = result.status; a.evidence = result.evidence; delete a.leaseUntil; }
      return a;
    });
  }

  collect(tenant: string, input: Pick<Collection, 'id' | 'projectId' | 'deadline' | 'recipients'>) {
    if (!validText(input.id) || !validText(input.projectId) || !Number.isFinite(Date.parse(input.deadline)) || !input.recipients.length ||
      input.recipients.length > 500 || !input.recipients.every(x => validText(x)) || new Set(input.recipients).size !== input.recipients.length) throw Error('invalid_collection');
    return this.store.change(tenant, s => {
      const existing = s.collections.find(c => c.id === input.id);
      if (existing) { if (payloadHash(input) !== payloadHash({ id: existing.id, projectId: existing.projectId, deadline: existing.deadline, recipients: existing.recipients })) throw Error('collection_conflict'); return existing; }
      const c: Collection = { ...structuredClone(input), status: 'open', replies: {}, missing: [] }; s.collections.push(c);
      // Send intents require the same explicit approval and configured driver as any batch write.
      for (const person of c.recipients) { const payload = { kind: 'collection_request', collectionId: c.id, recipient: person, deadline: c.deadline };
        s.actions.push({ id: randomUUID(), batchId: `collection:${c.id}`, rowId: person, projectId: c.projectId, payload, hash: payloadHash(payload), status: 'pending', approval: null }); }
      return c;
    });
  }
  reply(tenant: string, id: string, projectId: string, person: string, evidence: string) {
    if (!validText(evidence, 100000)) throw Error('evidence_required');
    return this.store.change(tenant, s => {
      const c = s.collections.find(x => x.id === id && x.projectId === projectId); if (!c || !c.recipients.includes(person)) throw Error('not_found');
      if (c.status !== 'open' || this.now() >= Date.parse(c.deadline)) throw Error('collection_closed');
      c.replies[person] = evidence; return c;
    });
  }
  tick(tenant: string) {
    return this.store.change(tenant, s => {
      const now = this.now();
      for (const i of s.items) {
        if (!['initial', 'reminder'].includes(i.phase) || Date.parse(i.dueAt) > now) continue;
        const next = i.phase === 'initial' ? 'reminder' : 'final';
        const payload = { kind: 'reminder', itemId: i.id, phase: next, recipient: i.person };
        s.actions.push({ id: randomUUID(), batchId: i.id, rowId: next, projectId: i.projectId, payload, hash: payloadHash(payload), status: 'pending', approval: null });
        i.phase = next; i.dueAt = new Date(now + i.reminderMs).toISOString();
      }
      for (const c of s.collections) if (c.status === 'open' && Date.parse(c.deadline) <= now) {
        c.status = 'summarized'; c.missing = c.recipients.filter(p => !Object.prototype.hasOwnProperty.call(c.replies, p));
        this.cancelPending(s.actions, `collection:${c.id}`);
      }
      return { items: s.items, collections: s.collections };
    }, { prepareSop: true });
  }
}
