import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultConfigPath = fileURLToPath(new URL('../config/model-policy.json', import.meta.url));
const roles = ['manager', 'worker', 'liaison', 'subagent'];
const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function requireKeys(value, keys, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`Invalid ${label} fields`);
  }
}

export function validatePolicy(policy) {
  requireKeys(policy, ['schemaVersion', 'defaults', 'modelOrder'], 'policy');
  if (policy.schemaVersion !== 1) throw new Error('Unsupported policy schemaVersion');
  const order = policy.modelOrder;
  if (!Array.isArray(order) || !order.length || new Set(order).size !== order.length
      || order.some(model => typeof model !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(model))) {
    throw new Error('Invalid modelOrder: use unique explicit model IDs, highest first');
  }
  requireKeys(policy.defaults, roles, 'defaults');
  for (const role of roles) {
    const settings = policy.defaults[role];
    requireKeys(settings, ['model', 'effort'], role);
    if (role === 'manager') {
      if (settings.model !== null || settings.effort !== null) throw new Error('Manager must remain user-selected');
    } else if (!order.includes(settings.model) || !efforts.includes(settings.effort)) {
      throw new Error(`Invalid ${role} model or effort`);
    }
  }
  return policy;
}

export function resolvePolicy(policy, role, parentModel) {
  validatePolicy(policy);
  if (!roles.includes(role)) throw new Error('Unknown role');
  if (role !== 'subagent' && parentModel !== undefined) throw new Error('parent-model applies only to subagent');
  const configured = { ...policy.defaults[role] };
  const selected = { ...configured };
  if (role === 'subagent') {
    const parentRank = policy.modelOrder.indexOf(parentModel);
    if (parentRank < 0) throw new Error('subagent requires a known direct parent-model');
    if (policy.modelOrder.indexOf(selected.model) < parentRank) selected.model = parentModel;
  }
  const hostFields = role === 'manager' ? {} : {
    model: selected.model,
    [role === 'subagent' ? 'reasoning_effort' : 'thinking']: selected.effort,
  };
  return { role, configured, selected, ceilingAdjusted: selected.model !== configured.model, hostFields };
}

export async function run(args, write = console.log) {
  const command = args[0] ?? 'show';
  if (!['show', 'resolve'].includes(command)) throw new Error('Use show or resolve <role> [--parent-model <id>] [--config <path>]');
  const role = command === 'resolve' ? args[1] : undefined;
  const options = new Map();
  for (let i = command === 'resolve' ? 2 : 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--config', '--parent-model'].includes(key) || options.has(key)
        || !value || value.startsWith('--')) throw new Error('Invalid or duplicate option');
    options.set(key, value);
  }
  if (command === 'show' && options.has('--parent-model')) throw new Error('parent-model requires resolve subagent');
  const configPath = resolve(options.get('--config') ?? defaultConfigPath);
  const policy = validatePolicy(JSON.parse(await readFile(configPath, 'utf8')));
  const result = {
    configPath,
    effectiveModelVerified: false,
    ...(command === 'show' ? { policy } : resolvePolicy(policy, role, options.get('--parent-model'))),
  };
  write(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch(error => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
