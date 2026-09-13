export const metricNames = ['input', 'cachedInput', 'nonCachedInput', 'output', 'reasoningOutput', 'net', 'total'];

const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };

function safeAdd(left, right) {
  const value = left + right;
  check(Number.isSafeInteger(value), 'Metric sum exceeds safe integer range');
  return value;
}

export function observed(record) {
  const { input, cachedInput, output, reasoningOutput, total } = record.usage;
  const nonCachedInput = input === null || cachedInput === null ? null : input - cachedInput;
  const net = nonCachedInput === null || output === null ? null : safeAdd(nonCachedInput, output);
  return { input, cachedInput, nonCachedInput, output, reasoningOutput, net, total };
}

export function rollup(records) {
  const result = {};
  for (const name of metricNames) {
    let known = 0;
    let knownRecords = 0;
    let missingRecords = 0;
    for (const record of records) {
      const value = observed(record)[name];
      if (value === null) missingRecords++;
      else {
        known = safeAdd(known, value);
        knownRecords++;
      }
    }
    result[name] = { known: knownRecords === 0 ? null : known, knownRecords, missingRecords };
  }
  return result;
}
