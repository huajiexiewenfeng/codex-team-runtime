// @exec: {"yield_time_ms": 1000, "max_output_tokens": 16000}
// Paste into one functions.exec. Fill only independently verified current identity and reason.
const request = {host_id: '', thread_id: '', reason: 'unknown'};

async function recallManager(request) {
  const unknown = signal => ({status: 'unknown', recovered: false, signal});
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const id = v => typeof v === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(v)
    && !/^(client-|replace)/i.test(v);
  const str = v => typeof v === 'string' && v.trim().length > 0;
  const rev = v => Number.isSafeInteger(v) && v > 0;
  const rules = v => Array.isArray(v) && v.length > 0 && v.every(str);
  const reasons = ['post_compaction', 'onboarding', 'resume', 'before_dispatch',
    'before_delivery', 'before_review', 'identity_conflict', 'manual', 'unknown'];
  if (!object(request) || Object.keys(request).length !== 3 || !id(request.host_id)
      || !id(request.thread_id) || !reasons.includes(request.reason)) return unknown('invalid_input');

  let result;
  try {
    result = await tools.mcp__team_context__team_context_read(request);
  } catch {
    return unknown('read_error');
  }
  if (!object(result) || (result.isError !== undefined && result.isError !== false))
    return unknown('read_error');

  try {
    let capsule = result.structuredContent;
    if (capsule === undefined) {
      const content = result.content;
      if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text'
          || !str(content[0].text)) return unknown('invalid_envelope');
      if (content[0].text.length > 1_000_000) return unknown('over_budget');
      capsule = JSON.parse(content[0].text);
    }
    if (capsule === null) return unknown('unregistered');
    if (!object(capsule)) return unknown('invalid_capsule');
    if (capsule.status === 'inactive') return unknown('inactive');
    const {status, registryId, registrySchemaVersion, policyRevision, team, member, leader,
      onboarding, executionIntegration, identityAssurance, dispatchAllowed, runtime,
      sharedRules, roleDuties, managerGuidance} = capsule;
    if (status !== 'active' || !object(member) || !str(member.role))
      return unknown('invalid_capsule');
    if (member.role !== 'Manager') return unknown('wrong_role');
    const {binding} = member;
    if (!object(binding) || !id(binding.hostId) || !id(binding.threadId))
      return unknown('invalid_capsule');
    if (binding.hostId !== request.host_id || binding.threadId !== request.thread_id)
      return unknown('identity_mismatch');
    if (!id(registryId) || ![2, 3].includes(registrySchemaVersion) || !rev(policyRevision)
        || !object(team) || !id(team.id) || !str(team.name) || !rev(team.revision)
        || !id(member.memberId) || !str(member.name) || member.lifecycle !== 'active' || !rev(binding.revision)
        || !object(leader) || !id(leader.memberId) || !str(leader.name) || !id(leader.hostId)
        || !id(leader.threadId) || !rev(leader.bindingRevision)
        || !['active', 'exited'].includes(leader.lifecycle)
        || !object(onboarding) || !['ready', 'pending'].includes(onboarding.status)
        || identityAssurance !== 'caller-declared' || dispatchAllowed !== false
        || !rules(sharedRules) || !rules(roleDuties) || !object(managerGuidance)
        || !rev(managerGuidance.revision) || !str(managerGuidance.scope) || !rules(managerGuidance.steps))
      return unknown('invalid_capsule');
    if (leader.memberId !== member.memberId || leader.hostId !== binding.hostId
        || leader.threadId !== binding.threadId || leader.bindingRevision !== binding.revision
        || leader.lifecycle !== member.lifecycle) return unknown('leader_mismatch');
    const projected = {status, recovered: true, registryId, registrySchemaVersion, policyRevision,
      team: {id: team.id, name: team.name, revision: team.revision},
      member: {memberId: member.memberId, name: member.name, role: member.role, lifecycle: member.lifecycle,
        binding: {hostId: binding.hostId, threadId: binding.threadId, revision: binding.revision}},
      leader: {memberId: leader.memberId, name: leader.name, hostId: leader.hostId,
        threadId: leader.threadId, bindingRevision: leader.bindingRevision, lifecycle: leader.lifecycle},
      onboarding: {status: onboarding.status}, executionIntegration, identityAssurance, dispatchAllowed,
      sharedRules, roleDuties,
      managerGuidance: {revision: managerGuidance.revision, scope: managerGuidance.scope, steps: managerGuidance.steps}};
    if (executionIntegration === 'not-connected') {
      if (runtime !== undefined) return unknown('invalid_capsule');
    } else {
      const phase = executionIntegration === 'connected' ? 'active'
        : executionIntegration === 'migration-pending' ? 'prepared' : null;
      if (!phase || !object(runtime) || runtime.phase !== phase || runtime.teamRevision !== team.revision
          || !str(runtime.statePath) || !id(runtime.migrationId) || !str(runtime.runtimeRoot)
          || !str(runtime.pythonExecutable)) return unknown('invalid_capsule');
      projected.runtime = {statePath: runtime.statePath, migrationId: runtime.migrationId,
        phase: runtime.phase, teamRevision: runtime.teamRevision, runtimeRoot: runtime.runtimeRoot,
        pythonExecutable: runtime.pythonExecutable};
    }
    // Conservative ASCII-escaped size; keep full rules or return bounded unknown.
    if (JSON.stringify(projected).replace(/[^\x00-\x7f]/g, '______').length > 14_000)
      return unknown('over_budget');
    return projected;
  } catch {
    return unknown('invalid_capsule');
  }
}

text(JSON.stringify(await recallManager(request)));
