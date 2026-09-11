import { pathToFileURL } from 'node:url';
import { validate } from './runtime.mjs';
import { applyRegistryProjection, prepareRegistryState } from './registry-projection.mjs';

const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const exact = (value, fields) => check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)), 'Adapter request fields mismatch');

export function adaptRegistryRequest(request) {
 check(request && typeof request === 'object' && !Array.isArray(request), 'Adapter request must be an object');
 switch (request.action) {
  case 'inspect':
   exact(request, ['action','state']);
   return validate(request.state);
  case 'prepare':
   exact(request, ['action','state','registry']);
   return prepareRegistryState(request.state, request.registry);
  case 'activate':
   exact(request, ['action','state','projection']);
   return applyRegistryProjection(request.state, request.projection);
  case 'check_exit': {
   exact(request, ['action','state','memberId']);
   validate(request.state);
   check(typeof request.memberId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(request.memberId), 'Invalid member ID');
   check(!request.state.rounds.some(round => round.status === 'open' && round.members.some(member => member.id === request.memberId)), 'Member participates in an open round');
   return { allowed:true };
  }
  default: fail('Unknown adapter action');
 }
}

async function main() {
 let input = '';
 for await (const chunk of process.stdin) input += chunk;
 const result = adaptRegistryRequest(JSON.parse(input));
 process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
