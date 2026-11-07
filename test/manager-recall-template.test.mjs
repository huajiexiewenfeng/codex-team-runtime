import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../skills/manager-session/scripts/functions-exec-manager-recall-template.js', import.meta.url), 'utf8');
const request = {host_id: 'local', thread_id: 'thread-example', reason: 'post_compaction'};
const binding = {hostId: 'local', threadId: 'thread-example', revision: 1};
const capsule = () => ({
  status: 'active', registryId: 'registry-example', registrySchemaVersion: 2, policyRevision: 2,
  team: {id: 'team-example', name: 'Example', revision: 3, body: 'private extra body'},
  member: {memberId: 'manager-example', name: 'Manager Example', role: 'Manager', lifecycle: 'active', binding},
  leader: {memberId: 'manager-example', name: 'Manager Example', hostId: 'local',
    threadId: 'thread-example', bindingRevision: 1, lifecycle: 'active'},
  onboarding: {status: 'ready', evidenceRef: 'private evidence'},
  executionIntegration: 'connected', identityAssurance: 'caller-declared', dispatchAllowed: false,
  runtime: {statePath: '/fixture/state.json', migrationId: 'migration-example', phase: 'active',
    teamRevision: 3, runtimeRoot: '/fixture/runtime', pythonExecutable: '/fixture/python'},
  sharedRules: ['Recall at foreground continuation.', 'Ready does not authorize dispatch.'],
  roleDuties: ['Assign work to a formal Worker.', 'Never spawn_agent or implement business code directly.'],
  onboardingReceipt: 'private receipt', teamMembers: [{body: 'private roster body'}],
  managerGuidance: {revision: 1, scope: 'Manager recall is not authorization.',
    steps: ['Project native status metadata.', 'Use the fixed wait template.'], body: 'private extra body'},
  body: 'private capsule body',
});
const envelope = v => ({content: [{type: 'text', text: JSON.stringify(v)}], isError: false});
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function evaluate(response, input = request, expectedCalls = [request]) {
  const calls = [], output = [], toolAccess = [];
  const tools = new Proxy({
    mcp__team_context__team_context_read: async args => {
      calls.push(args);
      if (response instanceof Error) throw response;
      return response;
    },
  }, {get: (target, key) => {
    toolAccess.push(key);
    assert.ok(Object.hasOwn(target, key), 'unexpected tool: ' + key);
    return target[key];
  }});
  const code = source.replace(/^const request = .*;$/m, 'const request = ' + JSON.stringify(input) + ';');
  await new AsyncFunction('tools', 'text', code)(tools, v => output.push(v));
  assert.deepEqual(calls, expectedCalls);
  assert.deepEqual(toolAccess, expectedCalls.map(() => 'mcp__team_context__team_context_read'));
  assert.equal(output.length, 1);
  assert.doesNotMatch(output[0], /private|hidden/);
  return JSON.parse(output[0]);
}

test('real template preserves the rule content lost by the old four-field display', async () => {
  const data = capsule();
  const old = JSON.stringify({team: data.team.id, role: data.member.role, status: data.status,
    statePath: data.runtime.statePath});
  assert.doesNotMatch(old, /sharedRules|roleDuties|managerGuidance|formal Worker|spawn_agent/);
  const result = await evaluate(envelope(data));
  assert.equal(result.recovered, true);
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.identityAssurance, 'caller-declared');
  assert.deepEqual(result.member, data.member);
  assert.deepEqual(result.leader, data.leader);
  assert.deepEqual(result.runtime, data.runtime);
  assert.deepEqual(result.onboarding, {status: 'ready'});
  assert.deepEqual(result.sharedRules, data.sharedRules);
  assert.deepEqual(result.roleDuties, data.roleDuties);
  const {body, ...guidance} = data.managerGuidance;
  assert.deepEqual(result.managerGuidance, guidance);
  assert.ok(!Object.hasOwn(result, 'teamMembers'));
  assert.ok(!Object.hasOwn(result, 'onboardingReceipt'));
});

test('structured content uses the same schema; integration barriers remain explicit', async () => {
  const data = capsule();
  assert.deepEqual(await evaluate({structuredContent: data}), await evaluate(envelope(data)));
  const {runtime, ...unlinked} = data;
  const disconnected = await evaluate(envelope({...unlinked, executionIntegration: 'not-connected'}));
  assert.equal(disconnected.recovered, true);
  assert.equal(disconnected.executionIntegration, 'not-connected');
  assert.ok(!Object.hasOwn(disconnected, 'runtime'));
  const pending = await evaluate(envelope({...data, executionIntegration: 'migration-pending',
    runtime: {...runtime, phase: 'prepared'}}));
  assert.equal(pending.executionIntegration, 'migration-pending');
  assert.equal(pending.dispatchAllowed, false);
});

test('unknown outcomes are bounded and never carry response bodies or partial authority', async () => {
  const data = capsule();
  for (const [response, signal] of [
    [envelope(null), 'unregistered'],
    [{structuredContent: null}, 'unregistered'],
    [envelope({...data, status: 'inactive'}), 'inactive'],
    [envelope({...data, member: {...data.member, role: 'Worker'}}), 'wrong_role'],
    [envelope({...data, member: {...data.member, role: 'Liaison'}}), 'wrong_role'],
    [envelope({...data, member: {...data.member, binding: {...binding, threadId: 'different'}}}), 'identity_mismatch'],
    [envelope({...data, member: {...data.member, binding: {...binding, hostId: 'remote'}}}), 'identity_mismatch'],
    [{...envelope(data), isError: true}, 'read_error'],
    [new Error('hidden exception'), 'read_error'],
    [null, 'read_error'],
    [{content: [{type: 'image', text: 'hidden'}]}, 'invalid_envelope'],
    [{content: [{type: 'text', text: 'hidden invalid JSON'}]}, 'invalid_capsule'],
    [envelope({...data, dispatchAllowed: true}), 'invalid_capsule'],
    [envelope({...data, sharedRules: ['rule', null]}), 'invalid_capsule'],
    [envelope({...data, roleDuties: []}), 'invalid_capsule'],
    [envelope({...data, managerGuidance: {...data.managerGuidance, steps: undefined}}), 'invalid_capsule'],
    [envelope({...data, roleDuties: ['界'.repeat(2500)]}), 'over_budget'],
    [envelope({...data, body: 'x'.repeat(1_000_000)}), 'over_budget'],
  ]) assert.deepEqual(await evaluate(response), {status: 'unknown', recovered: false, signal});
  for (const field of ['registryId', 'registrySchemaVersion', 'policyRevision', 'team', 'member',
    'leader', 'onboarding', 'executionIntegration', 'identityAssurance', 'dispatchAllowed', 'runtime',
    'sharedRules', 'roleDuties', 'managerGuidance']) {
    const incomplete = {...data};
    delete incomplete[field];
    assert.deepEqual(await evaluate(envelope(incomplete)),
      {status: 'unknown', recovered: false, signal: 'invalid_capsule'}, field);
  }
});

test('invalid current identity or reason never calls a tool', async () => {
  for (const input of [null, {}, {...request, thread_id: 'client-pending'},
    {...request, host_id: 'REPLACE'}, {...request, thread_id: 'x'.repeat(129)},
    {...request, reason: 'guess'}, {...request, parent_id: 'other'}]) {
    assert.deepEqual(await evaluate(envelope(capsule()), input, []),
      {status: 'unknown', recovered: false, signal: 'invalid_input'});
  }
});

test('an active Manager must be the same active leader in the Registry capsule', async () => {
  const data = capsule();
  for (const change of [{memberId: 'different'}, {hostId: 'different'}, {threadId: 'different'},
    {bindingRevision: 2}, {lifecycle: 'exited'}]) {
    assert.deepEqual(await evaluate(envelope({...data, leader: {...data.leader, ...change}})),
      {status: 'unknown', recovered: false, signal: 'leader_mismatch'});
  }
  assert.equal((await evaluate(envelope(data))).recovered, true);
});
