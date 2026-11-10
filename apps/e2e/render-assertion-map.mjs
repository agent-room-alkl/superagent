// Writes docs/e2e/ASSERTION-MAP.md from apps/e2e/assertion-map.json, so the table people read cannot drift from
// the file CI checks. Run after editing the JSON:  node apps/e2e/render-assertion-map.mjs
// With --check it writes nothing and exits 1 when the Markdown is out of date.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = path.join(root, 'docs/e2e/ASSERTION-MAP.md');
const { rows } = JSON.parse(fs.readFileSync(path.join(root, 'apps/e2e/assertion-map.json'), 'utf8'));

const count = (status) => rows.filter((row) => row.status === status).length;
const pendingBy = new Map();
for (const row of rows) if (row.status === 'pending') pendingBy.set(row.owner, (pendingBy.get(row.owner) ?? 0) + 1);

/** The last column: where the proof is, or who still owes it. */
function where(row) {
  if (row.status === 'n/a') return row.reason;
  if (row.status === 'pending') return row.note ? `${row.owner} — ${row.note}` : row.owner;
  return row.note ? `${row.ref} — ${row.note}` : row.ref;
}

const out = [
  '# Prototype assertion → E2E mapping (T-47)',
  '',
  'Generated from the v9–v12 prototype QA scripts: every `ok(…, message)` site, counted once even when the prototype ran it in a loop. Person and tenant names from the prototype fixtures are replaced with neutral labels.',
  '',
  '| Status | Meaning | Count |',
  '|---|---|---|',
  `| e2e | Covered by a Playwright test against the real app | ${count('e2e')} |`,
  `| unit | Behaviour covered by a server test; the UI-level E2E follows when the owning page ships | ${count('unit')} |`,
  `| pending | Feature not built yet; the owner task will add the E2E | ${count('pending')} |`,
  `| n/a | Prototype-only behaviour, with the reason given | ${count('n/a')} |`,
  `| **total** | | **${rows.length}** |`,
  '',
  `Pending by owner: ${[...pendingBy.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([owner, n]) => `${owner} ${n}`).join(', ')}`,
  '',
  'CI runs `apps/e2e/check-assertion-map.mjs`. It fails if a row has no valid status, if a `pending` row has no owner task, if an `n/a` row has no reason, or if an `e2e` reference points to a missing file. A `unit` reference to a test file still in an open PR is reported, not failed.',
  '',
];
const suites = [...new Set(rows.map((row) => row.suite))];
for (const suite of suites) {
  out.push(`## ${suite}`, '', '| # | Assertion | Status | Where / owner |', '|---|---|---|---|');
  for (const row of rows.filter((item) => item.suite === suite)) {
    out.push(`| ${row.id.split('#')[1]} | ${row.assertion} | ${row.status} | ${where(row)} |`);
  }
  out.push('');
}
const markdown = out.join('\n');

if (process.argv.includes('--check')) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== markdown) {
    console.error('docs/e2e/ASSERTION-MAP.md is out of date: run node apps/e2e/render-assertion-map.mjs');
    process.exit(1);
  }
  console.log('docs/e2e/ASSERTION-MAP.md matches apps/e2e/assertion-map.json');
} else {
  fs.writeFileSync(target, markdown);
  console.log(`wrote docs/e2e/ASSERTION-MAP.md (${rows.length} assertions)`);
}
