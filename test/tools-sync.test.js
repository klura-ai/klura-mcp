// Lint-test for tools.js. Three guarantees:
//   1. every tool handler resolves to a real export on the klura runtime
//      (catches typos like `klura.startSesion` that would otherwise only
//      surface at the first MCP tool call after deploy);
//   2. every tool has a unique name and a JSON-Schema-shaped inputSchema;
//   3. every tool name appears in klura's SKILL.md (the "three surfaces in
//      sync" rule — adding a tool to MCP without mentioning it in SKILL.md
//      leaves agents unaware of it).
//
// How it works: defineTools(klura) is called with a Proxy whose `get` trap
// records the property name and returns a stub function. Each handler is
// then invoked with stub args, which triggers klura.<funcName> access — we
// log every name touched. Then we cross-check those names against the real
// runtime exports.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const defineTools = require('../tools.js');

// @klura/runtime is an npm dep. Resolve its package root from node_modules
// so we can read its compiled exports + SKILL.md without booting the
// runtime (require('@klura/runtime') has side-effects — pool + driver init —
// that don't belong in a tools-catalog lint test).
const kluraPkgRoot = path.dirname(require.resolve('@klura/runtime/package.json'));

// Statically extract exported names from a compiled CJS module without
// loading it. We only need the *names* to verify handler closures
// reference real exports.
function staticExports(distFile) {
  const src = fs.readFileSync(distFile, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^exports\.(\w+)\s*=/gm)) names.add(m[1]);
  for (const m of src.matchAll(/Object\.defineProperty\(exports,\s*["'](\w+)["']/g)) names.add(m[1]);
  // Barrel re-exports: __exportStar(require("./relpath"), exports) — recurse.
  for (const m of src.matchAll(/__exportStar\(require\(["']([^"']+)["']\)/g)) {
    const rel = m[1];
    const next = path.join(path.dirname(distFile), rel + '.js');
    if (fs.existsSync(next)) {
      for (const n of staticExports(next)) names.add(n);
    }
  }
  names.delete('__esModule');
  return names;
}

const kluraExportNames = staticExports(path.join(kluraPkgRoot, 'dist', 'index.js'));

function buildRecordingProxy() {
  const accessed = new Set();
  const stub = () => undefined;
  const proxy = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      accessed.add(prop);
      return stub;
    },
  });
  return { proxy, accessed };
}

test('tools: every handler calls a real klura export', () => {
  const { proxy, accessed } = buildRecordingProxy();
  const tools = defineTools(proxy);

  for (const tool of tools) {
    assert.equal(typeof tool.handler, 'function', `${tool.name}: handler missing`);
    try {
      tool.handler({});
    } catch (err) {
      assert.fail(`${tool.name}: handler threw at static dispatch — ${err.message}`);
    }
  }

  const missing = [];
  for (const name of accessed) {
    if (!kluraExportNames.has(name)) missing.push(name);
  }
  assert.deepEqual(
    missing,
    [],
    `tools.js handlers reference klura exports that don't exist: ${missing.join(', ')}`
  );
});

test('tools: tool names are unique', () => {
  const { proxy } = buildRecordingProxy();
  const tools = defineTools(proxy);

  const seen = new Set();
  for (const tool of tools) {
    if (seen.has(tool.name)) assert.fail(`duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
  }
});

test('tools: every tool has a JSON-Schema-shaped inputSchema', () => {
  const { proxy } = buildRecordingProxy();
  const tools = defineTools(proxy);

  for (const tool of tools) {
    assert.ok(tool.name && typeof tool.name === 'string', `tool missing name`);
    assert.ok(tool.description && typeof tool.description === 'string',
      `${tool.name}: description missing`);
    assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object',
      `${tool.name}: inputSchema missing`);
    assert.equal(tool.inputSchema.type, 'object',
      `${tool.name}: inputSchema.type must be "object"`);
    assert.ok(tool.inputSchema.properties && typeof tool.inputSchema.properties === 'object',
      `${tool.name}: inputSchema.properties missing`);
  }
});

test('tools: every tool name appears in klura SKILL.md', () => {
  const { proxy } = buildRecordingProxy();
  const tools = defineTools(proxy);

  const skillMd = fs.readFileSync(path.join(kluraPkgRoot, 'SKILL.md'), 'utf8');
  const missing = [];
  for (const tool of tools) {
    // Tool names are snake_case so substring match is enough.
    if (!skillMd.includes(tool.name)) missing.push(tool.name);
  }
  assert.deepEqual(
    missing,
    [],
    `tools missing from klura SKILL.md: ${missing.join(', ')}`
  );
});

test('tools: start_session graph enum mirrors runtime GRAPH_MODES', () => {
  const startSessionSrc = fs.readFileSync(
    path.join(kluraPkgRoot, 'src', 'tools', 'start-session.ts'),
    'utf8',
  );
  const match = startSessionSrc.match(/export const GRAPH_MODES = \[([^\]]+)\] as const/);
  assert.ok(match, 'GRAPH_MODES export missing from start-session.ts');
  const GRAPH_MODES = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const tools = defineTools({ GRAPH_MODES });
  const start = tools.find((tool) => tool.name === 'start_session');
  assert.ok(start, 'start_session missing');
  assert.deepEqual(start.inputSchema.properties.graph.enum, GRAPH_MODES);
  for (const mode of GRAPH_MODES) {
    assert.ok(start.description.includes(mode), `start_session description missing ${mode}`);
  }
});

test('tools: ack_checkpoint description names every checkpoint kind', () => {
  const { CHECKPOINT_KINDS } = require(path.join(kluraPkgRoot, 'dist', 'checkpoints', 'types.js'));
  const { composeAckHint } = require(path.join(kluraPkgRoot, 'dist', 'checkpoints', 'ack-hints.js'));
  const tools = defineTools({ CHECKPOINT_KINDS, composeAckHint });
  const ack = tools.find((tool) => tool.name === 'ack_checkpoint');
  assert.ok(ack, 'ack_checkpoint missing');
  for (const kind of CHECKPOINT_KINDS) {
    assert.ok(ack.description.includes(kind), `ack_checkpoint description missing ${kind}`);
  }
});
