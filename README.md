# @klura/mcp

MCP (Model Context Protocol) server for [@klura/runtime](https://www.npmjs.com/package/@klura/runtime). It exposes maintained local web-data tools first, with browser discovery and tool authoring available only when the user explicitly asks for them.

`@klura/runtime` searches, installs, calls, and runs signed local tools without a model key. Its separate factory can map and maintain tools through observed browser work. `@klura/mcp` is the thin wrapper that speaks MCP on top of both surfaces.

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

- **Maintained local tools** — search, inspect, install, call, run, and inspect a signed package through `search_packages`, `install_package`, `call_package_capability`, `start_scrape_run`, and the related run/session tools. Target traffic and outputs stay on the user's machine.
- **Explicit authoring** — browser automation (`start_session`, `perform_action`, `get_screenshot`, `get_a11y_tree`), discovery + persistence (`save_strategy`, `execute`, `list_platform_skills`, `get_strategy`), network-log inspection (`get_network_log`, `find_in_page`), and reverse-engineering tools. The runtime owns the canonical list; this server mirrors it one-for-one.
- **Resource** `klura://reference` — the detailed reference doc, served section-by-section via URL fragments (`klura://reference#reverse-engineer-playbook`, `klura://reference#recorded-path-schema`, etc.) so each response fits inside the MCP output budget. Fetch `klura://reference` with no fragment for a table of contents.

The always-loaded orientation is SKILL.md, passed as the server's `instructions` capability. Agents read SKILL.md on every conversation and pull detail on demand via the `klura://reference` fragments.

## How it works

Thin wrapper — each MCP `tools/call` dispatches to the corresponding klura runtime function. The runtime handles daemon lifecycle, browser sessions, strategy persistence under `~/.klura/skills/`, and execution.

```
MCP client (Claude Desktop, Cursor, …)
    │  stdio transport, JSON-RPC
    ▼
@klura/mcp (this package)
    │  Node require('@klura/runtime')
    ▼
klura runtime → local daemon → Playwright
```

## License

BUSL-1.1. See [LICENSE](LICENSE). Same terms as the underlying `@klura/runtime`; see the runtime README for the commercial-use terms.
