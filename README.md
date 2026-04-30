# @klura/mcp

MCP (Model Context Protocol) server for [@klura/runtime](https://www.npmjs.com/package/@klura/runtime). Exposes the klura runtime's browser-automation + skill-discovery toolset to any MCP client — Claude Desktop, Claude Code, Cursor, Windsurf, and others.

`@klura/runtime` is the runtime that turns websites into reusable skills: drive the site once, save the recipe, skip the browser on every subsequent run. `@klura/mcp` is the thin wrapper that speaks MCP on top of it. See the [runtime README](https://www.npmjs.com/package/@klura/runtime) for what the skills actually do and how they get saved.

## Install

```bash
npm install -g @klura/mcp
```

The `@klura/runtime` package is declared as a dependency and installed alongside. The runtime auto-starts a local daemon on first use and stores everything it learns under `~/.klura/`.

## Wire it up

Add the server to your MCP client's config. The exact file path depends on the client — the server definition is the same.

```json
{
  "mcpServers": {
    "klura": {
      "command": "npx",
      "args": ["-y", "@klura/mcp"]
    }
  }
}
```

Restart the client. The agent picks up the klura toolset automatically.

## What it exposes

Two surfaces land in the agent's context:

- **Tools** — browser automation (`start_session`, `perform_action`, `get_screenshot`, `get_a11y_tree`), discovery + persistence (`save_strategy`, `execute`, `list_platform_skills`, `get_strategy`), network-log inspection (`get_network_log`, `find_in_page`), and the reverse-engineering escape hatches (`inspect_ws_frame`, `try_generator`, `js_eval`, `get_js_source`, `search_js_source`, `read_js_function`, `set_breakpoint`, `wait_for_pause`, and more). The runtime owns the canonical list; this server mirrors it one-for-one.
- **Resource** `klura://reference` — the detailed reference doc, served section-by-section via URL fragments (`klura://reference#reverse-engineer-playbook`, `klura://reference#strategy-schemas-overview`, etc.) so each response fits inside the MCP output budget. Fetch `klura://reference` with no fragment for a table of contents.

The always-loaded orientation is SKILL.md, passed as the server's `instructions` capability. Agents read SKILL.md on every conversation and pull detail on demand via the `klura://reference` fragments.

## How it works

Thin wrapper — each MCP `tools/call` dispatches to the corresponding klura runtime function. The runtime handles daemon lifecycle, browser sessions, strategy persistence under `~/.klura/skills/`, and execution.

```
MCP client (Claude Desktop, Cursor, …)
    │  stdio transport, JSON-RPC
    ▼
klura-mcp (this package)
    │  Node require('@klura/runtime')
    ▼
klura runtime → local daemon → Playwright
```

## License

BUSL-1.1. See [LICENSE](LICENSE). Same terms as the underlying `@klura/runtime`; see the runtime README for the commercial-use terms.
