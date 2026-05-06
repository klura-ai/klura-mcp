// Klura MCP tool catalog — thin wrapper over the runtime's TOOL_REGISTRY.
//
// Every tool's name, description, inputSchema, and handler is defined
// colocated with its implementation in `runtime/src/tools/*.ts` and
// assembled into `TOOL_REGISTRY` (re-exported from `@klura/runtime`).
// `mcp/index.js` calls this factory to get the array; tools that own a
// runtime gate (interruption / checkpoint) opt out of the generic pre-call
// assertion via `skipInterruptionGate` / `skipCheckpointGate` set on the
// TOOL_DEF — see the dispatcher in `mcp/index.js`.

module.exports = function defineTools(klura) {
  return klura.TOOL_REGISTRY;
};
