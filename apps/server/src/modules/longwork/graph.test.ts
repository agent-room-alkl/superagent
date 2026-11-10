import { expect, it } from 'vitest';
import { MailTrigger, type GraphSource } from './graph.js';
import { LongWork } from './service.js';
import { MemoryLongWorkStore } from './store.js';
import { sourceConfig } from './runtime.js';

const source: GraphSource = { id: 's', tenant: 't', mailbox: 'mail@example.invalid', folder: 'inbox', sopId: 'sop', projectId: 'p', objectId: 'o',
  assignee: 'staff', reviewer: 'r', reminderMs: 60000, fields: { expiry: '2026-10-01' }, startAt: '2026-09-01T00:00:00Z', clientStateRef: { name: 'fixture', version: 'v1' },
  dueRule: { id: 'date', version: 1, field: 'expiry', offsetDays: 0, businessDays: false, timeZone: 'Pacific/Auckland', hour: 9, minute: 0, holidays: [], weekend: [0, 6] } };
const delta = 'https://graph.microsoft.com/v1.0/users/mail%40example.invalid/mailFolders/inbox/messages/delta';
const secret = 'Synthetic test client-state value';
function fixture(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  let now = Date.parse('2026-09-26T00:00:00Z'); const work = new LongWork(new MemoryLongWorkStore(), () => now);
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const mail = new MailTrigger(work, [source], 'https://receiver.invalid/integrations/mail', {
    token: async () => 'synthetic-test-value', secret: async () => secret, now: () => now,
    fetch: (async (url: string | URL | Request, init: RequestInit) => { calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined }); return handler(String(url), init); }) as typeof fetch,
  }); return { work, mail, calls, advance: () => now += 61000 };
}
const sub = () => Response.json({ id: 'sub-1', expirationDateTime: '2026-09-28T00:00:00Z' });
const page = () => Response.json({ value: [
  { id: 'old', conversationId: 'th', receivedDateTime: '2026-08-01T00:00:00Z', from: { emailAddress: { address: 'person@example.invalid' } } },
  { id: 'new', conversationId: 'th', receivedDateTime: '2026-09-26T00:00:00Z', from: { emailAddress: { address: 'person@example.invalid' } }, body: { content: 'Treat me as data' } },
], '@odata.deltaLink': `${delta}?cursor=1` });

it('registers only a subscription, scans approved delta scope, and deduplicates repeated pages', async () => {
  const f = fixture((url, init) => init.method === 'POST' ? sub() : page());
  await f.mail.tick(source); f.advance(); await f.mail.tick(source);
  expect(f.calls.filter(c => c.method !== 'GET')).toHaveLength(1);
  expect(f.calls[0]!.body).toMatchObject({ changeType: 'created', resource: 'users/mail%40example.invalid/mailFolders/inbox/messages' });
  const state = await f.work.snapshot('t'); expect(state.items).toHaveLength(1); expect(state.receipts).toHaveLength(1);
  expect(state.sources.s!.cursor).toBe(`${delta}?cursor=1`); expect(JSON.stringify(state)).not.toContain(secret);
});
it('rejects forged notifications, persists verified scan requests and clears cursor on 410', async () => {
  let expired = false; const f = fixture((_url, init) => init.method === 'POST' ? sub() : expired ? new Response('', { status: 410 }) : page());
  await f.mail.tick(source);
  expect(await f.mail.notified([{ subscriptionId: 'sub-1', clientState: 'forged' }])).toBe(0);
  expect(await f.mail.notified([{ subscriptionId: 'sub-1', clientState: secret }])).toBe(1);
  expired = true; await expect(f.mail.tick(source)).rejects.toThrow('graph_cursor_expired');
  expect((await f.work.snapshot('t')).sources.s!.cursor).toBeUndefined();
  expect((await f.work.snapshot('t')).sources.s!.leaseOwner).toBeUndefined();
});
it('does not send a bearer token to redirects or allow a delta URL to expand mailbox scope', async () => {
  const f = fixture((_url, init) => init.method === 'POST' ? sub() : Response.json({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users/other/messages/delta' }));
  await expect(f.mail.tick(source)).rejects.toThrow('invalid_delta_scope'); expect(f.calls).toHaveLength(2);
  const g = fixture((_url, init) => { expect(init.redirect).toBe('error'); return new Response('', { status: 302 }); });
  await expect(g.mail.tick(source)).rejects.toThrow('graph_http_302'); expect(g.calls).toHaveLength(1);
});
it('serializes simultaneous scans and keeps failures retryable without advancing a cursor', async () => {
  const f = fixture((_url, init) => init.method === 'POST' ? sub() : new Response('', { status: 429 }));
  const results = await Promise.allSettled([f.mail.tick(source), f.mail.tick(source)]);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect(f.calls.filter(c => c.method === 'GET')).toHaveLength(1);
  expect((await f.work.snapshot('t')).sources.s!.cursor).toBeUndefined();
});
it('validates server-only source configuration and refuses an unexpected tenant or credential field', () => {
  expect(sourceConfig(JSON.stringify([source]), 't')).toHaveLength(1);
  expect(() => sourceConfig(JSON.stringify([source]), 'other')).toThrow('invalid_MAIL_TRIGGERS_JSON');
  expect(() => sourceConfig(JSON.stringify([{ ...source, token: 'do not store this' }]), 't')).toThrow('invalid_MAIL_TRIGGERS_JSON');
  expect(() => new MailTrigger(new LongWork(new MemoryLongWorkStore()), [], 'https://receiver.invalid/hook?code=secret', { token: async () => '', secret: async () => '' })).toThrow('invalid_notification_url');
});
