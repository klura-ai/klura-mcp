// Lint-test for the MCP tool catalog. Three guarantees:
//   1. every consumer tool name appears in klura's consumer-first SKILL.md;
//   2. start_session description mentions every GRAPH_MODE the runtime
//      exports (the description embeds the list and would otherwise drift
//      when a new mode lands);
//   3. ack_checkpoint description mentions every CHECKPOINT_KIND
//      (the description embeds a per-kind hint table, same drift risk).
//
// The catalog itself is canonicalized in `@klura/runtime`'s TOOL_REGISTRY.
// Per-entry shape lints (unique names, callable handlers, JSON-Schema
// inputSchema, name-in-TOOL_NAMES) live in the runtime's
// registry-parity.test.js next to the registry it asserts on. This file
// keeps the cross-document checks that the runtime can't see (SKILL.md
// drift, description-vs-runtime-constants drift).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const kluraPkgRoot = path.dirname(require.resolve('@klura/runtime/package.json'));
const { TOOL_REGISTRY } = require('@klura/runtime');
const { TOOL_DEFS: CONSUMER_TOOL_DEFS } = require(
  path.join(kluraPkgRoot, 'dist', 'consumer', 'mcp-tools.js'),
);

test('tools: every consumer tool name appears in klura SKILL.md', () => {
  const skillMd = fs.readFileSync(path.join(kluraPkgRoot, 'SKILL.md'), 'utf8');
  const consumerNames = new Set(CONSUMER_TOOL_DEFS.map((tool) => tool.name));
  const missing = [];
  for (const tool of TOOL_REGISTRY) {
    if (!consumerNames.has(tool.name)) continue;
    // Tool names are snake_case so substring match is enough.
    if (!skillMd.includes(tool.name)) missing.push(tool.name);
  }
  assert.deepEqual(missing, [], `tools missing from klura SKILL.md: ${missing.join(', ')}`);
});

test('tools: start_session graph enum mirrors runtime GRAPH_MODES', () => {
  const startSessionSrc = fs.readFileSync(
    path.join(kluraPkgRoot, 'src', 'tools', 'start-session.ts'),
    'utf8',
  );
  const match = startSessionSrc.match(/export const GRAPH_MODES = \[([^\]]+)\] as const/);
  assert.ok(match, 'GRAPH_MODES export missing from start-session.ts');
  const GRAPH_MODES = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const start = TOOL_REGISTRY.find((tool) => tool.name === 'start_session');
  assert.ok(start, 'start_session missing');
  assert.deepEqual([...start.inputSchema.properties.graph.enum], GRAPH_MODES);
  for (const mode of GRAPH_MODES) {
    assert.ok(start.description.includes(mode), `start_session description missing ${mode}`);
  }
});

test('tools: ack_checkpoint description names every checkpoint kind', () => {
  const { CHECKPOINT_KINDS } = require(path.join(kluraPkgRoot, 'dist', 'checkpoints', 'types.js'));
  const ack = TOOL_REGISTRY.find((tool) => tool.name === 'ack_checkpoint');
  assert.ok(ack, 'ack_checkpoint missing');
  for (const kind of CHECKPOINT_KINDS) {
    assert.ok(ack.description.includes(kind), `ack_checkpoint description missing ${kind}`);
  }
});
