#!/usr/bin/env node

// Klura MCP Server — exposes browser automation tools via Model Context Protocol.
// Works with Claude Desktop, Cursor, Windsurf, and any MCP client.
//
// Usage:
//   npx @klura/mcp           (stdio transport)
//
// MCP config:
//   {
//     "mcpServers": {
//       "klura": {
//         "command": "npx",
//         "args": ["-y", "@klura/mcp"]
//       }
//     }
//   }
//
// This package is a thin stdio wrapper. The server factory itself —
// `createKluraMcpServer()` — lives in `@klura/runtime` (runtime/mcp-server.js),
// so the runtime's optional CLI agent can build the same server without a
// dependency cycle (`@klura/mcp` depends on `@klura/runtime`, never the
// reverse). The factory is re-exported here for back-compatibility.

const { createKluraMcpServer } = require('@klura/runtime/mcp-server');

async function main() {
  // Latch this process as driven by an external MCP host BEFORE anything else.
  // This is the load-bearing layer of the agent guardrail: with the flag set,
  // the optional klura CLI LLM agent refuses to run, so it can never start a
  // second LLM underneath the host that is already driving klura. Stdio is the
  // external-host transport; the in-memory transport the CLI agent and the
  // test harnesses use never reaches this path.
  require('@klura/runtime').markExternalMcpHost();
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = await createKluraMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

module.exports = { createKluraMcpServer };

if (require.main === module) {
  main().catch((err) => {
    console.error('Klura MCP server failed:', err);
    process.exit(1);
  });
}
