import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, open, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCodexUsageSource } from '../src/metrics-input.mjs';

const roots = [];
afterEach(async () => { while (roots.length) await rm(roots.pop(), { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'metrics-input-')); roots.push(root); return join(root, 'usage.jsonl'); }
const options = { hostId: 'fixture-host', threadId: 'fixture-thread', sourceRef: 'fixture-source' };
const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'fixture-thread' } });
const usage = JSON.stringify({ timestamp: '2026-09-12T00:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: 11 } } } });

test('streams split UTF-8 and CRLF while preserving physical source lines', async () => {
  const path = await fixture();
  const tool = JSON.stringify({ timestamp: '2026-09-12T00:00:00.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'exec', arguments: '你好' } });
  await writeFile(path, `${meta}\r\n\r\n${tool}\r\n${usage}\r\n`);
  const parsed = await readCodexUsageSource(path, options, { chunkSize: 5 });
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.observations[0].usageLine, 4);
  assert.deepEqual(parsed.observations[0].events.map(item => [item.kind, item.line, item.tool]), [['tool_call', 3, 'exec']]);
});

test('omits and diagnoses an incomplete final line', async () => {
  const path = await fixture(); await writeFile(path, `${meta}\n${usage}\n{"secret":"not retained"`);
  const parsed = await readCodexUsageSource(path, options, { chunkSize: 7 });
  assert.equal(parsed.records.length, 1);
  assert.ok(parsed.diagnostics.some(item => item.code === 'incomplete_line' && item.line === 3));
  assert.doesNotMatch(JSON.stringify(parsed), /not retained/);
});

test('accepts a source larger than 64 MiB when every line is short', async () => {
  const path = await fixture(), handle = await open(path, 'w');
  try {
    await handle.write(`${meta}\n`);
    const block = Buffer.from(`${' '.repeat(1023)}\n`.repeat(1024));
    for (let index = 0; index < 65; index++) await handle.write(block);
  } finally { await handle.close(); }
  const parsed = await readCodexUsageSource(path, options, { chunkSize: 1024 * 1024 });
  assert.equal(parsed.records.length, 0);
});

test('rejects a complete or incomplete line over 64 MiB without retaining it', async () => {
  for (const newline of ['', '\n']) {
    const path = await fixture(), handle = await open(path, 'w');
    try { await handle.write(Buffer.alloc(64 * 1024 * 1024 + 1, 0x61)); if (newline) await handle.write(newline); } finally { await handle.close(); }
    await assert.rejects(readCodexUsageSource(path, options), /line.*64 MiB/i);
  }
});

test('reads a fixed opened boundary, ignoring append and failing premature truncation', async () => {
  const appended = await fixture(); await writeFile(appended, `${meta}\n${usage}\n`);
  const first = await readCodexUsageSource(appended, options, { chunkSize: 4, afterBoundary: () => appendFile(appended, `${usage}\n`) });
  assert.equal(first.records.length, 1);

  const shortened = await fixture(); await writeFile(shortened, `${meta}\n${usage}\n${' '.repeat(10000)}\n`);
  await assert.rejects(readCodexUsageSource(shortened, options, { chunkSize: 4, afterBoundary: () => truncate(shortened, 2) }), /truncated/i);
});

test('always closes the opened handle after parser failure', async () => {
  const path = await fixture(); await writeFile(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'wrong' } })}\n`);
  let closed = false;
  await assert.rejects(readCodexUsageSource(path, options, { chunkSize: 3, afterBoundary: ({ handle }) => {
    const close = handle.close.bind(handle);
    handle.close = async () => { closed = true; return close(); };
  } }), /identity mismatch/i);
  assert.equal(closed, true);
});
