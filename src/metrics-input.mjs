import { open, stat } from 'node:fs/promises';
import { createCodexUsageParser } from './metrics-observations.mjs';

const MAX_LINE_BYTES = 64 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const fail = message => { throw new Error(message); };

// Reads only the regular file named by path. Test-only read tuning is supplied by
// direct callers; the CLI never forwards descriptor fields into reader controls.
export async function readCodexUsageSource(path, parserOptions, { chunkSize = DEFAULT_CHUNK_BYTES, afterBoundary } = {}) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > DEFAULT_CHUNK_BYTES) fail('Invalid usage source chunk size');
  if (afterBoundary !== undefined && typeof afterBoundary !== 'function') fail('Invalid usage source boundary hook');
  const before = await stat(path);
  if (!before.isFile()) fail('Usage source must be a regular file');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) fail('Usage source must be a regular file');
    const boundary = opened.size;
    await afterBoundary?.({ boundary, handle });
    const parser = createCodexUsageParser(parserOptions, { observations: true });
    let position = 0, pending = [], pendingBytes = 0;
    while (position < boundary) {
      const length = Math.min(chunkSize, boundary - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) fail('Usage source was truncated before the opened byte boundary');
      position += bytesRead;
      let start = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 0x0a) continue;
        const part = buffer.subarray(start, index);
        if (pendingBytes + part.length > MAX_LINE_BYTES) fail('Usage source line exceeds the 64 MiB safety limit');
        const line = pending.length === 0 ? part : Buffer.concat([...pending, part], pendingBytes + part.length);
        parser.push(line.toString('utf8'));
        pending = []; pendingBytes = 0; start = index + 1;
      }
      if (start < bytesRead) {
        const part = buffer.subarray(start, bytesRead);
        pendingBytes += part.length;
        if (pendingBytes > MAX_LINE_BYTES) fail('Usage source line exceeds the 64 MiB safety limit');
        pending.push(Buffer.from(part));
      }
    }
    return parser.finish({ incompleteFinalLine: pendingBytes > 0 });
  } finally {
    await handle.close();
  }
}
