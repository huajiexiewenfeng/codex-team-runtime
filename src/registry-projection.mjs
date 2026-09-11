import { execFile } from 'node:child_process';
import { open, unlink } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { validate } from './runtime.mjs';

const executeFile = promisify(execFile);
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const exactObject = (value, fields, label) => {
 check(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
 check(Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)), `${label} fields mismatch`);
};
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);

export function validateRegistryLink(state, registry = state?.registry) {
 exactObject(registry, ['registryId','registryPath','teamId','migrationId','sourceSha256','sourceVersion','phase','teamRevision','readyMemberIds'], 'Registry link');
 for (const key of ['registryId','teamId','migrationId']) check(validId(registry[key]), `Invalid Registry ${key}`);
 check(typeof registry.registryPath === 'string' && isAbsolute(registry.registryPath), 'Registry path must be absolute');
 check(registry.teamId === state.team.id, 'Registry team mismatch');
 check(/^[0-9a-f]{64}$/.test(registry.sourceSha256), 'Invalid Registry source SHA-256');
 check(Number.isSafeInteger(registry.sourceVersion) && registry.sourceVersion >= 0, 'Invalid Registry source version');
 check(['prepared','active'].includes(registry.phase), 'Invalid Registry phase');
 check(Number.isSafeInteger(registry.teamRevision) && registry.teamRevision >= 0, 'Invalid Registry team revision');
 check(Array.isArray(registry.readyMemberIds) && registry.readyMemberIds.every(validId) && new Set(registry.readyMemberIds).size === registry.readyMemberIds.length, 'Invalid Registry readiness');
 if (registry.phase === 'prepared') {
  check(registry.teamRevision === 0, 'Prepared Registry revision must be zero');
  check(registry.readyMemberIds.length === 0, 'Prepared Registry readiness must be empty');
 } else {
  check(registry.teamRevision > 0, 'Active Registry revision must be positive');
  const ids = new Set(state.members.map(member => member.id));
  check(registry.readyMemberIds.every(id => ids.has(id)), 'Ready Registry member is missing');
 }
 return registry;
}

export function prepareRegistryState(state, registry) {
 validate(state);
 check(state.schemaVersion === 1, 'Only legacy schema-1 state can be prepared');
 const next = structuredClone(state);
 next.schemaVersion = 2;
 next.registry = structuredClone(registry);
 validateRegistryLink(next);
 check(next.registry.phase === 'prepared' && next.registry.teamRevision === 0 && next.registry.readyMemberIds.length === 0, 'Prepare requires a prepared Registry link');
 return validate(next);
}

function validateExportShape(value) {
 exactObject(value, ['registryId','teamId','teamRevision','migrationId','statePath','members','readyMemberIds'], 'Registry export');
 for (const key of ['registryId','teamId','migrationId']) check(validId(value[key]), `Invalid export ${key}`);
 check(Number.isSafeInteger(value.teamRevision) && value.teamRevision > 0, 'Registry export revision must be positive');
 check(typeof value.statePath === 'string' && isAbsolute(value.statePath), 'Registry export state path must be absolute');
 check(Array.isArray(value.members), 'Registry export members must be an array');
 check(Array.isArray(value.readyMemberIds) && value.readyMemberIds.every(validId) && new Set(value.readyMemberIds).size === value.readyMemberIds.length, 'Invalid export readiness');
}

export function applyRegistryProjection(state, value, statePath = undefined) {
 validate(state);
 check(state.schemaVersion === 2, 'Registry projection requires schema-2 state');
 validateRegistryLink(state);
 validateExportShape(value);
 check(resolve(state.registry.registryPath) !== resolve(value.statePath), 'Registry and projected state files must be separate');
 if (statePath !== undefined) {
  check(typeof statePath === 'string' && isAbsolute(statePath), 'State path must be absolute');
  check(resolve(value.statePath) === resolve(statePath), 'Registry export state path mismatch');
  check(resolve(state.registry.registryPath) !== resolve(statePath), 'Registry and state files must be separate');
 }
 check(value.registryId === state.registry.registryId, 'Registry export binding mismatch');
 check(value.teamId === state.team.id && value.teamId === state.registry.teamId, 'Registry export team mismatch');
 check(value.migrationId === state.registry.migrationId, 'Registry export migration mismatch');
 check(value.teamRevision >= state.registry.teamRevision, 'Stale Registry export revision');
 const exportedById = new Map(value.members.map(member => [member?.id, member]));
 check(exportedById.size === value.members.length, 'Duplicate Registry export member');
 for (const cached of state.members) {
  const current = exportedById.get(cached.id);
  check(current, `Registry member disappeared: ${cached.id}`);
  check(current.role === cached.role, `Registry member role changed: ${cached.id}`);
  check(isDeepStrictEqual(current.binding, cached.binding), `Registry member binding changed: ${cached.id}`);
  check(cached.lifecycle !== 'exited' || current.lifecycle === 'exited', `Registry member lifecycle revived: ${cached.id}`);
 }
 const next = structuredClone(state);
 next.members = structuredClone(value.members);
 next.registry.phase = 'active';
 next.registry.teamRevision = value.teamRevision;
 next.registry.readyMemberIds = structuredClone(value.readyMemberIds);
 validate(next);
 if (state.registry.phase === 'active' && value.teamRevision === state.registry.teamRevision) {
  check(isDeepStrictEqual(next.members, state.members) && isDeepStrictEqual(next.registry.readyMemberIds, state.registry.readyMemberIds), 'Registry revision content changed');
 }
 return next;
}

export async function exportRegistryProjection(state, statePath, options = {}) {
 validate(state);
 check(state.schemaVersion === 2 && state.registry.phase === 'active', 'Active linked state required');
 check(typeof statePath === 'string' && isAbsolute(statePath), 'State path must be absolute');
 const python = options.python ?? process.env.CODEX_TEAM_CONTEXT_PYTHON;
 check(typeof python === 'string' && python.trim().length > 0, 'CODEX_TEAM_CONTEXT_PYTHON is required');
 const argv = ['-I','-X','utf8','-m','codex_team_context.runtime_link','export','--registry',state.registry.registryPath,'--team',state.team.id];
 const runner = options.execFile ?? executeFile;
 let stdout;
 try {
  ({ stdout } = await runner(python, argv, { encoding:'utf8', windowsHide:true, timeout:10000, maxBuffer:4*1024*1024, shell:false }));
 } catch (error) {
  throw new Error(`Registry exporter failed: ${error.message}`, { cause:error });
 }
 let value;
 try { value = JSON.parse(stdout); }
 catch (error) { throw new Error(`Registry exporter returned invalid JSON: ${error.message}`, { cause:error }); }
 return applyRegistryProjection(state, value, statePath);
}

export async function projectRegistryState(state, statePath, options = {}) {
 validate(state);
 if (state.schemaVersion === 1) return state;
 check(state.registry.phase === 'active', 'Registry link is prepared; operational reads are fenced');
 if (options.exporter) return applyRegistryProjection(state, await options.exporter(state, statePath), statePath);
 return exportRegistryProjection(state, statePath, options);
}

export async function withFileLocks(lockPaths, operation) {
 const handles = [];
 try {
  for (const path of lockPaths) handles.push({ path, handle:await open(path,'wx') });
  return await operation();
 } finally {
  for (const entry of handles.reverse()) {
   await entry.handle.close();
   await unlink(entry.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
 }
}

export async function withStateGuard(statePath, reportingPath, readRawState, operation, options = {}) {
 const observed = await readRawState(statePath);
 const locks = [];
 if (observed.schemaVersion === 2) locks.push(`${observed.registry.registryPath}.lock`);
 locks.push(`${statePath}.lock`);
 if (reportingPath !== null) {
  check(resolve(reportingPath) !== resolve(statePath), 'Reporting ledger must be separate from business state');
  locks.push(`${reportingPath}.lock`);
 }
 return withFileLocks(locks, async () => {
  const current = await readRawState(statePath);
  check(current.schemaVersion === observed.schemaVersion, 'State linkage changed while acquiring locks');
  if (current.schemaVersion === 2) check(JSON.stringify(current.registry) === JSON.stringify(observed.registry), 'Registry linkage changed while acquiring locks');
  return operation(await projectRegistryState(current, resolve(statePath), options));
 });
}
