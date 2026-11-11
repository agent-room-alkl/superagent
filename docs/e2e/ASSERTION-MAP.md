# Prototype assertion → E2E mapping (T-47)

Generated from the v9–v12 prototype QA scripts: every `ok(…, message)` site, counted once even when the prototype ran it in a loop. Person and tenant names from the prototype fixtures are replaced with neutral labels.

| Status | Meaning | Count |
|---|---|---|
| e2e | Covered by a Playwright test against the real app | 187 |
| unit | Behaviour covered by a server test; the UI-level E2E follows when the owning page ships | 70 |
| pending | Feature not built yet; the owner task will add the E2E | 0 |
| n/a | Prototype-only behaviour, with the reason given | 18 |
| **total** | | **275** |

Pending by owner: 

CI runs `apps/e2e/check-assertion-map.mjs`. It fails if a row has no valid status, if a `pending` row has no owner task, if an `n/a` row has no reason, or if an `e2e` reference points to a missing file. A `unit` reference to a test file still in an open PR is reported, not failed.

## qa-human-work

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | Queue title expanded | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 2 | sample-tenant fixtures opt in | n/a | prototype demo fixtures; the product starts empty (covered by "unbuilt modules say who owns them" and per-feature empty states) |
| 3 | No invented business tasks before opt in | n/a | prototype demo fixtures; the product starts empty (covered by "unbuilt modules say who owns them" and per-feature empty states) |
| 4 | staff member A sees only five assigned work items | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 5 | staff member A does not see manager-only exception | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 6 | Write approval waits for data confirmation | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 7 | Invalid monetary input cannot be confirmed | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 8 | Data confirmation does not execute write | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 9 | Approved action inherits confirmed data | e2e | apps/e2e/tests/mainline.spec.ts |
| 10 | Approval is distinct from execution | e2e | apps/e2e/tests/mainline.spec.ts |
| 11 | Unsaved changes cannot execute old approval | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 12 | Saved revision invalidates approval | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 13 | Unknown outcome retains single submission | e2e | apps/e2e/tests/mainline.spec.ts |
| 14 | Unknown outcome has no resubmit action | e2e | apps/e2e/tests/mainline.spec.ts |
| 15 | Unknown readback does not retry | unit | apps/server/test/execution.test.ts |
| 16 | Readback compares approved values | e2e | apps/e2e/tests/mainline.spec.ts |
| 17 | Manual report requires evidence | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 18 | Manual evidence is not system verified | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 19 | Quality review grants no action authority | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 20 | Batch conflict cannot be selected | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 21 | Batch confirmation includes only selected clean row | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 22 | Batch exception is retained | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 23 | Batch can continue without repeating confirmed row | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 24 | Manager default includes action and waiting groups | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 25 | Queue shows grouped work and due dates | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 26 | Manager does not see staff member A finance data | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 27 | External wait stays attached to original case | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 28 | Receiving documents is not automatic case completion | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 29 | Branch recorder cannot fabricate insurance approval | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 30 | Recorded branch choice survives reopening | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 31 | Mail renderer shows recipient and attachment identity | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 32 | Mail shows original context and AI field changes | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 33 | proof-of-concept user cannot send | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 34 | manager B sees exceptions without taking all normal work | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 35 | Exception decision preserves evidence and verification boundary | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 36 | Project filter selects only relevant work | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 37 | Project filter also scopes batch contents | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 38 | Upstream revision revokes downstream permission | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 39 | Mismatched readback stops without resubmission | e2e | apps/e2e/tests/mainline.spec.ts |
| 40 | Manual note cannot erase mismatched system outcome | e2e | apps/e2e/tests/work-inbox.spec.ts |
| 41 | Existing conversation still produces draft | e2e | apps/e2e/tests/command-room.spec.ts |
| 42 | Existing task evidence boundary retained | e2e | apps/e2e/tests/command-room.spec.ts |
| 43 | Human dialog styles do not leak to task drawer | n/a | prototype single-file CSS isolation; React components are scoped |
| 44 | No browser errors | e2e | apps/e2e/tests/fixtures.ts (every test fails on page/console errors) |

## qa-conversation

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | Old one-goal form remains | n/a | regression guard for an earlier prototype UI that the product never had |
| 2 | Manual fixed advance remains | n/a | regression guard for an earlier prototype UI that the product never had |
| 3 | Chat boot creates arbitrary tasks | e2e | apps/e2e/tests/command-room.spec.ts |
| 4 | Greeting forced task | e2e | apps/e2e/tests/command-room.spec.ts |
| 5 | Availability question forced task | e2e | apps/e2e/tests/command-room.spec.ts |
| 6 | Discussion not clarified | e2e | apps/e2e/tests/command-room.spec.ts |
| 7 | Mention picker not open | e2e | apps/e2e/tests/command-room.spec.ts |
| 8 | Mention insertion wrong | e2e | apps/e2e/tests/command-room.spec.ts |
| 9 | Conversation did not create one task | e2e | apps/e2e/tests/command-room.spec.ts |
| 10 | Assignment/source/prompt snapshot absent | e2e | apps/e2e/tests/command-room.spec.ts |
| 11 | Employee did not report | e2e | apps/e2e/tests/command-room.spec.ts — the report arrives through the report API from the person answering for the employee (the runtime will call the same route) |
| 12 | Dispatch/report not visible | e2e | apps/e2e/tests/command-room.spec.ts |
| 13 | Completed unreviewed task disappeared | e2e | apps/e2e/tests/command-room.spec.ts |
| 14 | Task evidence unlinked | e2e | apps/e2e/tests/command-room.spec.ts |
| 15 | New sent message stayed in old history | e2e | apps/e2e/tests/command-room.spec.ts |
| 16 | Follow-up lost original context/capability | e2e | apps/e2e/tests/command-room.spec.ts — follow-up is started from the task (追问), not guessed from wording |
| 17 | Missing tool fake-executed | unit | apps/server/test/tools.test.ts |
| 18 | External action did not ask parameters | e2e | apps/e2e/tests/command-room.spec.ts |
| 19 | Cancel failed | e2e | apps/e2e/tests/command-room.spec.ts — cancelled from the task drawer |
| 20 | Async replies erased draft | e2e | apps/e2e/tests/command-room.spec.ts |
| 21 | Readonly finance work incorrectly needs payment approval | e2e | apps/e2e/tests/command-room.spec.ts |
| 22 | Private draft leaked identity | e2e | apps/e2e/tests/command-room.spec.ts |
| 23 | Employee has private coordinator config | e2e | apps/e2e/tests/command-room.spec.ts |
| 24 | Other employee task leaked | e2e | apps/e2e/tests/command-room.spec.ts |
| 25 | Employee can assign another human agent | e2e | apps/e2e/tests/command-room.spec.ts |
| 26 | Employee own-scope work blocked | e2e | apps/e2e/tests/command-room.spec.ts |
| 27 | Mention menu leaks other employee | e2e | apps/e2e/tests/command-room.spec.ts |
| 28 | Owner draft not restored | e2e | apps/e2e/tests/command-room.spec.ts |
| 29 | Chat not principal scroll area | e2e | apps/e2e/tests/command-room.spec.ts — checked at the desktop viewport |
| 30 | Offline file conversation fails | n/a | prototype opened from file://; product is served over HTTPS |
| 31 | Shift+Enter unexpectedly sent | e2e | apps/e2e/tests/command-room.spec.ts |
| 32 | Enter did not send | e2e | apps/e2e/tests/command-room.spec.ts |

## qa-enablement

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | New company begins without invented knowledge | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-enablement#1]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 2 | Recommendations gated before knowledge confirmation | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-enablement#2]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 3 | Manual role is distinguished from document inference | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-enablement#3]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 4 | Actual local text file is read | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-enablement#4]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 5 | Imported but unconfirmed knowledge cannot generate recommendations | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-enablement#5]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 6 | Four roles follow distinct evidence-bearing responsibilities | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-enablement#6]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 7 | Every inferred role cites a source line | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-enablement#7]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 8 | Tools proposed alongside roles before business execution | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-enablement#8]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 9 | Missing tool starts as stable placeholder | e2e | apps/e2e/tests/tools.spec.ts |
| 10 | Reanalysis preserves human edits and presents differences | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-enablement#10]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 11 | Role creation grants no runtime or tools | unit | apps/server/test/tools.test.ts (describe employees) |
| 12 | Tool acquisition requires agreed specification | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 13 | Recording path requires explicit test/login preparation | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 14 | Progress exposes exactly one current accessible step | e2e | apps/e2e/tests/tools.spec.ts |
| 15 | Confirmed specification is marked complete | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 16 | Completed specification defaults to summary instead of form | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 17 | Recording candidate exposes parameters instead of fixed business data | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 18 | Recorded steps are not automatically released | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 19 | Closing tool drawer refreshes underlying lifecycle status | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 20 | Failed tests block release | e2e | apps/e2e/tests/tools.spec.ts |
| 21 | Current progress explains test blocker | e2e | apps/e2e/tests/tools.spec.ts |
| 22 | Test pass alone is not release authority | e2e | apps/e2e/tests/tools.spec.ts |
| 23 | Test pass advances current stage to release | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 24 | Fixed release is distinct from installation | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 25 | Released tool still requires execution environment deployment | e2e | apps/e2e/tests/tools.spec.ts |
| 26 | Failed environment check blocks installation | e2e | apps/e2e/tests/tools.spec.ts |
| 27 | Original business request created only explicitly | unit | apps/server/src/modules/sop/original-request.test.ts / apps/server/src/modules/sop/original-request.http.test.ts |
| 28 | Installed tool remains unavailable while target agent offline | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 29 | Completed deployment shows healthy timestamp summary without checkbox form | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 30 | Redeploy form opens only after explicit action | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 31 | Recording route reaches available only after per-employee check | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 32 | Completed personal binding shows summary instead of empty inputs | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 33 | Redeployment failure returns progress to deployment even after installation | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 34 | Tool availability does not bypass SOP confirmation | unit | apps/server/src/modules/sop/original-request.test.ts / apps/server/src/modules/sop/original-request.http.test.ts |
| 35 | Unimplemented tool nodes are explicitly blocked | e2e | apps/e2e/tests/superagent.spec.ts |
| 36 | Manual fallback requires explicit owner choice | unit | apps/server/src/modules/sop/original-request.test.ts |
| 37 | Paused original request does not auto-resume | unit | apps/server/src/modules/sop/original-request.test.ts / apps/server/src/modules/sop/original-request.http.test.ts |
| 38 | Same original request resumes without duplicate or fabricated execution | unit | apps/server/src/modules/sop/original-request.test.ts / apps/server/src/modules/sop/original-request.http.test.ts |
| 39 | Offline developer cannot be assigned | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 40 | Developer and consuming employee are separately recorded | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 41 | Assigned developer route reaches independently released availability | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 42 | Provided script imported as candidate without executing | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 43 | Human supplied route passes same lifecycle | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 44 | Existing tool route still validates and configures per employee | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 45 | Enabled installation has explicit saved binding state | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 46 | Account binding changes invalidate availability | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 47 | Unsaved contract changes cannot use previous test approval | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 48 | Saved contract revision invalidates candidate and tests | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 49 | Tool list exposes same compact lifecycle progress | e2e | apps/e2e/tests/tools.spec.ts ([qa-enablement#49]) |
| 50 | Reanalysis preserves explicit role deletion instead of recreating it | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-enablement#50]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 51 | Unused unimplemented tool can be explicitly cancelled without deleting published versions | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts |
| 52 | No browser errors or imported script execution | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-enablement#52]) |

## qa-enablement-guide

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | one title | n/a | static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 2 | all embedded images decode | n/a | static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 3 | index enters knowledge-first workspace | n/a | static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 4 | index cannot recommend before source confirmation | n/a | static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 5 | index starts with empty enterprise knowledge and roles | n/a | static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 6 | no browser errors | e2e | apps/e2e/tests/fixtures.ts (every test fails on page/console errors) |

## qa-outcomes

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | Primary navigation changed | e2e | apps/e2e/tests/shell.spec.ts |
| 2 | Empty summary invents work | e2e | apps/e2e/tests/command-room.spec.ts |
| 3 | Greeting forced business form/task | e2e | apps/e2e/tests/command-room.spec.ts |
| 4 | Async employee report replaced composer | e2e | apps/e2e/tests/command-room.spec.ts |
| 5 | Draft incorrectly marked human-accepted | e2e | apps/e2e/tests/command-room.spec.ts — a reported task is not accepted until a person reviews it |
| 6 | Draft boundary missing | e2e | apps/e2e/tests/command-room.spec.ts |
| 7 | Execution identity untraceable | e2e | apps/e2e/tests/mainline.spec.ts |
| 8 | Raw implementation JSON in result | e2e | apps/e2e/tests/command-room.spec.ts |
| 9 | Verified result cannot be reviewed | e2e | apps/e2e/tests/command-room.spec.ts |
| 10 | Malformed evidence passed | e2e | apps/e2e/tests/command-room.spec.ts |
| 11 | Failed evidence can be accepted | e2e | apps/e2e/tests/command-room.spec.ts |
| 12 | Human result acceptance missing | e2e | apps/e2e/tests/command-room.spec.ts |
| 13 | Missing information fake-executed | e2e | apps/e2e/tests/mainline.spec.ts |
| 14 | Empty supplement accepted | e2e | apps/e2e/tests/command-room.spec.ts |
| 15 | Supplement restarted/replaced task | e2e | apps/e2e/tests/command-room.spec.ts |
| 16 | Revoked tool still usable | unit | apps/server/test/tools.test.ts |
| 17 | Blocker has no responsible person | e2e | apps/e2e/tests/command-room.spec.ts |
| 18 | Authorized original task failed to resume | e2e | apps/e2e/tests/command-room.spec.ts (qa-outcomes#18, qa-outcomes#23) — release-hold returns 409 before the held tool is callable, and resumes the same task id to assigned once callable |
| 19 | Tool gap missing | unit | apps/server/test/tools.test.ts |
| 20 | Unreleased tool treated as reusable | unit | apps/server/test/tools.test.ts |
| 21 | Independent verification record absent | unit | apps/server/test/tools.test.ts |
| 22 | Release bypasses review | unit | apps/server/test/tools.test.ts |
| 23 | Capability delivery lost original task or did not resume | e2e | apps/e2e/tests/command-room.spec.ts (qa-outcomes#18, qa-outcomes#23) — a command-room task held for a missing toolId resumes the same task id after the tool completes all seven lifecycle steps for that employee |
| 24 | Executing version differs from approved version | unit | apps/server/test/tools.test.ts |
| 25 | Tool release leaked to other employee | unit | apps/server/test/tools.test.ts |
| 26 | Summary leaks other owner | e2e | apps/e2e/tests/command-room.spec.ts |
| 27 | Employee navigation expanded | e2e | apps/e2e/tests/command-room.spec.ts |
| 28 | Write rehearsal auto-approved | e2e | apps/e2e/tests/mainline.spec.ts — A real published SOP stops for human approval; the external ledger stays empty before the decision. |
| 29 | Approval does not bind parameters | unit | apps/server/test/execution.test.ts |
| 30 | Timeout marked complete/retried | unit | apps/server/test/execution.test.ts |
| 31 | Unknown write can be accepted | e2e | apps/e2e/tests/mainline.spec.ts |
| 32 | Unknown readback retried write | unit | apps/server/test/execution.test.ts |
| 33 | Mismatched write accepted or repeated | e2e | apps/e2e/tests/mainline.spec.ts |
| 34 | Mismatched result review enabled | e2e | apps/e2e/tests/mainline.spec.ts |
| 35 | Corrected external data could not be reread without a second write | e2e | apps/e2e/tests/mainline.spec.ts — An independent external correction is reread on the same run; the write connector count stays one. |
| 36 | Matching readback did not verify original request | e2e | apps/e2e/tests/mainline.spec.ts |
| 37 | Changed contract retains old action approval/acceptance | e2e | apps/e2e/tests/mainline.spec.ts — contract revision on the command-room task retires the linked run's approval and the human acceptance |
| 38 | Contract revision repeats write | e2e | apps/e2e/tests/mainline.spec.ts — the run keeps one gateway call and one ledger entry after the revision |
| 39 | Offline rehearsal discarded original task | e2e | apps/e2e/tests/command-room.spec.ts — a paused employee holds the same task as 等待连接 |
| 40 | Manual reconnect failed to resume original task | e2e | apps/e2e/tests/command-room.spec.ts — the owner resumes the employee, then resumes the same task id |
| 41 | Existing client incorrectly promises remote start | n/a | prototype copy about the desktop client; no such client in the product |
| 42 | Manual pause bypassed during readback | e2e | apps/e2e/tests/mainline.spec.ts — A paused employee is denied before the read-only probe; the probe count remains zero. |
| 43 | Paused readback repeated/finished external write | e2e | apps/e2e/tests/mainline.spec.ts — Denied paused reconciliation keeps the original run unknown and the external write count at one. |
| 44 | Async report erased SOP input | e2e | apps/e2e/tests/command-room.spec.ts |
| 45 | Async report replaced or lost workflow draft | e2e | apps/e2e/tests/command-room.spec.ts |
| 46 | Unvalidated draft can be published | e2e | apps/e2e/tests/superagent.spec.ts |
| 47 | Baseline validation missing regression cases | e2e | apps/e2e/tests/sop-validation-packs.spec.ts |
| 48 | Valid draft cannot publish | e2e | apps/e2e/tests/superagent.spec.ts |
| 49 | Validated confirmed draft not published | e2e | apps/e2e/tests/superagent.spec.ts |
| 50 | Stale validation published | e2e | apps/e2e/tests/superagent.spec.ts |
| 51 | Stale validation not explained | e2e | apps/e2e/tests/sop-validation-packs.spec.ts |
| 52 | Revalidated revision not published | e2e | apps/e2e/tests/sop-validation-packs.spec.ts |
| 53 | Publishing rewrote old instance | e2e | apps/e2e/tests/superagent.spec.ts |
| 54 | Pack replaced draft without explicit confirmation | e2e | apps/e2e/tests/sop-validation-packs.spec.ts |
| 55 | Pack auto-confirmed rule/trigger | e2e | apps/e2e/tests/sop-validation-packs.spec.ts |
| 56 | Pack modified published workflow | e2e | apps/e2e/tests/sop-validation-packs.spec.ts |
| 57 | Unconfirmed package can publish | e2e | apps/e2e/tests/sop-validation-packs.spec.ts |
| 58 | Confirmed package cannot validate | e2e | apps/e2e/tests/sop-validation-packs.spec.ts |
| 59 | Knowledge change has no impact/context | e2e | apps/e2e/tests/sop-validation-packs.spec.ts |
| 60 | Summary not linked to room | e2e | apps/e2e/tests/command-room.spec.ts |
| 61 | File origin outcome interactions broken | n/a | prototype opened from file://; product is served over HTTPS |

## qa-database-knowledge

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | Documents and databases share enterprise knowledge entry | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#1]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 2 | Data source requires explicit read-only policy acknowledgement | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#2]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 3 | Connection string cannot be pasted into credential reference | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#3]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 4 | Database source can start without any uploaded file | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#4]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 5 | Unconfirmed database cannot feed recommendations | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#5]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 6 | Confirming source forms logical enterprise knowledge space | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#6]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 7 | Knowledge space can be named without copying database | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#7]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 8 | Confirmed metadata can support role candidates | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#8]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 9 | Database evidence names tables/columns and schema version | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) |
| 10 | Schema does not become a published SOP | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#10]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 11 | Database metadata recommends read-only query placeholder without inventing mail workflow | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#11]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 12 | No current values invented from schema | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) |
| 13 | Out-of-scope project is refused | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) |
| 14 | Per-source row limit cannot be exceeded | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) |
| 15 | Query obeys requested and approved row count | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) |
| 16 | Projection excludes unapproved column | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) |
| 17 | Sensitive sample value is masked and other project absent | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) |
| 18 | Facts include source, time and synthetic status | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) |
| 19 | Live values and untrusted row text do not enter metadata knowledge | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) |
| 20 | Row update expires fact result without changing metadata analysis | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#20]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 21 | Next query reads new synthetic value | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#21]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 22 | Data change does not silently rewrite schema rules or team | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#22]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 23 | Timeout does not relabel cached result as fresh | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) |
| 24 | Reads and denials leave audit metadata | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#24]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 25 | Unavailable source cannot be queried | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#25]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 26 | Parameterized Lot lookup stays inside approved project | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#26]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 27 | Database column names do not split words | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#27]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 28 | Last fact column is reachable through local horizontal scroll | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#28]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 29 | Read-only database generation is fifth acquisition route | unit | apps/server/test/tools.test.ts |
| 30 | Database capability cannot be changed to write in UI | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#30]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 31 | Saving write effect is refused even if DOM is manipulated | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#31]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 32 | Generation produces controlled template candidate | unit | apps/server/test/tools.test.ts |
| 33 | Personal project options stay inside source permission | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#33]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 34 | Forged personal scope cannot expand source permission | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#34]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 35 | Schema change withdraws source confirmation and invalidates old analysis | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#35]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 36 | Metadata reanalysis preserves human role edits | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#36]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 37 | Reanalysis keeps stable query-tool identity | unit | apps/server/test/tools.test.ts |
| 38 | No browser errors or real SQL execution | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-database-knowledge#38]) |

## qa-database-guide

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | one title | n/a | static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 2 | four real screenshots embedded | n/a | static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 3 | primary entry includes database source | n/a | static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 4 | primary empty source gate retained | n/a | static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 5 | no errors | e2e | apps/e2e/tests/fixtures.ts (every test fails on page/console errors) |

## qa-source-plugins

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | Four knowledge-source manifests visible | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#1]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 2 | Local single-import built in, remote plugin not installed | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#2]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 3 | Catalog install has no implied connection or source | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#3]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 4 | Local file text actually read | unit | apps/server/test/knowledge.test.ts |
| 5 | Local upload has plugin connection item provenance | unit | apps/server/test/knowledge.test.ts |
| 6 | Import does not imply source confirmation | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#6]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 7 | Mail plugin installation creates no connection or source | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#7]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 8 | Knowledge install never requests Mail.Send | unit | apps/server/test/knowledge-m365.test.ts |
| 9 | Connection requires explicit read-only scope | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#9]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 10 | Invalid mail date scope rejected | unit | apps/server/test/knowledge-m365.test.ts |
| 11 | Preview shows mailbox folder and date scope | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#11]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 12 | Unknown ACL and out-of-scope entries blocked | unit | apps/server/test/knowledge.test.ts / apps/server/test/knowledge-m365.test.ts |
| 13 | Unknown ACL does not display body | unit | apps/server/test/knowledge.test.ts / apps/server/test/knowledge-m365.test.ts |
| 14 | Forged preview selection cannot bypass ACL | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#14]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 15 | Body and attachment imported with separate stable item ids | unit | apps/server/test/knowledge-m365.test.ts |
| 16 | Imported mail independently awaits confirmation with references and versions | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#16]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 17 | Confirmed mixed knowledge creates evidence-based candidates | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#17]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 18 | Mail recommendation evidence preserves original locator | unit | apps/server/test/knowledge-m365.test.ts |
| 19 | Delta update increments source version and invalidates analysis | unit | apps/server/test/knowledge.test.ts / apps/server/test/knowledge-m365.test.ts |
| 20 | Delta does not overwrite human role edit | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#20]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 21 | Reanalysis preserves human edits | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#21]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 22 | Failed sync keeps cursor and blocks cached source use | unit | apps/server/test/knowledge.test.ts / apps/server/test/knowledge-m365.test.ts |
| 23 | Recovery requires source confirmation again | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#23]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 24 | Revocation clears cached text and prevents reference | unit | apps/server/test/knowledge.test.ts / apps/server/test/knowledge-m365.test.ts |
| 25 | Forged source confirmation cannot override revoked ACL | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#25]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 26 | SharePoint preview preserves site library folder scope | unit | apps/server/test/knowledge-m365.test.ts |
| 27 | Source deletion retains tombstone but removes cached text | unit | apps/server/test/knowledge.test.ts / apps/server/test/knowledge-m365.test.ts |
| 28 | Paused knowledge plugin blocks its source references | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#28]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 29 | Database plugin leads to existing scoped read-only configuration | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#29]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 30 | Installing knowledge plugins did not install employee business tools | e2e | apps/e2e/tests/knowledge.spec.ts ([qa-source-plugins#30]) — Passed real React/Fastify/knowledge service/gateway browser case; external source, model and database drivers explicitly synthetic. |
| 31 | No browser errors | e2e | apps/e2e/tests/fixtures.ts (every test fails on page/console errors) |

## qa-room-header

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | Desktop heading and subtitle vertically centered in same row | e2e | apps/e2e/tests/shell.spec.ts |
| 2 | Employee header uses same single row | e2e | apps/e2e/tests/command-room.spec.ts |
| 3 | Employee subtitle retained | e2e | apps/e2e/tests/command-room.spec.ts |
| 4 | No browser errors | e2e | apps/e2e/tests/fixtures.ts (every test fails on page/console errors) |

## qa-source-guide

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | Five embedded real screenshots | n/a | static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 2 | No browser errors | e2e | apps/e2e/tests/fixtures.ts (every test fails on page/console errors) |
