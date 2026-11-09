# Prototype assertion → E2E mapping (T-47)

Generated from the v9–v12 prototype QA scripts: every `ok(…, message)` site, counted once even when the prototype ran it in a loop. Person and tenant names from the prototype fixtures are replaced with neutral labels.

| Status | Meaning | Count |
|---|---|---|
| e2e | Covered by a Playwright test against the real app | 33 |
| unit | Behaviour covered by a server test; the UI-level E2E follows when the owning page ships | 61 |
| pending | Feature not built yet; the owner task will add the E2E | 163 |
| n/a | Prototype-only behaviour, with the reason given | 18 |
| **total** | | **275** |

Pending by owner: T-40 51, T-41 97, T-45 15

CI runs `apps/e2e/check-assertion-map.mjs`. It fails if a row has no valid status, if a `pending` row has no owner task, if an `n/a` row has no reason, or if an `e2e` reference points to a missing file. A `unit` reference to a test file still in an open PR is reported, not failed.

## qa-human-work

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | Queue title expanded | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 2 | sample-tenant fixtures opt in | n/a |  — prototype demo fixtures; the product starts empty (covered by "unbuilt modules say who owns them" and per-feature empty states) |
| 3 | No invented business tasks before opt in | n/a |  — prototype demo fixtures; the product starts empty (covered by "unbuilt modules say who owns them" and per-feature empty states) |
| 4 | staff member A sees only five assigned work items | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 5 | staff member A does not see manager-only exception | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 6 | Write approval waits for data confirmation | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 7 | Invalid monetary input cannot be confirmed | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 8 | Data confirmation does not execute write | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 9 | Approved action inherits confirmed data | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 10 | Approval is distinct from execution | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 11 | Unsaved changes cannot execute old approval | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 12 | Saved revision invalidates approval | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 13 | Unknown outcome retains single submission | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 14 | Unknown outcome has no resubmit action | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 15 | Unknown readback does not retry | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 16 | Readback compares approved values | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 17 | Manual report requires evidence | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 18 | Manual evidence is not system verified | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 19 | Quality review grants no action authority | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 20 | Batch conflict cannot be selected | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 21 | Batch confirmation includes only selected clean row | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 22 | Batch exception is retained | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 23 | Batch can continue without repeating confirmed row | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 24 | Manager default includes action and waiting groups | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 25 | Queue shows grouped work and due dates | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 26 | Manager does not see staff member A finance data | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 27 | External wait stays attached to original case | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 28 | Receiving documents is not automatic case completion | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 29 | Branch recorder cannot fabricate insurance approval | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 30 | Recorded branch choice survives reopening | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 31 | Mail renderer shows recipient and attachment identity | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 32 | Mail shows original context and AI field changes | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 33 | proof-of-concept user cannot send | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 34 | manager B sees exceptions without taking all normal work | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 35 | Exception decision preserves evidence and verification boundary | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 36 | Project filter selects only relevant work | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 37 | Project filter also scopes batch contents | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 38 | Upstream revision revokes downstream permission | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 39 | Mismatched readback stops without resubmission | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 40 | Manual note cannot erase mismatched system outcome | pending | T-41 — human work items (待我处理) — Grok has humanwork module locally, not yet pushed |
| 41 | Existing conversation still produces draft | pending | T-41 |
| 42 | Existing task evidence boundary retained | pending | T-41 |
| 43 | Human dialog styles do not leak to task drawer | n/a |  — prototype single-file CSS isolation; React components are scoped |
| 44 | No browser errors | e2e | apps/e2e/tests/fixtures.ts (every test fails on page/console errors) |

## qa-conversation

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | Old one-goal form remains | n/a |  — regression guard for an earlier prototype UI that the product never had |
| 2 | Manual fixed advance remains | n/a |  — regression guard for an earlier prototype UI that the product never had |
| 3 | Chat boot creates arbitrary tasks | pending | T-41 — command room conversation / dispatch |
| 4 | Greeting forced task | pending | T-41 — command room conversation / dispatch |
| 5 | Availability question forced task | pending | T-41 — command room conversation / dispatch |
| 6 | Discussion not clarified | pending | T-41 — command room conversation / dispatch |
| 7 | Mention picker not open | pending | T-41 — command room conversation / dispatch |
| 8 | Mention insertion wrong | pending | T-41 — command room conversation / dispatch |
| 9 | Conversation did not create one task | pending | T-41 — command room conversation / dispatch |
| 10 | Assignment/source/prompt snapshot absent | pending | T-41 — command room conversation / dispatch |
| 11 | Employee did not report | pending | T-41 — command room conversation / dispatch |
| 12 | Dispatch/report not visible | pending | T-41 — command room conversation / dispatch |
| 13 | Completed unreviewed task disappeared | pending | T-41 — command room conversation / dispatch |
| 14 | Task evidence unlinked | pending | T-41 — command room conversation / dispatch |
| 15 | New sent message stayed in old history | pending | T-41 — command room conversation / dispatch |
| 16 | Follow-up lost original context/capability | pending | T-41 — command room conversation / dispatch |
| 17 | Missing tool fake-executed | unit | apps/server/test/tools.test.ts — UI E2E: T-41 (placeholders are never callable: ToolService.callable) |
| 18 | External action did not ask parameters | pending | T-41 — command room conversation / dispatch |
| 19 | Cancel failed | pending | T-41 — command room conversation / dispatch |
| 20 | Async replies erased draft | pending | T-41 — command room conversation / dispatch |
| 21 | Readonly finance work incorrectly needs payment approval | pending | T-41 — command room conversation / dispatch |
| 22 | Private draft leaked identity | pending | T-41 — command room conversation / dispatch |
| 23 | Employee has private coordinator config | pending | T-41 — command room conversation / dispatch |
| 24 | Other employee task leaked | pending | T-41 — command room conversation / dispatch |
| 25 | Employee can assign another human agent | pending | T-41 — command room conversation / dispatch |
| 26 | Employee own-scope work blocked | pending | T-41 — command room conversation / dispatch |
| 27 | Mention menu leaks other employee | pending | T-41 — command room conversation / dispatch |
| 28 | Owner draft not restored | pending | T-41 — command room conversation / dispatch |
| 29 | Chat not principal scroll area | pending | T-41 — command room conversation / dispatch |
| 30 | Offline file conversation fails | n/a |  — prototype opened from file://; product is served over HTTPS |
| 31 | Shift+Enter unexpectedly sent | pending | T-41 — command room conversation / dispatch |
| 32 | Enter did not send | pending | T-41 — command room conversation / dispatch |

## qa-enablement

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | New company begins without invented knowledge | pending | T-40 — analysis/recommendation UI; source layer covered in apps/server/test/knowledge.test.ts |
| 2 | Recommendations gated before knowledge confirmation | pending | T-40 — analysis/recommendation UI; source layer covered in apps/server/test/knowledge.test.ts |
| 3 | Manual role is distinguished from document inference | pending | T-40 — analysis/recommendation UI; source layer covered in apps/server/test/knowledge.test.ts |
| 4 | Actual local text file is read | pending | T-40 — analysis/recommendation UI; source layer covered in apps/server/test/knowledge.test.ts |
| 5 | Imported but unconfirmed knowledge cannot generate recommendations | pending | T-40 — analysis/recommendation UI; source layer covered in apps/server/test/knowledge.test.ts |
| 6 | Four roles follow distinct evidence-bearing responsibilities | pending | T-40 — analysis/recommendation UI; source layer covered in apps/server/test/knowledge.test.ts |
| 7 | Every inferred role cites a source line | pending | T-40 — analysis/recommendation UI; source layer covered in apps/server/test/knowledge.test.ts |
| 8 | Tools proposed alongside roles before business execution | pending | T-40 — analysis/recommendation UI; source layer covered in apps/server/test/knowledge.test.ts |
| 9 | Missing tool starts as stable placeholder | e2e | apps/e2e/tests/tools.spec.ts |
| 10 | Reanalysis preserves human edits and presents differences | pending | T-40 — analysis/recommendation UI; source layer covered in apps/server/test/knowledge.test.ts |
| 11 | Role creation grants no runtime or tools | unit | apps/server/test/tools.test.ts (describe employees) — UI E2E: T-42 |
| 12 | Tool acquisition requires agreed specification | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 13 | Recording path requires explicit test/login preparation | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 14 | Progress exposes exactly one current accessible step | e2e | apps/e2e/tests/tools.spec.ts |
| 15 | Confirmed specification is marked complete | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 16 | Completed specification defaults to summary instead of form | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 17 | Recording candidate exposes parameters instead of fixed business data | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 18 | Recorded steps are not automatically released | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 19 | Closing tool drawer refreshes underlying lifecycle status | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 20 | Failed tests block release | e2e | apps/e2e/tests/tools.spec.ts |
| 21 | Current progress explains test blocker | e2e | apps/e2e/tests/tools.spec.ts |
| 22 | Test pass alone is not release authority | e2e | apps/e2e/tests/tools.spec.ts |
| 23 | Test pass advances current stage to release | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 24 | Fixed release is distinct from installation | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 25 | Released tool still requires execution environment deployment | e2e | apps/e2e/tests/tools.spec.ts |
| 26 | Failed environment check blocks installation | e2e | apps/e2e/tests/tools.spec.ts |
| 27 | Original business request created only explicitly | pending | T-41 — original-request resume and SOP gates live in the runtime |
| 28 | Installed tool remains unavailable while target agent offline | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 29 | Completed deployment shows healthy timestamp summary without checkbox form | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 30 | Redeploy form opens only after explicit action | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 31 | Recording route reaches available only after per-employee check | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 32 | Completed personal binding shows summary instead of empty inputs | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 33 | Redeployment failure returns progress to deployment even after installation | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 34 | Tool availability does not bypass SOP confirmation | pending | T-41 — original-request resume and SOP gates live in the runtime |
| 35 | Unimplemented tool nodes are explicitly blocked | e2e | apps/e2e/tests/superagent.spec.ts |
| 36 | Manual fallback requires explicit owner choice | pending | T-41 — original-request resume and SOP gates live in the runtime |
| 37 | Paused original request does not auto-resume | pending | T-41 — original-request resume and SOP gates live in the runtime |
| 38 | Same original request resumes without duplicate or fabricated execution | pending | T-41 — original-request resume and SOP gates live in the runtime |
| 39 | Offline developer cannot be assigned | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 40 | Developer and consuming employee are separately recorded | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 41 | Assigned developer route reaches independently released availability | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 42 | Provided script imported as candidate without executing | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 43 | Human supplied route passes same lifecycle | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 44 | Existing tool route still validates and configures per employee | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 45 | Enabled installation has explicit saved binding state | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 46 | Account binding changes invalidate availability | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 47 | Unsaved contract changes cannot use previous test approval | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 48 | Saved contract revision invalidates candidate and tests | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 49 | Tool list exposes same compact lifecycle progress | e2e | apps/e2e/tests/tools.spec.ts |
| 50 | Reanalysis preserves explicit role deletion instead of recreating it | pending | T-40 — analysis/recommendation UI; source layer covered in apps/server/test/knowledge.test.ts |
| 51 | Unused unimplemented tool can be explicitly cancelled without deleting published versions | unit | apps/server/test/tools.test.ts / apps/server/test/sandbox.test.ts — UI E2E: T-42 tool card UI (follow-up E2E in tools.spec.ts as the card gains actions) |
| 52 | No browser errors or imported script execution | e2e | apps/e2e/tests/fixtures.ts (every test fails on page/console errors) |

## qa-enablement-guide

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | one title | n/a |  — static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 2 | all embedded images decode | n/a |  — static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 3 | index enters knowledge-first workspace | n/a |  — static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 4 | index cannot recommend before source confirmation | n/a |  — static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 5 | index starts with empty enterprise knowledge and roles | n/a |  — static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 6 | no browser errors | e2e | apps/e2e/tests/fixtures.ts (every test fails on page/console errors) |

## qa-outcomes

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | Primary navigation changed | e2e | apps/e2e/tests/shell.spec.ts |
| 2 | Empty summary invents work | pending | T-41 |
| 3 | Greeting forced business form/task | pending | T-41 |
| 4 | Async employee report replaced composer | pending | T-41 |
| 5 | Draft incorrectly marked human-accepted | pending | T-41 |
| 6 | Draft boundary missing | pending | T-41 |
| 7 | Execution identity untraceable | pending | T-41 |
| 8 | Raw implementation JSON in result | pending | T-41 |
| 9 | Verified result cannot be reviewed | pending | T-41 |
| 10 | Malformed evidence passed | pending | T-41 |
| 11 | Failed evidence can be accepted | pending | T-41 |
| 12 | Human result acceptance missing | pending | T-41 |
| 13 | Missing information fake-executed | pending | T-41 |
| 14 | Empty supplement accepted | pending | T-41 |
| 15 | Supplement restarted/replaced task | pending | T-41 |
| 16 | Revoked tool still usable | unit | apps/server/test/tools.test.ts — UI E2E: T-42 / T-41 (execution path) |
| 17 | Blocker has no responsible person | pending | T-41 |
| 18 | Authorized original task failed to resume | pending | T-41 |
| 19 | Tool gap missing | unit | apps/server/test/tools.test.ts — UI E2E: T-42 / T-41 (execution path) |
| 20 | Unreleased tool treated as reusable | unit | apps/server/test/tools.test.ts — UI E2E: T-42 / T-41 (execution path) |
| 21 | Independent verification record absent | unit | apps/server/test/tools.test.ts — UI E2E: T-42 / T-41 (execution path) |
| 22 | Release bypasses review | unit | apps/server/test/tools.test.ts — UI E2E: T-42 / T-41 (execution path) |
| 23 | Capability delivery lost original task or did not resume | pending | T-41 |
| 24 | Executing version differs from approved version | unit | apps/server/test/tools.test.ts — UI E2E: T-42 / T-41 (execution path) |
| 25 | Tool release leaked to other employee | unit | apps/server/test/tools.test.ts — UI E2E: T-42 / T-41 (execution path) |
| 26 | Summary leaks other owner | pending | T-41 |
| 27 | Employee navigation expanded | pending | T-41 — employee navigation (simulated view) ships with the command room |
| 28 | Write rehearsal auto-approved | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 29 | Approval does not bind parameters | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 30 | Timeout marked complete/retried | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 31 | Unknown write can be accepted | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 32 | Unknown readback retried write | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 33 | Mismatched write accepted or repeated | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 34 | Mismatched result review enabled | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 35 | Corrected external data could not be reread without a second write | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 36 | Matching readback did not verify original request | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 37 | Changed contract retains old action approval/acceptance | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 38 | Contract revision repeats write | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 39 | Offline rehearsal discarded original task | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 40 | Manual reconnect failed to resume original task | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 41 | Existing client incorrectly promises remote start | n/a |  — prototype copy about the desktop client; no such client in the product |
| 42 | Manual pause bypassed during readback | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 43 | Paused readback repeated/finished external write | pending | T-45 — long-running items, approvals bound to parameters, read-back (with T-41) |
| 44 | Async report erased SOP input | pending | T-41 |
| 45 | Async report replaced or lost workflow draft | pending | T-41 |
| 46 | Unvalidated draft can be published | e2e | apps/e2e/tests/superagent.spec.ts (runtime contract test double until T-41 merges) |
| 47 | Baseline validation missing regression cases | e2e | apps/e2e/tests/sop-validation-packs.spec.ts (runtime contract test double until T-41 merges) |
| 48 | Valid draft cannot publish | e2e | apps/e2e/tests/superagent.spec.ts (runtime contract test double until T-41 merges) |
| 49 | Validated confirmed draft not published | e2e | apps/e2e/tests/superagent.spec.ts (runtime contract test double until T-41 merges) |
| 50 | Stale validation published | e2e | apps/e2e/tests/superagent.spec.ts (runtime contract test double until T-41 merges) |
| 51 | Stale validation not explained | e2e | apps/e2e/tests/sop-validation-packs.spec.ts (runtime contract test double until T-41 merges) |
| 52 | Revalidated revision not published | e2e | apps/e2e/tests/sop-validation-packs.spec.ts (runtime contract test double until T-41 merges) |
| 53 | Publishing rewrote old instance | e2e | apps/e2e/tests/superagent.spec.ts (runtime contract test double until T-41 merges) |
| 54 | Pack replaced draft without explicit confirmation | e2e | apps/e2e/tests/sop-validation-packs.spec.ts (runtime contract test double until T-41 merges) |
| 55 | Pack auto-confirmed rule/trigger | e2e | apps/e2e/tests/sop-validation-packs.spec.ts (runtime contract test double until T-41 merges) |
| 56 | Pack modified published workflow | e2e | apps/e2e/tests/sop-validation-packs.spec.ts (runtime contract test double until T-41 merges) |
| 57 | Unconfirmed package can publish | e2e | apps/e2e/tests/sop-validation-packs.spec.ts (runtime contract test double until T-41 merges) |
| 58 | Confirmed package cannot validate | e2e | apps/e2e/tests/sop-validation-packs.spec.ts (runtime contract test double until T-41 merges) |
| 59 | Knowledge change has no impact/context | e2e | apps/e2e/tests/sop-validation-packs.spec.ts (runtime contract test double until T-41 merges) |
| 60 | Summary not linked to room | pending | T-41 |
| 61 | File origin outcome interactions broken | n/a |  — prototype opened from file://; product is served over HTTPS |

## qa-database-knowledge

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | Documents and databases share enterprise knowledge entry | pending | T-40 |
| 2 | Data source requires explicit read-only policy acknowledgement | pending | T-40 |
| 3 | Connection string cannot be pasted into credential reference | pending | T-40 — server-side refusal exists (only SELECT templates); UI form validation pending |
| 4 | Database source can start without any uploaded file | pending | T-40 |
| 5 | Unconfirmed database cannot feed recommendations | pending | T-40 |
| 6 | Confirming source forms logical enterprise knowledge space | pending | T-40 |
| 7 | Knowledge space can be named without copying database | pending | T-40 |
| 8 | Confirmed metadata can support role candidates | pending | T-40 |
| 9 | Database evidence names tables/columns and schema version | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) — UI E2E: T-40 data-source UI |
| 10 | Schema does not become a published SOP | pending | T-40 |
| 11 | Database metadata recommends read-only query placeholder without inventing mail workflow | pending | T-40 |
| 12 | No current values invented from schema | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) — UI E2E: T-40 data-source UI |
| 13 | Out-of-scope project is refused | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) — UI E2E: T-40 data-source UI |
| 14 | Per-source row limit cannot be exceeded | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) — UI E2E: T-40 data-source UI |
| 15 | Query obeys requested and approved row count | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) — UI E2E: T-40 data-source UI |
| 16 | Projection excludes unapproved column | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) — UI E2E: T-40 data-source UI |
| 17 | Sensitive sample value is masked and other project absent | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) — UI E2E: T-40 data-source UI |
| 18 | Facts include source, time and synthetic status | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) — UI E2E: T-40 data-source UI |
| 19 | Live values and untrusted row text do not enter metadata knowledge | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) — UI E2E: T-40 data-source UI |
| 20 | Row update expires fact result without changing metadata analysis | pending | T-40 |
| 21 | Next query reads new synthetic value | pending | T-40 |
| 22 | Data change does not silently rewrite schema rules or team | pending | T-40 |
| 23 | Timeout does not relabel cached result as fresh | unit | apps/server/test/knowledge.test.ts (read-only DB gateway) — UI E2E: T-40 data-source UI |
| 24 | Reads and denials leave audit metadata | pending | T-40 |
| 25 | Unavailable source cannot be queried | pending | T-40 |
| 26 | Parameterized Lot lookup stays inside approved project | pending | T-40 |
| 27 | Database column names do not split words | pending | T-40 — table rendering of facts in the knowledge UI |
| 28 | Last fact column is reachable through local horizontal scroll | pending | T-40 — table rendering of facts in the knowledge UI |
| 29 | Read-only database generation is fifth acquisition route | unit | apps/server/test/tools.test.ts — UI E2E: T-42 db_query route + T-40 |
| 30 | Database capability cannot be changed to write in UI | pending | T-40 — server-side refusal exists (only SELECT templates); UI form validation pending |
| 31 | Saving write effect is refused even if DOM is manipulated | pending | T-40 — server-side refusal exists (only SELECT templates); UI form validation pending |
| 32 | Generation produces controlled template candidate | unit | apps/server/test/tools.test.ts — UI E2E: T-42 db_query route + T-40 |
| 33 | Personal project options stay inside source permission | pending | T-40 |
| 34 | Forged personal scope cannot expand source permission | pending | T-40 |
| 35 | Schema change withdraws source confirmation and invalidates old analysis | pending | T-40 |
| 36 | Metadata reanalysis preserves human role edits | pending | T-40 |
| 37 | Reanalysis keeps stable query-tool identity | unit | apps/server/test/tools.test.ts — UI E2E: T-42 db_query route + T-40 |
| 38 | No browser errors or real SQL execution | e2e | apps/e2e/tests/fixtures.ts (every test fails on page/console errors) |

## qa-database-guide

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | one title | n/a |  — static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 2 | four real screenshots embedded | n/a |  — static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 3 | primary entry includes database source | n/a |  — static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 4 | primary empty source gate retained | n/a |  — static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 5 | no errors | e2e | apps/e2e/tests/fixtures.ts (every test fails on page/console errors) |

## qa-source-plugins

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | Four knowledge-source manifests visible | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 2 | Local single-import built in, remote plugin not installed | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 3 | Catalog install has no implied connection or source | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 4 | Local file text actually read | unit | apps/server/test/knowledge.test.ts — UI E2E: T-40 upload UI |
| 5 | Local upload has plugin connection item provenance | unit | apps/server/test/knowledge.test.ts — UI E2E: T-40 upload UI |
| 6 | Import does not imply source confirmation | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 7 | Mail plugin installation creates no connection or source | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 8 | Knowledge install never requests Mail.Send | unit | apps/server/test/knowledge-m365.test.ts — UI E2E: T-40 connection UI |
| 9 | Connection requires explicit read-only scope | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 10 | Invalid mail date scope rejected | unit | apps/server/test/knowledge-m365.test.ts — UI E2E: T-40 connection UI |
| 11 | Preview shows mailbox folder and date scope | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 12 | Unknown ACL and out-of-scope entries blocked | unit | apps/server/test/knowledge.test.ts / apps/server/test/knowledge-m365.test.ts — UI E2E: T-40 knowledge UI |
| 13 | Unknown ACL does not display body | unit | apps/server/test/knowledge.test.ts / apps/server/test/knowledge-m365.test.ts — UI E2E: T-40 knowledge UI |
| 14 | Forged preview selection cannot bypass ACL | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 15 | Body and attachment imported with separate stable item ids | unit | apps/server/test/knowledge-m365.test.ts — UI E2E: T-40 connection UI |
| 16 | Imported mail independently awaits confirmation with references and versions | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 17 | Confirmed mixed knowledge creates evidence-based candidates | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 18 | Mail recommendation evidence preserves original locator | unit | apps/server/test/knowledge-m365.test.ts — UI E2E: T-40 connection UI |
| 19 | Delta update increments source version and invalidates analysis | unit | apps/server/test/knowledge.test.ts / apps/server/test/knowledge-m365.test.ts — UI E2E: T-40 knowledge UI |
| 20 | Delta does not overwrite human role edit | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 21 | Reanalysis preserves human edits | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 22 | Failed sync keeps cursor and blocks cached source use | unit | apps/server/test/knowledge.test.ts / apps/server/test/knowledge-m365.test.ts — UI E2E: T-40 knowledge UI |
| 23 | Recovery requires source confirmation again | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 24 | Revocation clears cached text and prevents reference | unit | apps/server/test/knowledge.test.ts / apps/server/test/knowledge-m365.test.ts — UI E2E: T-40 knowledge UI |
| 25 | Forged source confirmation cannot override revoked ACL | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 26 | SharePoint preview preserves site library folder scope | unit | apps/server/test/knowledge-m365.test.ts — UI E2E: T-40 connection UI |
| 27 | Source deletion retains tombstone but removes cached text | unit | apps/server/test/knowledge.test.ts / apps/server/test/knowledge-m365.test.ts — UI E2E: T-40 knowledge UI |
| 28 | Paused knowledge plugin blocks its source references | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 29 | Database plugin leads to existing scoped read-only configuration | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 30 | Installing knowledge plugins did not install employee business tools | pending | T-40 — plugin catalogue / connection / confirmation UI and analysis |
| 31 | No browser errors | e2e | apps/e2e/tests/fixtures.ts (every test fails on page/console errors) |

## qa-room-header

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | Desktop heading and subtitle vertically centered in same row | e2e | apps/e2e/tests/shell.spec.ts |
| 2 | Employee header uses same single row | pending | T-41 — employee view of the room header is built with the command room |
| 3 | Employee subtitle retained | pending | T-41 — employee view of the room header is built with the command room |
| 4 | No browser errors | e2e | apps/e2e/tests/fixtures.ts (every test fails on page/console errors) |

## qa-source-guide

| # | Assertion | Status | Where / owner |
|---|---|---|---|
| 1 | Five embedded real screenshots | n/a |  — static proposal/guide page of the prototype package (screenshots, titles); not a product feature |
| 2 | No browser errors | e2e | apps/e2e/tests/fixtures.ts (every test fails on page/console errors) |
