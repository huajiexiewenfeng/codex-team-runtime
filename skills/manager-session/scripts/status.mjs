import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

const usage = 'status.mjs --runtime-root <trusted-checkout> --state <state.json> [--as-of <UTC-ISO-time>] [--round <roundId>]';
// The selected checkout is executable code; the caller must trust it.
export async function run(args, output = console.log) {
  const allowed = new Set(['--runtime-root', '--state', '--as-of', '--round']);
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!allowed.has(key) || options.has(key) || !value || value.startsWith('--')) throw new Error(usage);
    options.set(key, value);
  }
  if (!options.has('--runtime-root') || !options.has('--state')) throw new Error(usage);
  const root = resolve(options.get('--runtime-root'));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'codex-team-runtime') throw new Error('Selected checkout is not codex-team-runtime');
  const { snapshot } = await import(pathToFileURL(join(root, 'src/runtime.mjs')).href);
  const { readState } = await import(pathToFileURL(join(root, 'src/store.mjs')).href);
  const view = snapshot(await readState(resolve(options.get('--state'))), options.get('--as-of') ?? new Date().toISOString(), options.get('--round') ?? null);
  output(JSON.stringify(view, null, 2));
  return view;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}
