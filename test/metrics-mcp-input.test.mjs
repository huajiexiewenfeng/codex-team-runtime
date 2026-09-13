import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readMcpObservationManifest } from '../src/metrics-mcp-input.mjs';

const roots = [];
afterEach(async () => { while (roots.length) await rm(roots.pop(), { recursive: true, force: true }); });
const descriptor = files => ({ registryId: 'registry-demo', teamId: 'demo-team', sourceKind: 'fixture', files });
const event = () => ({ schemaVersion: 1, eventId: '00000000-0000-4000-8000-000000000001', startedAt: '2026-09-12T00:00:00.000Z', completedAt: '2026-09-12T00:00:00.001Z', durationMs: 1, tool: 'team_context.read', registryId: 'registry-demo', teamId: 'demo-team', memberId: 'm', role: 'Manager', hostId: 'h', threadId: 't', memberStatus: 'active', identitySource: 'registry-at-call-start', reason: 'manual', reasonSource: 'agent-declared', outcome: 'matched', errorCode: null, policyRevision: 2, runtimeRevision: null, runtimeRevisionSource: 'unknown' });
async function root() { const value = await mkdtemp(join(tmpdir(), 'mcp-input-')); roots.push(value); return value; }

test('reads only explicit relative regular files, preserves duplicate paths and allows empty lists', async () => {
  const base = await root(); await mkdir(join(base, 'observations')); await writeFile(join(base, 'observations', 'one.json'), JSON.stringify(event())); await writeFile(join(base, 'ignored.json'), '{bad');
  const value = await readMcpObservationManifest(descriptor(['observations/one.json', 'observations/one.json']), base);
  assert.equal(value.records.length, 2); assert.deepEqual(value.records.map(row => row.sourceRefs), [[resolve(base, 'observations/one.json')], [resolve(base, 'observations/one.json')]]);
  assert.deepEqual(await readMcpObservationManifest(descriptor([]), base), { registryId: 'registry-demo', teamId: 'demo-team', sourceKind: 'fixture', records: [] });
});

test('rejects invalid descriptors, directories, invalid UTF-8/JSON, oversized files and too many entries', async () => {
  const base = await root(); await mkdir(join(base, 'directory'));
  for (const value of [null, {}, { ...descriptor([]), extra: true }, { ...descriptor([]), sourceKind: 'manual' }, { ...descriptor([]), registryId: 'bad id' }, { ...descriptor([]), files: 'x' }]) {
    await assert.rejects(readMcpObservationManifest(value, base));
  }
  await assert.rejects(readMcpObservationManifest(descriptor(['directory']), base), /regular file/i);
  await writeFile(join(base, 'bad-utf8.json'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(readMcpObservationManifest(descriptor(['bad-utf8.json']), base), /UTF-8/i);
  await writeFile(join(base, 'bad.json'), '{');
  await assert.rejects(readMcpObservationManifest(descriptor(['bad.json']), base), /JSON/i);
  await writeFile(join(base, 'large.json'), 'x'.repeat(65537));
  await assert.rejects(readMcpObservationManifest(descriptor(['large.json']), base), /65536|size/i);
  await assert.rejects(readMcpObservationManifest(descriptor(Array(10001).fill('missing')), base), /10000/);
});
