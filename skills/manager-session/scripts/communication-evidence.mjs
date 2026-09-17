import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_OUTPUT_BYTES = 6144;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const histories = new Set(['not-attempted', 'delivered', 'denied', 'unknown']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.trim().length > 0;
const endpoint = value => object(value) && string(value.hostId) && string(value.threadId);
const same = (a, b) => endpoint(a) && endpoint(b) && a.hostId === b.hostId && a.threadId === b.threadId;
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key] ?? null]));

// Pure projection of supplied observations; no authentication, grant or host calls.
export function formatEvidence(input) {
  const issues = [];
  const add = issue => { if (!issues.includes(issue)) issues.push(issue); };
  const value = object(input) ? input : {};
  const caller = pick(value.caller, ['hostId', 'threadId']);
  const recipient = pick(value.recipient, ['hostId', 'threadId']);
  if (!endpoint(caller)) add('caller-missing');
  if (!endpoint(recipient)) add('recipient-missing');
  const context = value.context;
  let relationship = null;
  if (!object(context)) add(context === null ? 'context-unregistered' : 'context-missing');
  else {
    const member = context.member;
    const leader = context.leader;
    if (!same(member?.binding, caller)) add('context-caller-conflict');
    let target = null;
    if (member?.role === 'Manager') {
      if (!same(leader, caller) || leader.memberId !== member.memberId) add('leader-conflict');
      const roster = Array.isArray(context.teamMembers) ? context.teamMembers : [];
      const matches = roster.filter(item => same(item, recipient));
      if (matches.length === 0) add('recipient-missing');
      else if (matches.length !== 1 || roster.filter(item => item?.memberId === matches[0].memberId).length !== 1) add('recipient-ambiguous');
      else target = matches[0];
    } else if (same(leader, recipient)) target = {...leader, role:'Manager'};
    else add('recipient-missing');
    if (target && target.lifecycle !== 'active') add('recipient-inactive');
    if (member?.lifecycle !== 'active' || context.status !== 'active') add('caller-inactive');
    relationship = {
      registryId:context.registryId ?? null,
      policyRevision:context.policyRevision ?? null,
      team:pick(context.team, ['id','revision']),
      identityAssurance:context.identityAssurance ?? null,
      dispatchAllowed:context.dispatchAllowed ?? null,
      executionIntegration:context.executionIntegration ?? null,
      caller:{...pick(member,['memberId','role','lifecycle']), onboardingStatus:context.onboarding?.status ?? null},
      recipient:target ? pick(target,['memberId','role','lifecycle','onboardingStatus']) : null,
      leader:pick(leader,['memberId','hostId','threadId','lifecycle']),
    };
    if (!string(context.registryId) || !string(context.team?.id) || !Number.isSafeInteger(context.team?.revision)) add('relationship-incomplete');
    if (context.identityAssurance !== 'caller-declared' || context.dispatchAllowed !== false) add('unexpected-assurance-or-dispatch');
  }
  if (!string(value.contextRef)) add('context-reference-missing');
  const native = {};
  for (const key of ['caller','recipient']) {
    native[key] = pick(value.native?.[key],['hostId','threadId','ref','observedAt']);
    if (!same(native[key], value[key])) add(`native-${key}-conflict`);
    if (!string(native[key].ref) || !string(native[key].observedAt)) add(`native-${key}-evidence-missing`);
  }
  const authorization = pick(value.authorization,['sourceRef','scope','dataCategories']);
  if (Object.values(authorization).some(item => !string(item))) add('authorization-missing');
  const history = pick(value.history,['status','scope','ref']);
  if (!histories.has(history.status) || !string(history.scope) || !string(history.ref)) add('history-missing-or-invalid');
  const result = {
    schemaVersion:1, status:issues.length ? 'incomplete-or-conflicting' : 'formatted',
    grantsPermission:false, evidenceAssurance:'supplied-observations-not-authenticated',
    caller, recipient, contextRef:value.contextRef ?? null, relationship,
    native, authorization, history, issues,
  };
  const textFields = [...Object.values(caller), ...Object.values(recipient), result.contextRef,
    ...Object.values(native.caller), ...Object.values(native.recipient),
    ...Object.values(authorization), ...Object.values(history)];
  if (relationship) textFields.push(relationship.registryId,
    relationship.team.id, relationship.identityAssurance, relationship.executionIntegration,
    ...Object.values(relationship.caller), ...Object.values(relationship.leader),
    ...Object.values(relationship.recipient ?? {}));
  if (textFields.some(item => item !== null && typeof item !== 'string') ||
      (relationship?.dispatchAllowed !== null && relationship && typeof relationship.dispatchAllowed !== 'boolean') ||
      (relationship && (!Number.isSafeInteger(relationship.team.revision) ||
        !Number.isSafeInteger(relationship.policyRevision)))) return {
    schemaVersion:1, status:'invalid-input', grantsPermission:false, detailsOmitted:true,
    historyStatus:histories.has(history.status) ? history.status : 'unknown',
    issues:['essential-field-type-invalid'],
  };
  // Reject essential oversize data, never silently shorten IDs, grants or restrictions.
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output,'utf8') > MAX_OUTPUT_BYTES) return {
    schemaVersion:1, status:'too-large', grantsPermission:false, detailsOmitted:true,
    historyStatus:histories.has(history.status) ? history.status : 'unknown',
    issues:['essential-evidence-exceeds-6144-bytes'],
  };
  return result;
}

export async function run(args, output = console.log) {
  let result;
  if (args.length !== 2 || args[0] !== '--input' || !args[1]) {
    result = {status:'invalid-input', grantsPermission:false, issues:['usage: communication-evidence.mjs --input <json-file>']};
  } else {
    let handle;
    try {
      handle = await open(resolve(args[1]), 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('input-size');
      const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > MAX_INPUT_BYTES) throw new Error('input-size');
      result = formatEvidence(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length))));
    } catch {
      result = {status:'invalid-input', grantsPermission:false, issues:['unreadable-invalid-or-oversized-input'], detailsOmitted:true};
    } finally { await handle?.close(); }
  }
  output(JSON.stringify(result));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then(result => { if (result.status !== 'formatted') process.exitCode = 1; });
}
