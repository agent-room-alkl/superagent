// T-47 gate: every prototype assertion has a status; referenced files exist; nothing is unassigned.
// Unit references to test files that arrive with other open PRs (#6, #9, #12) are reported, not failed, until merged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { rows } = JSON.parse(fs.readFileSync(path.join(root, 'apps/e2e/assertion-map.json'), 'utf8'));
const errors = [];
const notYetMerged = new Set();
const files = (ref) => ref.split(' / ').map((r) => r.split(' (')[0].trim());
for (const r of rows) {
  if (!['e2e', 'unit', 'pending', 'n/a'].includes(r.status)) errors.push(`${r.id}: invalid status ${r.status}`);
  if (r.status === 'pending' && (!r.owner || r.owner === 'unassigned')) errors.push(`${r.id}: pending without an owner task`);
  if (r.status === 'n/a' && !r.reason) errors.push(`${r.id}: n/a without a reason`);
  if (r.status === 'e2e' || r.status === 'unit') {
    for (const f of files(r.ref)) {
      if (fs.existsSync(path.join(root, f))) continue;
      if (r.status === 'e2e') errors.push(`${r.id}: missing ${f}`);
      else notYetMerged.add(f);
    }
  }
}
const count = (s) => rows.filter((r) => r.status === s).length;
console.log(`assertions ${rows.length}: e2e ${count('e2e')}, unit ${count('unit')}, pending ${count('pending')}, n/a ${count('n/a')}`);
if (notYetMerged.size) console.log(`unit test files not on this branch yet (open PRs): ${[...notYetMerged].join(', ')}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
