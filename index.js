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

// Build the klura MCP server — wires every tool + resource handler onto a
// fresh Server instance and returns it unconnected. Callers pick a transport:
// `main()` below attaches stdio for the CLI path; the field-reports harness
// imports this directly and passes the instance to the Agent SDK via
// `{type:'sdk', instance}` so the browser pool survives across SDK `resume`
// queries (each resume would otherwise spawn a fresh stdio child and orphan
// every in-memory session).
async function createKluraMcpServer() {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  // Load klura runtime
  const klura = require('@klura/runtime');

  // SKILL.md (compact) is the always-loaded orientation.
  // REFERENCE.md (detailed schemas, examples) is served as an on-demand
  // resource via klura.resolveReferenceResource — see the ReadResource
  // handler below for the fragment-based section addressing.
  const skillMd = klura.getSkillMd()
    .replace(/^---[\s\S]*?---\s*/, ''); // strip frontmatter

  // Front-load a terse per-platform capability catalog so agents see what
  // klura already knows BEFORE the first tool call. The list_platform_skills
  // _hint only fires when the agent calls the tool, but the load-bearing
  // failure mode (observed in field) is the agent skipping that call entirely
  // and going straight to start_session for work an existing capability
  // already covers. The deliberate principle break + always-save framing
  // live in the rendered string itself (see getSavedSkillsSummaryMd).
  const savedSkills = klura.getSavedSkillsSummaryMd();
  const instructions = savedSkills ? `${skillMd}\n\n${savedSkills}` : skillMd;

  const server = new Server(
    { name: '@klura/mcp', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} }, instructions }
  );

  // -- Resources (on-demand reference docs) --
  //
  // REFERENCE.md is served section-by-section via URL fragments so each
  // response fits inside the MCP output budget. Fetching `klura://reference`
  // with no fragment returns a short table of contents listing every
  // addressable `#<slug>`; fetching `klura://reference#<slug>` returns only
  // that section. The section parser + budget logic lives in the runtime
  // module (`runtime/src/reference-sections.ts`) so a pre-commit test can
  // assert every section fits before a regression lands.

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const sections = klura.listReferenceSections();
    return {
      resources: [
        {
          uri: 'klura://reference',
          name: 'Klura Reference — Table of Contents',
          description:
            'Table of contents for the detailed reference. Fetch individual sections by appending a URL fragment, e.g. klura://reference#fetch-schema. ' +
            `Available sections: ${sections.map((s) => '#' + s.slug).join(', ')}.`,
          mimeType: 'text/markdown',
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    try {
      const { text } = klura.resolveReferenceResource(uri);
      return {
        contents: [{ uri, mimeType: 'text/markdown', text }],
      };
    } catch (err) {
      // Surface the runtime's helpful error (which lists available slugs)
      // directly to the MCP client instead of swallowing it.
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });

  // -- Tool registry --
  //
  // Every tool's schema and handler live colocated in mcp/tools.js. The
  // ListTools handler reads the registry; the CallTool dispatcher looks up
  // the entry by name and invokes its handler. Adding a tool means adding
  // exactly one entry there — no separate switch case to keep in sync.
  const tools = require('./tools.js')(klura);
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  // OpenAI-style tool_calls deliver `arguments` as a JSON string parsed
  // once by the client. Many non-Anthropic models then JSON-encode nested
  // object/array fields a SECOND time, so we receive `args.foo === "{...}"`
  // where the schema declares `foo: {type: 'object'}`. Walk the inputSchema
  // and parse strings that the schema says shouldn't be strings. Only
  // strict JSON ('{', '['); leave anything else alone so we don't disturb
  // legitimately stringy fields. Best-effort: if parse fails or the value
  // doesn't match the declared type after parsing, leave it for the
  // runtime's own validators to reject with a useful error.
  function coerceArgs(toolName, args) {
    const tool = toolByName.get(toolName);
    const schema = tool && tool.inputSchema;
    if (!schema || !schema.properties || !args || typeof args !== 'object') return args;
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const v = args[key];
      if (typeof v !== 'string') continue;
      const expected = propSchema?.type;
      const wantsContainer =
        expected === 'object' ||
        expected === 'array' ||
        (Array.isArray(expected) && (expected.includes('object') || expected.includes('array')));
      if (!wantsContainer) continue;
      const trimmed = v.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const parsedType = Array.isArray(parsed) ? 'array' : typeof parsed;
        const matches = Array.isArray(expected)
          ? expected.includes(parsedType)
          : expected === parsedType;
        if (matches) args[key] = parsed;
      } catch { /* leave for downstream validator */ }
    }
    return args;
  }

  // -- Tool execution --

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = toolByName.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    const args = coerceArgs(name, rawArgs);

    // Progress notifications. When the client request carried
    // `_meta.progressToken`, the SDK exposes it on `extra._meta` and gives us
    // `extra.sendNotification` for sending `notifications/progress` bound to
    // that token. Clients that honor this (Claude Desktop via MCP SDK with
    // `resetTimeoutOnProgress: true`) reset their per-request timeout each
    // time a progress arrives — turning a 4-minute hard deadline into a
    // sliding window that survives long-running tools (end_drive on a real
    // RE session does heavy synthesis + audit + handoff prose composition).
    //
    // Two emit paths:
    //  - Explicit phase boundaries inside the tool (e.g. endDrive's
    //    progress({stage: '...'}) calls). Names what's running so the user
    //    sees specific status, not just "still working".
    //  - 30s heartbeat for tools that don't emit explicit progress. Fires
    //    only when no explicit progress arrived in the last interval, so
    //    instrumented tools don't double-emit.
    let progressCount = 0;
    let lastProgressAt = Date.now();
    let progress;
    let heartbeat;
    const progressToken = extra && extra._meta ? extra._meta.progressToken : undefined;
    if (progressToken !== undefined && extra && typeof extra.sendNotification === 'function') {
      progress = ({ stage, current, total } = {}) => {
        progressCount += 1;
        lastProgressAt = Date.now();
        extra
          .sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: typeof current === 'number' ? current : progressCount,
              ...(typeof total === 'number' ? { total } : {}),
              ...(typeof stage === 'string' ? { message: stage } : {}),
            },
          })
          .catch(() => { /* notification send failure is non-fatal */ });
      };
      heartbeat = setInterval(() => {
        if (Date.now() - lastProgressAt >= 30000) {
          progress({ stage: 'still working' });
        }
      }, 30000);
    }

    try {
      // Phase admissibility — hard tool blocking per the session-phase
      // state machine. Tools not in the current phase's allowedTools
      // (or, when budget is exhausted, not in allowedToolsWhenExhausted)
      // are rejected here without running. Universal tools (control
      // plane, memory reads, escape valve) bypass; tools called without
      // a session (start_session, etc.) bypass too. After admission,
      // tickPhaseCounter increments the per-phase round counter and
      // engages the soft-block flag when the budget is hit.
      if (args && args.session_id) {
        try {
          klura.assertToolAdmissibleBySessionId(args.session_id, name);
        } catch (err) {
          if (err instanceof klura.ToolNotAdmissibleError) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ok: false,
                    error: 'tool_not_admissible',
                    phase: err.phase,
                    tool: err.toolName,
                    message: err.reason,
                  }, null, 2),
                },
              ],
              isError: true,
            };
          }
          throw err;
        }
      }

      // Pending-interruption / pending-checkpoint gates. A prior tool
      // call returned a handover resolution; every subsequent tool call
      // on the same session must echo the relevant token + an ack
      // (user_response / viewer_result) or cancel with {cancelled: true,
      // reason}. Tools that deliberately resolve the matching pending
      // state opt out via `skipInterruptionGate` / `skipCheckpointGate`
      // on their registry entry.
      if (args && args.session_id && !tool.skipInterruptionGate) {
        klura.assertNoPendingInterruption(args.session_id, {
          interruption_token: args.interruption_token,
          user_response: args.user_response,
          viewer_result: args.viewer_result,
          cancelled: args.cancelled,
          reason: args.reason,
        });
      }
      if (args && args.session_id && !tool.skipCheckpointGate) {
        klura.assertNoPendingCheckpoint(args.session_id, {
          checkpoint_token: args.checkpoint_token,
          user_response: args.user_response,
          viewer_result: args.viewer_result,
          cancelled: args.cancelled,
          reason: args.reason,
        });
      }

      let result = await tool.handler(args, { progress });

      // Inject sticky LIFT obligation reminder. Fires on every tool
      // response between the first mutating perform_action and either a
      // successful save_strategy or end_drive ok:true. Once-per-session
      // semantics → no token-binding needed (see runtime/docs/gates.md
      // §once-vs-many). klura.formatToolResult hoists the obligation
      // message into a leading [klura obligation]: <message> text block
      // so the model reads it as a top-level directive rather than buried
      // inside the JSON-stringified payload — that hoist + the imperative
      // wording in session-obligations.ts is the primary mechanism. If a
      // model still ends_turn with an open obligation despite reading the
      // hoisted block, treat that as a runtime weakness worth surfacing,
      // not a harness gap to paper over.
      if (args && args.session_id) {
        try {
          const obligation = klura.getSessionObligation(args.session_id);
          if (obligation && result && typeof result === 'object' && !Array.isArray(result)) {
            result = { ...result, _session_obligation: obligation };
          }
        } catch {
          /* non-fatal */
        }
      }

      // Convert to MCP content blocks (screenshots become image blocks)
      const blocks = klura.formatToolResult(name, result);
      return {
        content: blocks.map(b =>
          b.type === 'image'
            ? { type: 'image', data: b.data, mimeType: b.mediaType }
            : { type: 'text', text: b.text }
        ),
      };
    } catch (err) {
      // Attach the LIFT obligation to error responses too. Without this,
      // every save_strategy / end_drive rejection drops the "MUST be
      // end_drive" anchor exactly when the agent most needs it — agents
      // reading just the bare error treat the failure as a one-off shape
      // complaint and end the turn after the user-facing goal looks done.
      let obligationLine = '';
      if (args && args.session_id) {
        try {
          const obligation = klura.getSessionObligation(args.session_id);
          if (obligation && obligation.message) {
            obligationLine = `[klura obligation]: ${obligation.message}\n\n`;
          }
        } catch { /* non-fatal */ }
      }

      // klura's audit-style rejections (`invalid_<kind>: ...` and
      // `invalid_<kind>_rejected (<reason>)`) are iteration steps, not tool
      // errors — the agent's expected next move is to re-call the same tool
      // with audit_token + audit_answers. Returning these with
      // `isError: true` makes the SDK surface them as tool errors, which
      // Claude reads as "task failed, here's why" and reflexively wraps up
      // with text (end_turn) instead of continuing the iteration loop. Send
      // them as normal text results so the model treats them as data.
      const msg = typeof err.message === 'string' ? err.message : String(err);
      if (/^invalid_[a-z_]+:/.test(msg)) {
        return {
          content: [{ type: 'text', text: `${obligationLine}${msg}` }],
        };
      }
      return {
        content: [{ type: 'text', text: `${obligationLine}Error: ${msg}` }],
        isError: true,
      };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  });

  return server;
}

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
