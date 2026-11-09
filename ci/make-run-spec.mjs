// Builds a base64 RUN_SPEC for the sandbox container smoke run (CI only).
import { createHash } from 'node:crypto';
const base = process.argv[2] ?? 'http://127.0.0.1:8099/fixture.html';
const artifact = JSON.stringify({
  toolId: 'ci.enter-amount', effect: 'write', params: ['amount'],
  steps: [
    { op: 'goto', url: base },
    { op: 'fill', selector: '#amount', param: 'amount' },
    { op: 'submit', selector: '#save' },
    { op: 'assertText', selector: '#saved', equalsParam: 'amount' },
    { op: 'extract', selector: '#saved', as: 'saved' },
  ],
});
const spec = { runId: 'ci-run', artifact, releasedDigest: 'sha256:' + createHash('sha256').update(artifact).digest('hex'), inputs: { amount: '480.00' }, egressAllowlist: ['127.0.0.1'] };
process.stdout.write(Buffer.from(JSON.stringify(spec)).toString('base64'));
