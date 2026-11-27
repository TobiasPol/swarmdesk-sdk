// Runs INSIDE the sandbox child (see sandbox.mjs). Loads the untrusted module and answers
// JSON-line requests: stdin carries {"inputs":[...]}, fd 3 carries {"results":[...]}. Each result is
// {"v":<value>}, {"u":1} when the function returned undefined, or {"t":1} when it threw. With the
// "spread" mode each input is an argument list; otherwise it is the single argument.
// Its stdout/stderr are discarded by the parent. This file must not import anything from the
// target directory (reference.mjs and friends are not readable from inside the sandbox).
import { createWriteStream } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [modulePath, exportName, mode] = process.argv.slice(2);
const spread = mode === 'spread';
const reply = createWriteStream(null, { fd: 3 });

let fn = null;
let loadError = '';
try {
  const mod = await import(pathToFileURL(modulePath).href);
  fn = mod[exportName];
  if (typeof fn !== 'function') loadError = 'export';
} catch {
  loadError = 'load';
}

function callOne(input) {
  try {
    const json = JSON.stringify(spread ? fn(...input) : fn(input));
    return json === undefined ? '{"u":1}' : `{"v":${json}}`;
  } catch {
    return '{"t":1}';
  }
}

function handle(line) {
  if (loadError) return JSON.stringify({ error: loadError });
  const { inputs } = JSON.parse(line);
  const parts = [];
  for (const input of inputs) parts.push(callOne(input));
  return `{"results":[${parts.join(',')}]}`;
}

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let nl = pending.indexOf('\n');
  while (nl !== -1) {
    const line = pending.slice(0, nl);
    pending = pending.slice(nl + 1);
    reply.write(`${handle(line)}\n`);
    nl = pending.indexOf('\n');
  }
});
