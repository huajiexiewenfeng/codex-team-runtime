import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

const maxFiles = 10_000, maxFileBytes = 65_536, maxTotalBytes = 67_108_864;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };

function validateDescriptor(descriptor) {
  const fields = ['registryId', 'teamId', 'sourceKind', 'files'];
  check(descriptor !== null && typeof descriptor === 'object' && !Array.isArray(descriptor) && Object.keys(descriptor).length === fields.length && fields.every(key => Object.hasOwn(descriptor, key)), 'Invalid MCP observation descriptor fields');
  check(typeof descriptor.registryId === 'string' && idPattern.test(descriptor.registryId), 'Invalid registryId'); check(typeof descriptor.teamId === 'string' && idPattern.test(descriptor.teamId), 'Invalid teamId');
  check(['fixture', 'mcp-server'].includes(descriptor.sourceKind), 'Invalid sourceKind');
  check(Array.isArray(descriptor.files), 'Invalid MCP observation files');
  check(descriptor.files.length <= maxFiles, `MCP observation files may contain at most ${maxFiles} entries`);
  check(descriptor.files.every(value => typeof value === 'string' && value.length > 0 && !value.includes('\0')), 'Invalid MCP observation file path');
}

async function boundedRead(path, remaining) {
  const handle = await open(path, 'r');
  try {
    const information = await handle.stat();
    check(information.isFile(), 'MCP observation source must be a regular file');
    check(information.size <= maxFileBytes, `MCP observation file exceeds ${maxFileBytes} byte size limit`);
    check(information.size <= remaining, `MCP observation files exceed ${maxTotalBytes} byte total size limit`);
    const chunks = [], buffer = Buffer.alloc(Math.min(8192, maxFileBytes + 1)); let bytes = 0;
    while (true) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, maxFileBytes + 1 - bytes), null);
      if (result.bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead))); bytes += result.bytesRead;
      check(bytes <= maxFileBytes, `MCP observation file exceeds ${maxFileBytes} byte size limit`);
      check(bytes <= remaining, `MCP observation files exceed ${maxTotalBytes} byte total size limit`);
    }
    return Buffer.concat(chunks, bytes);
  } finally { await handle.close(); }
}

export async function readMcpObservationManifest(descriptor, baseDirectory) {
  validateDescriptor(descriptor);
  check(typeof baseDirectory === 'string' && baseDirectory.length > 0, 'Invalid MCP observation base directory');
  const records = []; let total = 0;
  for (const selected of descriptor.files) {
    const path = resolve(baseDirectory, selected), content = await boundedRead(path, maxTotalBytes - total);
    total += content.length;
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(content); }
    catch { fail(`Invalid UTF-8 in MCP observation file: ${path}`); }
    let event;
    try { event = JSON.parse(source); }
    catch { fail(`Invalid JSON in MCP observation file: ${path}`); }
    records.push({ event, sourceRefs: [path] });
  }
  return { registryId: descriptor.registryId, teamId: descriptor.teamId, sourceKind: descriptor.sourceKind, records };
}
