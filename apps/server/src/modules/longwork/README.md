# Long-running items (T-45)

`LongWork` owns durable long-item state, mail receipts, matching exceptions, calendar rule versions, per-row action
intents and collection summaries. `PgLongWorkStore` commits mutations under a tenant row lock. A duplicate mail and
the item it would create commit together. Recreating the service/process does not lose receipts or approved actions.
`MemoryLongWorkStore` is used only by local development and explicit fixtures.

## Mail triggers

Apply migration `0005_longwork.sql` before deploying the new web/worker versions. The existing migration runner
discovers it. Readiness reports the missing table; the worker refuses to start without it.

`MAIL_TRIGGERS_JSON` is a server-managed array of approved `GraphSource` definitions. Each contains:

- `id`, platform `tenant`, `mailbox`, `folder`, `sopId`, `projectId`, `objectId`, `assignee`, `reviewer`;
- `startAt` (ISO instant; initial delta pages cannot create items for earlier mail), `reminderMs` (at least 60 seconds);
- `dueRule` (immutable id/version, ontology `field`, signed `offsetDays`, `businessDays`, IANA `timeZone`, local
  `hour`/`minute`, ISO-date `holidays`, numeric `weekend`) and the object's approved `fields`;
- `clientStateRef: { name, version }`, pointing to a 24–128 character secret in the existing Key Vault store.

Set `MAIL_NOTIFICATION_URL` to the deployed HTTPS `/integrations/mail` route (no query credential). The managed
identity needs mailbox-limited Graph `Mail.Read`; the knowledge plugin's configuration does not grant this trigger
authorization. No `Mail.Send` or mailbox write operation is requested. Empty configuration means no Graph traffic.

The worker registers a `created` subscription, renews it before expiry and reconciles folder delta pages every
minute. A webhook only authenticates `subscriptionId` + `clientState` and durably requests a scan. It never treats
notification bodies as business instructions. Delta URLs must remain on the approved Graph mailbox/folder;
redirects are refused. A 410 clears the cursor for a bounded replay; receipt keys prevent duplicate items. Paging is
bounded to three pages per tick; a scan lease avoids overlapping workers and cursor regression. Graph/network
errors do not commit an unprocessed page cursor. Responses and credentials are never included in error messages.

Receipt identity is `(tenant, source, event, SOP)`. Mail body text is retained as data only. Replies merge into an
item only when source, SOP, project, object, person and a known thread match exactly. Owners can register an explicit
waiting case with `POST /items/waits` using an approved source id, stable request id, person, thread and evidence
reference. The reference stays human-reported, not system-verified; registration does not send mail. Duplicate
request ids return the same case and conflicting payloads are rejected. This allows separate real business waits
for the same person/object. A reply in a new thread with existing object/person candidates, or multiple exact
candidates, creates a durable
`exception_ruling` work item for the configured reviewer, with no automatic choice. Reviewers resolve it through
the long-item API; resolving twice to the same item is idempotent. These work items are exposed by the long-item
API and projected into the unified `/api/v1/work-items` list. WorkInboxPage lets the assigned reviewer select the
original case; owners can inspect another person's exception but cannot decide it on their behalf. A reviewed new
thread becomes an alias of the chosen case, so later replies return to the same id without another guess.

The first mail creates the long-running item associated with the configured SOP, rather than running the SOP's
general-purpose tool graph. This delivery does not add a new general-purpose SOP executor. Reminders advance
initial → reminder → final and create **pending send intents**; the phase never claims an email was sent.

## Dates, batches and collections

Authenticated routes are under `/api/v1/long-items`. Owners/admins can create rules, batches and collections.
Reviewers with project access can approve selected hashes and inspect/resolve exceptions. Employees see only
their own project-scoped long items and can submit a collection response only under their authenticated user id.
Cross-project objects are hidden, and the platform tenant always comes from server authentication.

Date rules are append-only versions. Local calendar arithmetic skips configured weekends/holidays before resolving
the wall clock in the IANA zone. DST gaps use the next valid minute; overlaps choose the earliest instant and are
explicitly labeled. Each item records its rule id/version. Missing/invalid dates do not invent a due date.

Each batch row has its own stable action id (also the connector's idempotency key), payload hash and approval.
Only selected hashes become approved; changed/replayed batch payloads conflict. Intent is committed before I/O.
An in-flight lease blocks an overlapping writer; after a crash or unknown result, that row permits **read-back
only**, never a second write. Successful submission is followed by authorized read-back before success is recorded.
Other pending/failed rows and completed rows remain separate, so continuing a batch cannot resend its successes.

Collections create one pending request intent per recipient, retain responses, and freeze the missing-recipient
summary at the deadline. Responses are human evidence, not a claim of system verification. Request intents still
show their independent delivery state; opening a collection is not proof that its requests were delivered.

`ActionDriver` is a trusted server adapter with call-time `authorize`, `execute`, and read-only `readback`. No driver
is installed by default: `/actions/:id/run` returns 503 `connector_not_configured` without changing the approved
action. Production mail sending/business writes therefore remain unavailable until an appropriately scoped real
adapter is supplied. This module never substitutes a fake success or bypasses the normal tool/account setup.

## Evidence and limits

`longwork.test.ts`: duplicate deliveries, exact/ambiguous matching, reminder intents, two DST transitions,
business calendars/versioning, selected-row approval, authorization revocation, unknown outcomes/restart, collection
deadlines. `graph.test.ts`: subscription requests, approved delta scopes, replay, forged notifications, 410 recovery,
redirect prevention and simultaneous scans. `http.test.ts`: real authenticated Fastify routes and access boundaries.
`store.pg.test.ts`: real PostgreSQL, 12 concurrent copies of one mail, rollback, a new service instance and an
unknown write recovered with exactly one read and no repeated submission.

Graph HTTP and business-tool tests use labeled synthetic adapters. They do not prove a live Microsoft 365 tenant
has granted consent or that a real email/business write occurred. Existing prototype assertion mappings are not
reclassified: the eight pending T-45 outcome-page assertions need their own UI integration and browser proof.
The tenant aggregate is intentionally serialized; large mailboxes/high-volume tenants require partitioning and
retention work before scaling. The unified inbox also shows assigned waiting cases, original mail, replies and their
stable case id. Only the assignee can close a case, and an unresolved matching exception blocks closing. Replies,
closure and collection deadlines cancel pending/approved reminder intents before submission; already uncertain or
in-flight actions retain their recovery state. General SOP graph execution remains an integration follow-up.

Official protocol references:

- [Graph webhook validation and delivery](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks)
- [Subscription lifecycle and renewal](https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events)
- [Message delta query](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0)
