import test from 'node:test';
import assert from 'node:assert/strict';

import * as api from '../src/reporting-heartbeat.mjs';
const operation = () => ({ teamId: 'team', operationId: 'prepare-1', kind: 'CREATE',
  owner: { memberId: 'liaison', hostId: 'local', threadId: 'test-liaison' },
  automationId: null, bindingEpoch: 1, intentVersion: 2, desired: 'running' });
const config = () => ({ hostId: 'local', name: 'Team progress', prompt: 'Read the trusted team state and report allowed progress.', intervalMinutes: 15 });
const build = (op = operation(), settings = config()) => {
  assert.equal(typeof api.buildReportingHeartbeatCreate, 'function', 'CREATE translation must exist');
  return api.buildReportingHeartbeatCreate(op, settings);
};
const observed = () => ({ id: 'heartbeat-1', kind: 'heartbeat', status: 'ACTIVE',
  target_thread_id: 'test-liaison', name: config().name, prompt: config().prompt,
  rrule: 'FREQ=MINUTELY;INTERVAL=15', created_at: 1, updated_at: 2 });
const evidence = () => ({ automationId: 'heartbeat-1', hostId: 'local',
  observedAt: '2026-09-07T12:00:00.000Z', source: { kind: 'host-observation', evidenceRef: 'test-only-config-read' } });
const inspect = (value = observed(), proof = evidence()) => {
  assert.equal(typeof api.inspectReportingHeartbeatConfiguration, 'function', 'Configuration inspection must exist');
  return api.inspectReportingHeartbeatConfiguration(build(), value, proof);
};

test('CREATE translates into a same-thread heartbeat without overriding the member model', () => {
  const op = operation(), settings = config(), before = JSON.stringify({ op, settings });
  const result = build(op, settings);
  assert.deepEqual(result.arguments, { mode: 'create', kind: 'heartbeat', destination: 'thread',
    name: settings.name, prompt: settings.prompt, rrule: 'FREQ=MINUTELY;INTERVAL=15',
    status: 'ACTIVE', targetThreadId: 'test-liaison' });
  assert.equal(result.hostActionExecuted, false);
  assert.equal(result.operationId, op.operationId);
  assert.equal(JSON.stringify({ op, settings }), before);
});

test('translation fails closed for unsupported updates and mismatched operation/host', () => {
  for (const patch of [{ kind: 'PAUSE' }, { kind: 'RESUME' }, { automationId: 'existing' },
    { desired: 'stopped' }, { owner: null }, { intentVersion: -1 }, { bindingEpoch: 0 }]) {
    assert.throws(() => build({ ...operation(), ...patch }));
  }
  assert.throws(() => build(operation(), { ...config(), hostId: 'another-host' }));
});

test('explicit notification settings are separate fields and no extra configuration is silently dropped', () => {
  for (const policy of [null, 'failed_runs_only']) {
    assert.equal(build(operation(), { ...config(), notificationPolicy: policy }).arguments.notificationPolicy, policy);
  }
  for (const patch of [{ intervalMinutes: 0 }, { intervalMinutes: 1.5 }, { name: ' ' },
    { prompt: '' }, { notificationPolicy: 'all' }, { model: 'gpt-6-astra' }, { targetThreadId: 'other' }]) {
    assert.throws(() => build(operation(), { ...config(), ...patch }));
  }
});

test('matching ACTIVE configuration does not assert execution, delivery or ledger confirmation', () => {
  const value = observed(), before = JSON.stringify(value), result = inspect(value);
  assert.equal(result.configurationMatches, true);
  assert.equal(result.configuredStatus, 'ACTIVE');
  assert.equal(result.executionStatus, 'unknown');
  assert.equal(result.delivery, 'unknown');
  assert.equal(result.hostActionExecuted, false);
  assert.equal(result.receipt, undefined);
  assert.equal(JSON.stringify(value), before);
});

test('configuration mismatches identify the wrong target, schedule, status and content', () => {
  for (const [key, value] of Object.entries({ target_thread_id: 'other', rrule: 'FREQ=HOURLY',
    kind: 'cron', status: 'PAUSED', name: 'other', prompt: 'other' })) {
    const result = inspect({ ...observed(), [key]: value });
    assert.equal(result.configurationMatches, false, key);
    assert.ok(result.mismatchedFields.includes(key), key);
    assert.equal(result.executionStatus, 'unknown');
  }
});

test('missing evidence and UI-only acknowledgements remain unknown', () => {
  for (const value of [null, {}, { content: [{ type: 'text', text: 'Created' }] }, { id: 'heartbeat-1' }]) {
    const result = inspect(value);
    assert.equal(result.configurationMatches, null);
    assert.equal(result.executionStatus, 'unknown');
    assert.ok(result.missingFields.length > 0);
  }
});

test('configuration evidence requires exact ID and host, timestamp and provenance', () => {
  for (const patch of [{ automationId: '' }, { hostId: 'other' }, { observedAt: 'invalid' },
    { source: { kind: 'guessed', evidenceRef: 'x' } }, { source: { kind: 'host-observation', evidenceRef: '' } }]) {
    assert.throws(() => inspect(observed(), { ...evidence(), ...patch }));
  }
  const result = inspect({ ...observed(), id: 'wrong-id' });
  assert.equal(result.configurationMatches, false);
  assert.ok(result.mismatchedFields.includes('id'));
});

test('fixture configuration matches remain fixture evidence, not authenticated host results', () => {
  const result = inspect(observed(), { ...evidence(), source: { kind: 'fixture', evidenceRef: 'fixture' } });
  assert.equal(result.configurationMatches, true);
  assert.equal(result.source.kind, 'fixture');
  assert.match(result.identityAssurance, /not authenticated/);
  assert.equal(result.executionStatus, 'unknown');
});

test('explicit notification policy requires separate host verification, not a guessed persisted field', () => {
  const request = build(operation(), { ...config(), notificationPolicy: null });
  const result = api.inspectReportingHeartbeatConfiguration(request, { ...observed(), notification_policy: null }, evidence());
  assert.equal(result.configurationMatches, null);
  assert.ok(result.missingFields.includes('notificationPolicy:host-mapping-unverified'));
});

test('pending client identities cannot become heartbeat targets', () => {
  for (const threadId of ['client-new-thread:pending', 'pending:liaison']) {
    assert.throws(() => build({ ...operation(), owner: { ...operation().owner, threadId } }), /Pending/);
  }
});

test('configuration observation rejects calendar overflow and noncanonical UTC timestamps', () => {
  for (const observedAt of ['2026-09-31T12:00:00.000Z', '2026-09-07T12:00:00Z', '2026-09-07T24:00:00.000Z']) {
    assert.throws(() => inspect(observed(), { ...evidence(), observedAt }), /canonical UTC/);
  }
});
