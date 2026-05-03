// Klura MCP tool catalog. One entry per tool — schema and handler colocated
// so a reviewer sees both halves of the contract at once. The MCP server
// (mcp/index.js) imports this and dispatches by name through a Map.
//
// Tools that own a runtime gate (interruption / checkpoint) opt out of the
// generic pre-call assertion via `skipInterruptionGate` / `skipCheckpointGate`
// — see the dispatcher in mcp/index.js.

module.exports = function defineTools(klura) {
  const graphModes = Array.isArray(klura.GRAPH_MODES)
    ? klura.GRAPH_MODES
    : ['discover', 'map', 'execute'];
  const checkpointKinds = Array.isArray(klura.CHECKPOINT_KINDS)
    ? klura.CHECKPOINT_KINDS
    : [
        'triage_plan',
        'surface_changed',
        'recorded_step_failed',
        'session_expired',
        'post_save_validation_consent',
      ];
  const checkpointAckTable = checkpointKinds
    .map((kind) => {
      const hint =
        typeof klura.composeAckHint === 'function'
          ? klura.composeAckHint(kind, {})
          : 'Echo checkpoint_token with user_response, viewer_result, or cancelled + reason.';
      return `- ${kind}: ${hint}`;
    })
    .join('\n');

  return [
    {
      name: 'start_session',
      description: `Open a browser at the given URL. Returns \`{sessionId, a11yTree, url, artifacts?, executed?, execute_result?, graph?}\`. The \`graph\` parameter selects one of: ${graphModes.map((g) => `"${g}"`).join(', ')}. "discover" (default) — drive→triage→lift→closed, the standard goal-directed reverse-engineering flow; "map" — drive→closed, surface-mapping with mutating-action consent gates and skipped auto-synth; "execute" — execute→triage→lift→closed (or terminal{failed}), runs a saved strategy and falls into triage on stale-strategy failure so the agent can re-plan and re-lift. When you pass \`{capability, args}\` and a complete saved strategy covers that capability, the runtime auto-runs the strategy in-session and returns \`executed: true\` with the result — call close_session and you are done.`,
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
          platform: { type: 'string', description: 'Optional platform name to load saved cookies' },
          capability: { type: 'string', description: 'The capability slug being discovered or executed (e.g. "send_message"). Required for auto-execute and for auto-save at close_session.' },
          args: { type: 'object', description: 'Per-capability argument map: {paramName: literalValue}. These are the user-supplied values the agent will type (e.g. {text: "hello", recipient: "Bob"}). Used at auto-execute time to run the saved strategy, and at close_session time to template captured traffic into a reusable strategy body.' },
          policy: {
            type: 'object',
            description: 'Create permanent platform policy at session creation time. This is create-only: if policy.json already exists for the platform, start_session rejects rather than mutating it. Requires `platform`. Friendly aliases: `max_tier` / `max_strategy_tier` set the declared capability cap when `capability` is present, otherwise the platform default; `default_max_tier` / `default_max_strategy_tier` set the platform default. Tiers: "recorded-path", "page-script", "fetch". Per-capability entries may use `max_tier` or `max_strategy_tier`. After creation, policy is user-owned via CLI / policy.json, not MCP.',
            properties: {
              max_tier: { type: 'string', enum: ['recorded-path', 'page-script', 'fetch'], description: 'Alias for max_strategy_tier. With `capability`, caps that capability; without it, sets the platform default.' },
              max_strategy_tier: { type: 'string', enum: ['recorded-path', 'page-script', 'fetch'], description: 'With `capability`, caps that capability; without it, sets the platform default.' },
              default_max_tier: { type: 'string', enum: ['recorded-path', 'page-script', 'fetch'], description: 'Alias for default_max_strategy_tier.' },
              default_max_strategy_tier: { type: 'string', enum: ['recorded-path', 'page-script', 'fetch'] },
              reason: { type: 'string', description: 'Optional audit reason stored when `max_tier` / `max_strategy_tier` creates a per-capability cap.' },
              per_capability: {
                type: 'object',
                description: 'Per-capability caps, keyed by capability slug. Entry fields: max_tier/max_strategy_tier and optional reason.',
              },
              forbid_capabilities: { type: 'array', items: { type: 'string' } },
              throttle: { type: 'object' },
              respect_robots_txt: { type: 'boolean' },
              notes: { type: 'string' },
            },
          },
          graph: { type: 'string', enum: graphModes, description: 'Default: "discover". Selects the FSM topology + per-graph behavior. "discover": drive→triage→lift→closed. "map": drive→closed; mutating actions gate on a per-(action, selector) consent checkpoint, auto-synth is skipped at close, the re-persistence gate fires when ≥5 perform_actions land with zero persistence calls. "execute": execute→triage→lift→closed (or terminal{failed}); runs a saved strategy and on stale-strategy failure transitions into triage with the failure as defense-surface input — arg/auth/structural failures terminate with status: failed.' },
          lift_mode: {
            type: 'string',
            enum: ['explicit_learn', 'skip'],
            description: "LIFT behavior. 'explicit_learn' (default) — close_session handoff is framed as a one-shot ask: 'answer delivered; should I spend rounds lifting this?' Agent composes a user prompt in its own voice from the inline triage bundle (current_tier, prior_attempts, discovery_artifact) + raw captures + get_platform_logbook, then waits for the user's yes/no. Standard interactive UX. 'skip' — no handoff; just let close_session auto-synth drop whatever recorded-path it can. For autonomous runs without a human in the loop, register a checkpoint handler that resolves every relevant kind to `{status: 'continue'}` — see klura://reference#checkpoints.",
          },
          identity: {
            type: 'string',
            description: 'Optional account name on `platform`. Default-when-omitted (or `"default"`) uses the historical platform-only cookie jar / profile — single-account behavior. Pass `"work"`, `"personal"`, etc. to scope cookies (`<platform>--<identity>.json`), the credential-autofill profile slot, and the warm-pool key so two accounts on the same platform never share state. Use this when the agent needs to "use account A and do X, use account B and do Y" in one conversation. See klura://reference#identities.',
          },
        },
        required: ['url'],
      },
      handler: (args) => klura.startSession(args.url, {
        platform: args.platform,
        capability: args.capability,
        args: args.args,
        policy: args.policy,
        graph: args.graph,
        lift_mode: args.lift_mode,
        identity: args.identity,
      }),
    },

    {
      name: 'perform_action',
      description: 'Interact with the page. Actions: click, type, select (use CSS selectors), fill_editor (contenteditable rich-text editors — Lexical/Slate/Draft/ProseMirror — where type fails on zero-height bounding boxes), mouse_click (x,y coords), mouse_drag (from x,y to x,y), key_press, scroll. `type` APPENDS to existing field content (cursor lands at end, matches human typing behavior); when the field is empty this is identical to a full fill. Pass `replace: true` with `type` to clear the field first. Returns the updated accessibility tree (~2-4s on heavy DOMs). If your NEXT tool call is `get_network_log`, `get_screenshot`, or another `perform_action`, pass `return_tree: false` — it skips the a11y read, returns `{url}` only, and shaves a couple of seconds off the chain. Pass `page` to target a popup or `target=_blank` tab — the response\'s `subPages[]` lists open handles (`popup-1`, `popup-2`, ...). Default targets the main page.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          action: { type: 'string', enum: ['click', 'type', 'select', 'fill_editor', 'mouse_click', 'mouse_drag', 'key_press', 'scroll'], description: 'Action to perform' },
          selector: { type: 'string', description: 'CSS selector, text selector, coordinate pair "x,y", or key name — depends on action' },
          value: { type: 'string', description: 'Value for type/select/fill_editor, target "x,y" for mouse_drag, "deltaX,deltaY" for scroll' },
          return_tree: { type: 'boolean', description: 'Default true. Set false when the next tool call is going to supersede the tree anyway (network log, screenshot, another interaction) — skips the ~2-4s a11y read.' },
          page: { type: 'string', description: 'Page handle. Default "main" (the page the session opened with). Pass a popup id from session.subPages[].id (e.g. "popup-1") to act on a tracked popup or target=_blank tab. Unknown handles reject with a list of the currently-open ones.' },
        },
        required: ['session_id', 'action', 'selector'],
      },
      handler: (args) => klura.performAction(args.session_id, args.action, args.selector, args.value, {
        returnTree: args.return_tree !== false,
        replace: args.replace === true,
        page: args.page,
      }),
    },

    {
      name: 'get_network_log',
      description: 'Captured network activity — **HTTP requests AND WebSocket frames** in one call. **For write-capability discovery, ALWAYS narrow with a filter on the first call** — do not scan the raw summary and then fetch {i, full: true} per entry, that is the slow anti-pattern. A narrowing filter auto-promotes HTTP entries to detail-lite mode (full request headers + full postData + 512-char responseBody preview per entry) AND surfaces matching WebSocket frames in the response\'s `wsFrames` field (url + direction + 512-char payload preview per frame). Three filter patterns, in order of specificity: (1) {text_contains: "<literal>"} — the best primitive when you know a string you just typed. Substring-searches URL + headers + postData + responseBody for HTTP AND payload for every captured WS frame; the request OR ws frame that carried or echoed your input is almost always the only match. **On realtime / chat sites the write is usually a sent WS frame, not an HTTP POST** — it appears in `wsFrames`, not `requests`. (2) {url_contains: "<path>"} — when the endpoint path is distinctive (e.g. /graphql, /api/orders). (3) {last: 20} — when neither of the above applies, tails the final entries of the session. Detail-lite auto-paginates when the narrowed set is larger than one response; walk pages with {page: N}. The other modes: unfiltered call → summary (one tiny object per HTTP request + the last 30 WS frame previews); {i: N, full: true} → a single verbatim HTTP entry; {ws_i: N, full: true} → a single untrimmed WS frame (use this to capture the exact payload bytes for a `protocol:"websocket"` strategy); {full: true} → paginated raw detail-list for HTTP, rarely needed.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          i: { type: 'number', description: 'Absolute index into the HTTP requests array. With full:true returns one entry verbatim, bypassing filters and pagination.' },
          ws_i: { type: 'number', description: 'Absolute index into the WebSocket frames array. With full:true returns one frame verbatim (untrimmed payload). Use after scanning the clipped wsFrames previews to capture the exact payload of a specific frame for a protocol:"websocket" strategy.' },
          full: { type: 'boolean', description: 'Return raw entries with all headers and full bodies (no response-body clipping). With i: single HTTP entry. With ws_i: single untrimmed WS frame. Without either: paginated detail-list (default page_size 5, max 20). Suppresses detail-lite auto-promotion.' },
          url_contains: { type: 'string', description: 'Case-insensitive URL substring filter — applies to both HTTP entries and WS frames. Triggers detail-lite auto-promotion when the filtered set fits the budget.' },
          text_contains: { type: 'string', description: 'Case-insensitive substring search across every field (URL, header names + values, postData, responseBody) of each HTTP entry AND every captured WebSocket frame\'s payload. Use when you know a literal string the request carried or the response / ws frame echoed — e.g. the message you just sent. Combines with url_contains. Triggers detail-lite auto-promotion.' },
          last: { type: 'number', description: 'Tail the last N entries after filters (applies independently to HTTP requests and WS frames). Use to narrow to the window right after a submit action — the send/post/order request OR the sent WS frame is almost always in the final few entries. Triggers detail-lite auto-promotion.' },
          page: { type: 'number', description: '1-indexed page number. Default 1. Explicit pagination suppresses detail-lite auto-promotion.' },
          page_size: { type: 'number', description: 'Override default page size. Summary default 50 (max 200); detail-list default 5 (max 20). Explicit page_size suppresses detail-lite auto-promotion.' },
        },
        required: ['session_id'],
      },
      handler: (args) => klura.getNetworkLog(args.session_id, {
        i: args.i,
        ws_i: args.ws_i,
        full: args.full,
        url_contains: args.url_contains,
        text_contains: args.text_contains,
        last: args.last,
        page: args.page,
        page_size: args.page_size,
        body_offset: args.body_offset,
        body_length: args.body_length,
      }),
    },

    {
      name: 'inspect_ws_frame',
      description: 'Return a byte-level view of a captured WebSocket frame. Use when composing `generated.frame.code` for a binary envelope (length-prefixed headers, nested-escaped JSON, varint encoding) — eyeballing a 1-KB raw-octet string in a `get_network_log({ws_i, full: true})` response is slow and error-prone. Three formats: "mixed" (default — classic hex dump with offset column + 16 hex bytes per line + ASCII gutter, easiest for spotting length prefixes and topic/command strings); "hex" (space-separated lowercase bytes, no formatting); "utf8" (decoded text with non-printable control bytes escaped as \\xNN, useful for seeing JSON payloads inside the envelope). Paginate with {offset, length} — default 512 bytes per call, max 4096. **One-call iteration-1 starter**: pass `text_contains` with the literal you typed and, when the frame matches the binary-WS write shape, the response carries a `starter` field — a runnable generator pre-wired to splice `args.text` into the captured envelope. Pair with `try_generator({code: starter.code, args: starter.args_for_iteration_1, verify_against: {ws_hash}})` for a one-call ok:true that confirms envelope shape; the rest is refactor-not-discover (template the dynamic fields named in `starter.next_iteration_targets`). **Stable handle**: response carries `ws_hash` — a content-addressed handle that survives ring-buffer rotation and can be passed to every RE tool in place of `ws_i`. Prefer `ws_hash` for any reference you reuse across multiple tool calls.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          ws_i: { type: 'number', description: 'Positional index of the captured frame in the session\'s ws frame ring buffer. Fragile — rotates as new frames arrive. Prefer ws_hash for cross-call references.' },
          ws_hash: { type: 'string', description: 'Content-addressed handle for the frame (returned on every shaped frame and on the close_session RE nag). Survives ring rotation; only way to address a pinned frame. Use instead of ws_i when available.' },
          offset: { type: 'number', description: 'Byte offset to start the view (default 0). Use to page through frames larger than 4096 bytes.' },
          length: { type: 'number', description: 'Bytes to include (default 512, max 4096). Clamped with a `clamped: true` flag when you ask for more than the max.' },
          format: { type: 'string', enum: ['hex', 'utf8', 'mixed'], description: 'Output format. Default "mixed".' },
          text_contains: { type: 'string', description: 'The literal you typed into the page (the user-variable substring). When set AND the frame is a binary-WS write envelope, the response carries a `starter` object with iteration-1 generator code that returns ok:true against the captured frame on the very first try_generator call. Skip if you only want to eyeball bytes.' },
        },
        required: ['session_id'],
      },
      handler: (args) => klura.inspectWsFrame({
        session_id: args.session_id,
        ws_i: args.ws_i,
        ws_hash: args.ws_hash,
        offset: args.offset,
        length: args.length,
        format: args.format,
        text_contains: args.text_contains,
      }),
    },

    {
      name: 'find_in_ws_frame',
      description: 'Locate every byte offset where `needle` appears inside a captured WebSocket frame (treated as raw octets — UTF-8 substrings match against the utf-8-encoded bytes). Use this to find the byte offset of the user-variable substring (the message text you typed) inside a length-prefixed binary envelope, which is the anchor your `generated.frame.code` needs when it composes the outgoing frame from a slice-and-inject shape. Returns `{offsets: number[], total_length: number, truncated?: boolean}`. Up to 32 offsets per call. Accepts ws_i OR ws_hash — prefer ws_hash (survives ring rotation).',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          ws_i: { type: 'number', description: 'Positional index of the captured frame (fragile — rotates).' },
          ws_hash: { type: 'string', description: 'Content-addressed stable handle. Preferred.' },
          needle: { type: 'string', description: 'The substring to search for. Typically the literal text you typed into the page, so you know where the user-variable lives in the envelope.' },
        },
        required: ['session_id', 'needle'],
      },
      handler: (args) => klura.findInWsFrame({
        session_id: args.session_id,
        ws_i: args.ws_i,
        ws_hash: args.ws_hash,
        needle: args.needle,
      }),
    },

    {
      name: 'trigger_reference_send',
      description: 'Fire a short action sequence (perform_action-shaped steps) and surface every new sent WebSocket frame that arrives during / within `settle_ms` of the final step. Returns each candidate with `ws_hash` + `ws_i` + byte length so the agent can pick one and pin it via pin_ws_frame (or opt into `auto_pin: true` which pins the first sent frame over 100 bytes — a rough "probably the real send, not a keepalive" heuristic). Use this when you need a fresh reference frame AFTER the close_session auto-pin window has passed, or on execute-only sessions that never hit close_session. **Consent gate (Level-3 token-gated):** this tool re-fires a submit, producing a real side-effect on every call. The first call always returns a `consent_token` + checklist; the second call must echo the token and include `consent_answers` ({tier, action_description, recipient_description, user_acknowledgement_quote}). Tier 2 (destructive, irreversible, monetary, OR any third-party recipient human/bot) requires a non-empty user_acknowledgement_quote with the user\'s own words. The token binds to a hash of the consented payload — changing actions between calls forces re-classification. See klura://reference#checkpoints.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          actions: {
            type: 'array',
            description: 'Up to 10 perform_action-shaped steps to run in order before listening for frames.',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string' },
                selector: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['action'],
            },
          },
          settle_ms: { type: 'number', description: 'Post-action settle window. Default 1500, clamped [100, 10000].' },
          auto_pin: { type: 'boolean', description: 'Pin the first sent frame >100 bytes automatically. Default false.' },
          consent_token: { type: 'string', description: 'Echo the consent_token returned on the prior rejection. Bound to a hash of the action sequence — changing actions invalidates the token.' },
          consent_answers: {
            type: 'object',
            description: 'Classification of the side-effect. Tier 1 = low-stakes (sandbox, idempotent, read-only). Tier 2 = destructive, irreversible, monetary, OR any third-party recipient (human/bot). Tier 2 requires non-empty user_acknowledgement_quote.',
            properties: {
              tier: { type: 'string', enum: ['1', '2'] },
              action_description: { type: 'string', description: 'What will fire, in your own words.' },
              recipient_description: { type: 'string', description: 'Who or what service receives the side effect.' },
              user_acknowledgement_quote: { type: 'string', description: 'REQUIRED for tier "2". The user\'s own words confirming consent — tamper-evident paper trail.' },
            },
            required: ['tier', 'action_description', 'recipient_description'],
          },
        },
        required: ['session_id', 'actions'],
      },
      handler: (args) => klura.triggerReferenceSend({
        session_id: args.session_id,
        actions: args.actions,
        settle_ms: args.settle_ms,
        auto_pin: args.auto_pin,
        consent_token: args.consent_token,
        consent_answers: args.consent_answers,
      }),
    },

    {
      name: 'pin_ws_frame',
      description: 'Explicitly pin a captured WebSocket frame so it survives the ring buffer\'s FIFO rotation. Returns the stable `ws_hash` to pass to every RE tool (inspect_ws_frame, find_in_ws_frame, try_generator_in_page.verify_against, explain_ws_frame_structure). Use when you want a reference frame to remain addressable across many iteration rounds — the ring cap means long RE sessions lose early frames as new ones push them out. The close_session RE nag already auto-pins the target frame identified in `signal.ws_hash`; use this tool for additional frames (companion ack frame, prior-send diff target) the auto-pin couldn\'t know about. Pins are capped per session (LRU eviction on overflow) — response carries `pinned_count`, `pinned_cap`, and any `evicted_hash`.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          ws_i: { type: 'number', description: 'Positional ring index to resolve and pin.' },
          ws_hash: { type: 'string', description: 'Or an existing hash to re-pin (moves to MRU position).' },
        },
        required: ['session_id'],
      },
      handler: (args) => klura.pinWsFrame({
        session_id: args.session_id,
        ws_i: args.ws_i,
        ws_hash: args.ws_hash,
      }),
    },

    {
      name: 'get_send_encoder',
      description: 'Read the per-ws_i side-channel that the page-side WebSocket.send wrapper stashed at send time. On a matching captured send: `{sent_args_preview, sent_args_type, sent_args_byte_length, ws_url, head_hex, ts, handle_alive, encoder_handle, advice}` — `encoder_handle` is a JS expression like `window.__kluraSendEncoders[471]` addressable via `js_eval` to read `<handle>.ws` (captured WebSocket instance) and `<handle>.sentArgs` (original data passed to send). When no stash entry matches, returns `{encoder: null, reason, advice}` — `reason` is one of `frame_out_of_range` (ws_i past buffer), `frame_received` (not a sent frame — pick a sent one), `wrapper_not_installed` (no WS-using JS on the page yet), `no_matching_fingerprint` (page may have re-wrapped WebSocket.send; fall back to reading encoder source via `get_js_source` with `inspect_ws_frame.js_callstack`). The `advice` field names the best next action for each reason. Pair with `inspect_ws_frame.js_callstack` + `get_js_source` for the reverse-engineer toolkit.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          ws_i: { type: 'number', description: 'Index into the captured wsFrames array (same value used for inspect_ws_frame).' },
        },
        required: ['session_id', 'ws_i'],
      },
      handler: (args) => klura.getSendEncoder({
        session_id: args.session_id,
        ws_i: args.ws_i,
      }),
    },

    {
      name: 'get_js_source',
      description: 'Read the source body of a JS script the page has already loaded, windowed around `line` with surrounding context. The fast path for binary-WS / signed-request reverse engineering: `inspect_ws_frame.js_callstack.frames[0]` names the file:line of the encoder; `get_js_source(file, {line: that_line, context_lines: 80})` reads the surrounding source, so you SEE the actual derivations (`epoch_id = Date.now() * 1e6n`, `otid = nextOtid()`, etc.) instead of guessing them from output bytes. Pretty-prints minified single-line bundles before windowing so the slice has structure. Per-session cache means paginated reads share one fetch. Response: `{url, format, total_lines, start_line, end_line, source, truncated?}`.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          url: { type: 'string', description: 'Script URL (typically the `file` field of a js_callstack frame). Must be a script the page has already loaded — the fetch runs inside the page context and reuses the browser cache + cookies.' },
          line: { type: 'number', description: '1-indexed line to center the window on. Default 1.' },
          context_lines: { type: 'number', description: 'Lines of surrounding context (above + below the target line). Default 60, max 200. Combined window is ≤ MCP output budget; oversized requests get `truncated: true`.' },
          format: { type: 'string', enum: ['raw', 'pretty'], description: 'Default "pretty" — single-line minified scripts get split + indented for legibility. Pass "raw" to skip pretty-printing.' },
        },
        required: ['session_id', 'url'],
      },
      handler: (args) => klura.getJsSource({
        session_id: args.session_id,
        url: args.url,
        line: args.line,
        context_lines: args.context_lines,
        format: args.format,
      }),
    },

    {
      name: 'try_generator',
      description: 'Dry-run a candidate `generated.<name>.code` snippet in the warm-execute vm sandbox, optionally diffing output byte-for-byte against a captured WebSocket frame. On `ok:false` the response names `first_diff_offset` + `expected_byte` + `got_byte` + a 16-byte hex context window on each side. Sandbox globals: `Date`, `Math`, `Buffer`, `JSON`, string/number helpers, `encodeURIComponent`/`decodeURIComponent`, `crypto` (`randomUUID`, `randomBytes`, `createHash`, `createHmac`), `args` (frozen). 100ms timeout. Must return a string; for binary, return base64. Full loop + convergence signals + structural-match mode: klura://reference#try-generator.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session ID from start_session. Required only when verify_against.ws_i is used so the captured ws frame can be looked up.' },
          code: { type: 'string', description: 'The JS snippet to run. Identical shape to strategy.generated.<name>.code. Wrapped in an IIFE at runtime, must use `return` to emit the frame. Return a string; return base64 for binary frames (encoding:"binary").' },
          args: { type: 'object', description: 'The `args` object exposed to the sandbox. Mirror the execute-time shape (e.g. {message: "hello"}). Pass the same values you\'d pass to execute() so the test matches reality.' },
          encoding: { type: 'string', enum: ['text', 'binary'], description: 'How to interpret the generator\'s return string when diffing: "binary" (default) base64-decodes before comparing; "text" compares the string verbatim. Must match the strategy\'s frameEncoding.' },
          verify_against: {
            type: 'object',
            description: 'Optional ground truth to diff against. One of {ws_i}, {ws_hash}, or {base64}. ws_hash preferred over ws_i (survives ring rotation). Omit to just run the code and return its output without diffing.',
            properties: {
              ws_i: { type: 'number', description: 'Positional ring-buffer index (fragile).' },
              ws_hash: { type: 'string', description: 'Stable content hash. Preferred.' },
              base64: { type: 'string', description: 'Explicit ground-truth bytes as base64. Use when you already have the expected bytes in hand (e.g. from a prior get_network_log response) without needing a live session.' },
            },
          },
          match: { type: 'string', enum: ['bytes', 'structural'], description: '"bytes" (default) — byte-perfect match required. "structural" — extract JSON from both sides, compare shapes (keys + value types) while ignoring actual values. Use when the envelope is right and only rotating-value differences remain; skips the diminishing-returns byte-perfect convergence.' },
        },
        required: ['code'],
      },
      handler: (args) => klura.tryGenerator({
        session_id: args.session_id,
        code: args.code,
        args: args.args ?? {},
        verify_against: args.verify_against,
        encoding: args.encoding,
        match: args.match,
      }),
    },

    {
      name: 'try_generator_in_page',
      description: 'Page-side sibling of `try_generator`: runs a `frameFromPage`-shaped expression in the LIVE page (via `driver.evaluateExpression`), decodes its hex/base64 output to bytes, and diffs against a captured ws frame. Gives you the same convergence feedback `try_generator` gives for Node-VM generators, but for expressions that can read `document` / `window.*` / live session state. A successful run (`ok:true`) means the expression can be saved verbatim as `frameFromPage.expression` on a `page-script` strategy. Use this when you hit the "HARD PIVOT — write the encoder yourself" path on a binary-WS nag: iterate your expression against the captured frame until bytes match, then save.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          expression: { type: 'string', description: 'JS expression run in the live page. Interpolated with {{paramName}} against `args` before eval. Must produce a string encoded per `returns`.' },
          args: { type: 'object', description: 'Template args substituted into the expression. Mirror the warm-execute shape.' },
          returns: { type: 'string', enum: ['hex', 'base64'], description: 'How the expression\'s return string is decoded to bytes. Default "hex".' },
          verify_against: {
            type: 'object',
            description: 'Captured ws frame to compare output against. Accepts ws_i (positional, fragile across ring rotation) or ws_hash (content-addressed, survives rotation and works for pinned frames). Prefer ws_hash for any iteration loop.',
            properties: {
              ws_i: { type: 'number', description: 'Positional ring-buffer index (fragile).' },
              ws_hash: { type: 'string', description: 'Stable content hash. Preferred.' },
            },
          },
          timeout_ms: { type: 'number', description: 'Page-eval timeout in ms. Default 5000, capped 30000.' },
          match: { type: 'string', enum: ['bytes', 'structural'], description: '"bytes" (default) — byte-perfect match required. "structural" — shape-only comparison; see try_generator for details.' },
        },
        required: ['session_id', 'expression', 'verify_against'],
      },
      handler: (args) => klura.tryGeneratorInPage({
        session_id: args.session_id,
        expression: args.expression,
        args: args.args ?? {},
        match: args.match,
        returns: args.returns,
        verify_against: args.verify_against,
        timeout_ms: args.timeout_ms,
      }),
    },

    {
      name: 'get_screenshot',
      description: 'Take a screenshot of the current page. Returns base64-encoded PNG.',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
      },
      handler: (args) => klura.getScreenshot(args.session_id),
    },

    {
      name: 'get_a11y_tree',
      description: 'Fetch the full, untrimmed accessibility tree for a live session, paginated. Use when the default trimmed tree from `start_session` / `perform_action` (or the healable-error body from `execute`) came back with `a11y_truncated: true` and you need to see the rest of the page to pick a selector. Response shape: `{tree, total_chars, page, page_size, total_pages, has_more}`. Most discovery turns do NOT need this — the trimmed defaults cover the top ~15 KB of the tree, which is enough for nearly every real-world page. Reach for this tool only when you have evidence the element you want is outside the trimmed window (e.g. deeply nested content, very long lists).',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          page: { type: 'number', description: '1-indexed page number. Default 1. Follow has_more to walk the whole tree.' },
          page_size: { type: 'number', description: 'Characters per page. Default 15000. Max 20000 (the tool-output budget).' },
        },
        required: ['session_id'],
      },
      handler: (args) => klura.getA11yTree(args.session_id, { page: args.page, page_size: args.page_size }),
    },

    {
      name: 'get_action_history',
      description: 'Return the session\'s timestamped perform_action history. Each entry carries `at` (Unix ms), `action`, and whichever of `selector` / `value` / `key` / `url` apply. Filter with `since` / `until` to time-correlate against XHR timestamps from `get_network_log` — e.g. "I clicked X at time T; which XHR fired between T and T+2s was the data load for that click?" Compact response; no pagination needed (histories are typically 10-30 entries). Primary use case: at close_session review time, when you need to figure out which captured request carried the data you reported to the user, scan action history for the last click/navigate + use that timestamp as a floor on `get_network_log` to narrow the candidate window.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          since: { type: 'number', description: 'Unix-ms floor — include only actions at or after this timestamp. Default: no floor.' },
          until: { type: 'number', description: 'Unix-ms ceiling — include only actions at or before this timestamp. Default: no ceiling.' },
        },
        required: ['session_id'],
      },
      handler: (args) => klura.getActionHistory(args.session_id, { since: args.since, until: args.until }),
    },

    {
      name: 'get_attribute',
      description: 'Read an attribute off the first element matching a CSS selector — use this to verify that a candidate selector (e.g. a `meta[name=csrf-token]` nonce, a hidden `input[name=authenticity_token]`, a `data-*` attribute) actually exists on the live page before saving it into a strategy. If `attr` is omitted, returns the element\'s text content. Returns `{value: string}` on success; throws if the selector does not resolve (so you can tell "doesn\'t exist" apart from "exists but empty"). Meta tags and other non-a11y elements are not in the accessibility tree — use this tool to read them directly.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          selector: { type: 'string', description: 'CSS selector for the element, e.g. "meta[name=csrf-token]", "input[name=authenticity_token]", "[data-token]"' },
          attr: { type: 'string', description: 'Attribute name to read (e.g. "content", "value"). Omit to read the element\'s text content.' },
        },
        required: ['session_id', 'selector'],
      },
      handler: (args) => klura.getAttribute(args.session_id, args.selector, args.attr),
    },

    {
      name: 'find_in_page',
      description: 'Scan the current page for elements whose text content or any attribute value contains `needle`. Returns up to `limit` matches with a usable CSS selector, the matching attribute (if any), and a truncated value preview. **Use this to trace opaque values you see in captured request bodies back to the DOM that rendered them.** When `get_network_log` shows a POST body with a value you didn\'t provide (internal IDs, nonces, opaque tokens), call `find_in_page` with that value — you\'ll usually get back the `<meta>` tag, hidden `<input>`, or `data-*` attribute the web app read it from. Then turn that selector into a `page-extract` prereq. If the exact value isn\'t found, try progressively: shorter substrings (numeric or alphanumeric fragments from inside the value), then the base64-decoded form, then a decoded substring. Many web apps encode a visible numeric ID into an opaque API ID via a deterministic transform (base64, hex, hash) — when you find the numeric on the page but the opaque form in the body, write a small generator that re-applies the transform.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          needle: { type: 'string', description: 'Substring to search for. Try the raw value first; if no match, try shorter substrings or a base64-decoded form.' },
          limit: { type: 'number', description: 'Max matches to return. Default 20.' },
        },
        required: ['session_id', 'needle'],
      },
      handler: (args) => klura.findInPage(args.session_id, args.needle, args.limit),
    },

    {
      name: 'end_drive',
      description: 'End the DRIVE phase. The agent has finished driving the UI; runtime now hands over to TRIAGE if any declared capability is unresolved (returns the triage handoff with captures inventory + diagnostic tools menu + plan-structure preview), or finalizes the session when everything is resolved. Phase-locked to drive — calling from triage or lift returns a structured rejection. (Renamed from close_session — same teardown semantics; the new name reflects that it only finishes the drive phase. Auto-close on terminal save_strategy means most sessions never need to call this explicitly.)\n\nClose a browser session. Runs auto-synthesis: builds `page-script`/`fetch` strategies by joining typed literals to captured HTTP request bodies, and a `recorded-path` from perform_action history. Also persists the discovery artifact (resume pointers + tool-call trace). Response carries `auto_synthesized: [{capability, tier, path}]`, `artifacts_updated: [{capability, sessions_contributed, has_blob}]`, and `_diagnostics.synth: [{pass, capability, phase, outcome, detail}]` explaining exactly what each synth pass found — whether it matched, where (http_request_body / ws_frame_sent / etc.), and why it saved or skipped. Read `_diagnostics` when you need to understand why auto-save produced nothing — the most common case is `outcome: "literal_in_ws_frame_only"` which means the send rode a binary WS frame and needs manual lift via `inspect_ws_frame` + `try_generator`.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          platform: { type: 'string', description: 'Platform name to save storage state for' },
          audit_token: { type: 'string', description: 'Echo the audit_token returned on the prior close_session audit rejection (capability_declaration_required Detector and/or re_persistence Classifier). See klura://reference#close-session-audit.' },
          audit_answers: { type: 'object', description: 'Audit answers per the checklist from the prior rejection. Shape: {re_persistence?: {acknowledge_no_progress: true}}. Only pass acknowledge_no_progress when you genuinely have nothing worth persisting; the preferred path is to call save_verified_expression / add_discovery_note / add_resume_pointer and retry.' },
        },
        required: ['session_id'],
      },
      handler: (args) => klura.closeSession(args.session_id, {
        platform: args.platform,
        auditToken: args.audit_token,
        auditAnswers: args.audit_answers,
      }),
    },

    {
      name: 'save_strategy',
      description: 'Save a discovered execution strategy for a platform capability. klura stores only complete, runnable strategies on disk; iterative progress goes into the capability\'s discovery_artifact via `save_verified_expression` / `add_discovery_note` / `add_resume_pointer`, and into the platform logbook via `record_observed_capability`. On `end_drive` with no complete save, auto-synth drops a recorded-path fallback from perform_action history.\n\n**save_strategy commits the strategy file only.** It does not close the session. The session stays open until you explicitly call `end_drive`. Multi-capability sessions: save each capability, then `end_drive` to finalize. Single-capability sessions: save, persist any RE findings via `add_discovery_note` / `add_resume_pointer`, then `end_drive`. The close-time audit (re_persistence, capability_declaration_required, auto-synth, logbook flush) all live on `end_drive`.\n\nCommon save-time rejections (error message names the field; catalog here to front-load):\n  - **Pre-save audit (two-phase, token-gated)** — first call always rejected with `audit_token` + checklist. Echo on next call with `audit_answers` classifying every literal. Full shape: klura://reference#save-strategy-audit.\n  - **`user_confirmation` audit** — every save requires the user\'s explicit approval. The first call returns `items.user_confirmation.prompt_for_user` — relay it verbatim to the user, get yes/no, retry with `audit_answers.user_confirmation: {user_decision: "approve"|"reject", user_quote: "<verbatim user reply>"}`. Token binds to the whole strategy hash, so any structural change forces a fresh ask.\n  - **Selector self-reference** — prereq extract that reads the id already in `endpoint`/`wsUrl`. Extract from a structural source (URL regex, page global, JSON script tag).\n  - **recorded-path over observed binary WS write** — capability is liftable above recorded-path; start with `inspect_ws_frame` + `try_generator`. Persist partial progress to discovery_artifact and let close_session auto-synth the fallback.\n  - **fetch with empty `prerequisites: []` that needs in-page cookies** — set `transport: "browser"`.\n  - **`notes.<unknown_subkey>`** — allowlisted keys: `params`, `quirks`, `auth`, `discovery` (string), `observed_capabilities[]`, `changelog`, `anchor_type`, `save_warnings`, `save_warnings_acked`.\n  - **Save-time warnings** — `unparametrized_session_id`, `unresolved_name_to_id_gap`, `entity_pinned_infra_prereq`. Either fix the strategy or ack inline via `notes.save_warnings_acked: [{kind, reason}]`. Reason required.\n  - **URL not observed in discovery network log** — pass `session_id` so the cross-reference catches recalled-from-training-data endpoints.\n  - **Enum param without grounding** — `kind: "enum"` caller_input needs `observed_values: [{value, label}...]` from captured traffic, or `source: "capability:<slug>"`. See klura://reference#enum-params.\n  - **`status` field on strategy body** — not in the schema. Iterative progress lives in the discovery_artifact, not the strategy body.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string' },
          capability: { type: 'string' },
          strategy: {
            type: 'object',
            description: 'Strategy body. `strategy` field: "fetch" | "page-script" | "recorded-path". For fetch/page-script: method, baseUrl, endpoint, headers, body. Use page-script (with `origin`) when bot-protection cookies can\'t replay outside the browser — runtime fires the fetch from inside the page. For page-script, declare `notes.anchor_type`: "module" | "protocol" | "dom" | "unknown" (default; treated as fragile). HTML reads add `response: {format: "html", extract: {name: {selector, attr?, multiple?}}}`. Auto-generated values via `generated.<name>`; reference as {{__gen.<name>}}. Full schemas + worked examples: klura://reference#strategy-schemas-overview, klura://reference#page-script-anchors.',
          },
          changelog: { type: 'string', description: 'Human-readable summary of what changed (logged to history)' },
          session_id: { type: 'string', description: 'Discovery session id (REQUIRED for agent-driven saves). The session anchors the pre-save audit — URL cross-check against the captured network log, literal_provenance classifier, user_confirmation decider integration. Without it, the audit is skipped (the audit-skip path is reserved for in-process programmatic callers like auto-synth and tests, which call `saveStrategy()` directly rather than going through MCP).' },
          audit_token: { type: 'string', description: 'Echo the audit_token returned on the prior save_strategy rejection.' },
          audit_answers: { type: 'object', description: 'Classification answers per the checklist from the prior rejection. Shape: {literal_provenance: {<path>: "static"|{caller_input:"<param>"}|{prereq_output:"<binds>"}|"single_entity"}, capability_name_justification?: string, observed_siblings: {<"METHOD url">: "recorded"|"not_worth_recording:<reason>"}, user_confirmation: {user_decision: "approve"|"reject", user_quote: "<verbatim user reply>"}}. See klura://reference#save-strategy-audit for details.' },
        },
        required: ['platform', 'capability', 'strategy', 'session_id'],
      },
      handler: (args) => klura.saveStrategy(
        args.platform,
        args.capability,
        args.strategy,
        args.changelog,
        args.session_id,
        { token: args.audit_token, answers: args.audit_answers },
      ),
    },

    {
      name: 'submit_triage_plan',
      description:
        'Commit a defense-surface triage plan (per `surface_label`) and request user ack to enter LIFT. Inspect third-party origins / scripts / cookies / request patterns on the page; identify the bot-detection posture using your own knowledge (runtime never names vendors). Inputs: surface_label, defense_surface, expected_tier, tier_justification (must cite an observed origin / script / cookie / URL verbatim — runtime rejects empty or uncited justifications), summary_for_user. Tier suggestion is informational; the agent still aims T0 → T1 → T2 in lift. Multi-surface flows submit one plan per surface; the runtime fires a `surface_changed` checkpoint when navigation crosses to an un-triaged surface.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          capability: { type: 'string' },
          surface_label: {
            type: 'string',
            description: 'Semantic name for this surface (e.g. "checkout", "search", "settings/billing"). One plan per surface; later saves whose target URL binds to this label gate on this plan.',
          },
          defense_surface: {
            type: 'object',
            properties: {
              observed_origins: { type: 'array', items: { type: 'string' } },
              observed_scripts: { type: 'array', items: { type: 'string' } },
              cookies_set: { type: 'array', items: { type: 'string' } },
              request_patterns: { type: 'array', items: { type: 'string' } },
              mechanism_hypothesis: { type: 'string' },
            },
            required: ['observed_origins', 'observed_scripts', 'cookies_set', 'request_patterns', 'mechanism_hypothesis'],
          },
          expected_tier: { type: 'string', enum: ['fetch', 'page-script', 'recorded-path'] },
          tier_justification: { type: 'string', description: 'Free-text justification — must cite at least one verbatim observed origin / script / cookie / URL.' },
          summary_for_user: { type: 'string', description: '1-3 sentence non-technical summary the user reads via the triage_plan checkpoint.' },
        },
        required: ['session_id', 'capability', 'surface_label', 'defense_surface', 'expected_tier', 'tier_justification', 'summary_for_user'],
      },
      handler: (args) => klura.submitTriagePlan(args),
    },

    {
      name: 'list_platform_skills',
      description: 'List every platform skill — one entry per platform with its saved capabilities and any observed-but-not-lifted ones. The "platform skill" is the bundle of all capabilities klura has learned for one site.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => klura.listPlatformSkills(),
    },

    {
      name: 'get_strategy_health',
      description: 'Per-strategy rolling success rate + status for saved skills. Returns one row per (platform, capability, strategy_type) with `success_rate` (over the last ≤20 calls; null when fewer than 5 samples), `samples`, `status` (healthy/degraded/broken), `last_error`, `silenced`, and `rediscover_gate_armed` (true when the next `execute` call would raise the rediscover ack-gate). Pass `platform` to scope to one platform; omit to list all known platforms. Use this proactively to spot strategies that have rotted before they fire mid-flow. Threshold lives in `pool.rediscoverThreshold` (configure via the `configure` tool).',
      inputSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: 'Platform slug. Omit to list all platforms.' },
        },
      },
      handler: (args) => klura.getStrategyHealth({ platform: args.platform }),
    },

    {
      name: 'declare_capability',
      description: 'Declare a capability the agent is about to discover on this session. Call once per capability the user asked for (e.g. "send_message", "search_contact"). `args` is a map `{paramName: literalValue}` of user-supplied values the agent will type (e.g. `{text: "hello", recipient: "Bob"}`). The runtime uses this to partition perform_action history per capability at close_session, and to template captured request bodies into reusable strategies (substituting each arg value with `{{paramName}}`). For single-capability sessions, pass `{capability, args}` to start_session and skip this tool.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          capability: { type: 'string', description: 'Capability slug the agent is about to discover.' },
          args: { type: 'object', description: 'Map of user-supplied literals the agent will type.' },
        },
        required: ['session_id', 'capability'],
      },
      handler: (args) => klura.declareCapability({
        session_id: args.session_id,
        capability: args.capability,
        args: args.args,
      }),
    },

    {
      name: 'explain_ws_frame_structure',
      description: 'Structural explainer for a captured WebSocket frame. One call returns: (1) detected wire protocol — `mqtt_publish`, `protobuf_unary`, `grpc_web`, `thrift_compact`, `json`, or `raw`; (2) for JSON-like envelopes, a parse tree with depth-1 keys, a pretty-printed preview (≤ 2KB), and json-path locations of any `text_anchor` you supply (the typed literal you want to parameterize); (3) nested-JSON-string detection: an outer envelope whose `payload` field is itself stringified JSON); (4) a `hints` array explaining what the bytes are and how to reconstruct a frame. Use this at the START of a binary-WS reverse-engineering attempt — it replaces ~20 rounds of hand-walking `inspect_ws_frame(format:"utf8", offset:N, length:M)` with one structured view.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          ws_i: { type: 'number', description: 'Positional index into captured ws frames (fragile — rotates).' },
          ws_hash: { type: 'string', description: 'Content-addressed stable handle. Preferred.' },
          text_anchor: { type: 'string', description: 'Optional literal (e.g. the typed message) — returned json-path locations tell you where to parameterize.' },
        },
        required: ['session_id'],
      },
      handler: (args) => klura.explainWsFrameStructure({
        session_id: args.session_id,
        ws_i: args.ws_i,
        ws_hash: args.ws_hash,
        text_anchor: args.text_anchor,
      }),
    },

    {
      name: 'add_discovery_note',
      description: 'Drop a typed, prose-length hint for the next session to read from the discovery artifact. Unlike `add_resume_pointer` (pointers to bytes at specific offsets), notes carry reasoning — function hints, module paths, field-rotation rules, byte-layout observations, open questions. Next session\'s agent reads these inline in `list_platform_skills.discovery_artifact.notes` and picks up where you left off. When reverse-engineering a complex send, drop a note whenever you confirm something non-obvious: "appId is sourced from meta[name=app_id]", "epoch_id = (Date.now() << 22) | random22", "sync tasks use label 46 for SendMessage, label 21 for MarkRead", etc. Cap 20 entries per capability.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          capability: { type: 'string', description: 'Capability slug this note applies to.' },
          kind: {
            type: 'string',
            enum: ['function_hint', 'module_path', 'field_rotation', 'byte_layout', 'verified_expression', 'open_question', 'user_declined_send', 'other'],
            description: 'Descriptive category. `function_hint`: "the encoder appears to be at window.X.Y". `module_path`: webpack/require path confirmed. `field_rotation`: how a session-scoped field changes per send. `byte_layout`: wire-format breakdown. `verified_expression`: a string-form note about an expression that worked (pair with `save_verified_expression` for the runnable form). `open_question`: something you didn\'t have time to confirm. `other`: catch-all.',
          },
          body: { type: 'string', description: 'The note body (≤ 500 chars). Prose, not code. Structural claims — no pasted tokens.' },
          verified: { type: 'boolean', description: 'True when the claim has been confirmed via js_eval / try_generator / similar. Resets the hardness-check counter.' },
        },
        required: ['session_id', 'capability', 'kind', 'body'],
      },
      handler: (args) => klura.addDiscoveryNote({
        session_id: args.session_id,
        capability: args.capability,
        kind: args.kind,
        body: args.body,
        verified: args.verified,
      }),
    },

    {
      name: 'save_verified_expression',
      description: 'Persist an expression the agent has confirmed works this session. The runtime evaluates the expression once via `evaluateExpression` (with the same hex-wrapping as `js_eval`) to confirm it doesn\'t throw and matches the declared `returns` shape; only then does it land in the discovery artifact. Next session reads these from `list_platform_skills.discovery_artifact.verified_expressions` and can try them first instead of re-deriving. For WS sends, a successful `try_generator_in_page` result is typically the expression you save here. Cap 5 entries per capability; expressions referencing {{paramName}} placeholders must list them in `binds_args`.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          capability: { type: 'string' },
          expression: { type: 'string', description: 'JS expression (≤ 2048 chars). Interpolated with {{args}} placeholders at future reuse time.' },
          binds_args: { type: 'array', items: { type: 'string' }, description: 'Names of declared args the expression references via {{name}}. Empty array allowed when the expression is parameter-free (rare).' },
          returns: { type: 'string', enum: ['hex', 'base64', 'string', 'object'], description: 'Declared return shape. `hex` / `base64` trigger a decode check after eval.' },
          sample_byte_length: { type: 'number', description: 'Optional — byte length the expression produced on the test run. Useful for next-session sanity checks.' },
          notes: { type: 'string', description: 'Optional prose context (≤ 200 chars).' },
        },
        required: ['session_id', 'capability', 'expression', 'binds_args', 'returns'],
      },
      handler: (args) => klura.saveVerifiedExpression({
        session_id: args.session_id,
        capability: args.capability,
        expression: args.expression,
        binds_args: args.binds_args,
        returns: args.returns,
        sample_byte_length: args.sample_byte_length,
        notes: args.notes,
      }),
    },

    {
      name: 'search_js_source',
      description: 'Substring-search a JS script the page already loaded. Returns `{line, column, preview}` for each hit (max 100). Line numbers are raw-source coordinates matching `Error.stack` and `get_js_source({line})`. Use to find encoder call sites: search for protocol literals observed in captured bytes (e.g. `"/ls_req"`, `"encodeSend"`, a field name from the envelope JSON). Literal-substring only — no regex; run multiple searches when needed.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          url: { type: 'string', description: 'Script URL the page loaded.' },
          pattern: { type: 'string', description: 'Literal substring (≤ 500 chars).' },
          case_sensitive: { type: 'boolean', description: 'Default true.' },
          max_matches: { type: 'number', description: 'Default 20, max 100.' },
        },
        required: ['session_id', 'url', 'pattern'],
      },
      handler: (args) => klura.searchJsSourceTool({
        session_id: args.session_id,
        url: args.url,
        pattern: args.pattern,
        case_sensitive: args.case_sensitive,
        max_matches: args.max_matches,
      }),
    },

    {
      name: 'read_js_function',
      description: 'Given a line inside a JS source, extract the enclosing function: name, params, start/end line, body preview (default 2000 chars cap). Handles `function(...)`, `function name(...)`, and arrow functions. Use after `search_js_source` finds a candidate call site — read ONE function instead of windowing source with guessed line ranges.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          url: { type: 'string' },
          line: { type: 'number', description: 'Raw-source line (1-indexed).' },
          max_body_chars: { type: 'number', description: 'Default 2000.' },
        },
        required: ['session_id', 'url', 'line'],
      },
      handler: (args) => klura.readJsFunctionTool({
        session_id: args.session_id,
        url: args.url,
        line: args.line,
        max_body_chars: args.max_body_chars,
      }),
    },

    {
      name: 'list_loaded_scripts',
      description: 'List every JS script URL the page loaded, observed via the captured network log. Filtered to JS content-types, deduped, in load order. Use when the `inspect_ws_frame.js_callstack` bundle turns out not to contain the encoder — widen the search to other bundles.',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
      },
      handler: (args) => klura.listLoadedScriptsTool({ session_id: args.session_id }),
    },

    {
      name: 'js_eval',
      description: 'Evaluate a JS expression inside the live page and return the result. Binary values (ArrayBuffer, Uint8Array) come back as hex strings automatically — no JSON-serialization holes. Strings, numbers, and plain objects pass through. Use this to probe the page during discovery: verify globals exist, inspect module registries, call encoder functions with sample args, compare output byte lengths against captured frames. This is the primary reverse-engineer probe — pair it with `search_js_source` + `read_js_function` + `get_js_source` to locate and verify the encoder path before committing to a `frameFromPage` strategy. Blocked in `execute_only` sessions (warm-measurement mode). Timeout default 5000ms, max 30000. Expression cap 4096 chars.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          expression: { type: 'string', description: 'JS expression. Async OK (runtime awaits).' },
          timeout_ms: { type: 'number', description: 'Max wall-clock ms. Default 5000, max 30000.' },
        },
        required: ['session_id', 'expression'],
      },
      handler: (args) => klura.jsEval({
        session_id: args.session_id,
        expression: args.expression,
        timeout_ms: args.timeout_ms,
        result_offset: args.result_offset,
        result_length: args.result_length,
      }),
    },

    {
      name: 'install_page_init_script',
      description: 'Install a JS expression that runs on every fresh document — before the page\'s own bundle, on every navigation. Wraps Playwright `addInitScript` (CDP `Page.addScriptToEvaluateOnNewDocument`). Canonical use: monkey-patch `window.fetch` / `XMLHttpRequest` for capture-on-real-send during RE on SPA sites where a one-shot `js_eval` patch would be stomped when the bundle re-runs after navigation. The agent\'s wrapper runs first; the page\'s own wrappers wrap the agent\'s, so the agent gets visibility into every send across navigations. Returns `{handle}` for `remove_page_init_script`. See klura://reference#reverse-engineer-playbook for the canonical fetch-wrapper template. Blocked in execute_only mode. Expression cap 4096 chars.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          expression: { type: 'string', description: 'JS expression to run on every fresh document. Wrapped in an async IIFE; runs once per page bootstrap.' },
        },
        required: ['session_id', 'expression'],
      },
      handler: (args) => klura.installPageInitScript({
        session_id: args.session_id,
        expression: args.expression,
      }),
    },

    {
      name: 'remove_page_init_script',
      description: 'Disable a previously-installed page init script by handle. Best-effort: Playwright does not expose a removal API on `addInitScript`, so the runtime adds the handle to a session-scoped removed-set; the wrapper checks this set on every navigation and short-circuits. Already-running wrappers in the current page also notice via an in-page `__klura_init_removed` set. The init script itself remains installed for the browser context\'s lifetime, but its body is a no-op once removed.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          handle: { type: 'string', description: 'Handle returned from `install_page_init_script`.' },
        },
        required: ['session_id', 'handle'],
      },
      handler: (args) => klura.removePageInitScript({
        session_id: args.session_id,
        handle: args.handle,
      }),
    },

    {
      name: 'set_breakpoint',
      description: 'Set a CDP source-location breakpoint. `file` is a script URL as reported by `inspect_ws_frame.js_callstack.frames[].file` or `list_loaded_scripts`; `line` and optional `column` are the CDP coordinates. Optional `condition` is a JS expression evaluated at the candidate pause — execution only pauses when it is truthy. Returns `breakpoint_id` (pass to remove_breakpoint) and `resolved_location` reporting where CDP actually placed the bp (line numbers can shift to the nearest executable statement). Escalation tool for the RE path — use when the "paused closure" approach is shorter than hand-reading a minified bundle: set the bp at the WebSocket.send site, re-trigger the flow with perform_action, call wait_for_pause, then read the encoder out of the paused scope chain. Max 10 active bps per session; conditions capped at 512 chars. Blocked in execute_only mode. Requires the playwright driver.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          file: { type: 'string', description: 'Script URL to break in (exact match, as CDP reports).' },
          line: { type: 'number', description: '0-indexed line number (CDP convention).' },
          column: { type: 'number', description: '0-indexed column; omit for line-start.' },
          condition: { type: 'string', description: 'JS expression evaluated at the pause candidate. Only truthy values pause execution. ≤ 512 chars.' },
        },
        required: ['session_id', 'file', 'line'],
      },
      handler: (args) => klura.setBreakpointTool({
        session_id: args.session_id,
        file: args.file,
        line: args.line,
        column: args.column,
        condition: args.condition,
      }),
    },

    {
      name: 'remove_breakpoint',
      description: 'Remove an active breakpoint by id. Idempotent — removing an unknown/already-removed id is a no-op. Use when you are done with a bp, or call close_session and the runtime will clean up automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          breakpoint_id: { type: 'string' },
        },
        required: ['session_id', 'breakpoint_id'],
      },
      handler: (args) => klura.removeBreakpointTool({
        session_id: args.session_id,
        breakpoint_id: args.breakpoint_id,
      }),
    },

    {
      name: 'list_breakpoints',
      description: 'List every active breakpoint on this session, with id, resolved location (file/line/column), and condition if any. Use to introspect after a flaky pause or to verify a bp landed where you expected.',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
      },
      handler: (args) => klura.listBreakpointsTool({ session_id: args.session_id }),
    },

    {
      name: 'wait_for_pause',
      description: 'Block until the page hits a breakpoint or `timeout_ms` elapses. Does NOT resume — the page stays paused so you can inspect the frame. Response shape on a hit: `{hit: true, reason, breakpoint_ids, call_frames: [{frame_index, location, function_name, function_source_preview, scope_chain}]}`. `scope_chain[]` is a shallow list of scope types (`local`, `closure`, `global`) with preview strings — drill deeper with `get_frame_scope`. On timeout: `{hit: false, reason: "timeout", call_frames: []}`. Queues up to 5 unread pauses; the 6th drops the oldest. Only one outstanding wait per session — calling a second time while the first is in flight throws `already_waiting`. Default timeout 10000, max 60000.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          timeout_ms: { type: 'number', description: 'Max wall-clock ms. Default 10000, max 60000.' },
        },
        required: ['session_id'],
      },
      handler: (args) => klura.waitForPauseTool({
        session_id: args.session_id,
        timeout_ms: args.timeout_ms,
      }),
    },

    {
      name: 'get_frame_scope',
      description: 'Dump one scope of one paused call frame as a shallow property list. Pick the scope by `scope_type` (first match wins: `local`, `closure`, `global`, `block`, `catch`, `with`, `module`) OR by `scope_index` into the frame\'s scope_chain. Returns `{properties: [{name, type, preview, has_children}]}` capped at 200 entries (sets `truncated: true` over the cap). For the closure scope at the WebSocket.send site, `properties[]` typically contains the encoder function, the original args, and any buffered channel state — exactly what you need to save as a verified expression. Drill into nested objects with `evaluate_on_frame(frame_index, "name.of.thing")`. Session must be paused.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          frame_index: { type: 'number', description: '0-indexed into the paused call_frames.' },
          scope_type: { type: 'string', description: 'Pick scope by type (first match). One of: local, closure, global, block, catch, with, module.' },
          scope_index: { type: 'number', description: 'Alternative to scope_type — 0-indexed into scope_chain.' },
        },
        required: ['session_id', 'frame_index'],
      },
      handler: (args) => klura.getFrameScopeTool({
        session_id: args.session_id,
        frame_index: args.frame_index,
        scope_type: args.scope_type,
        scope_index: args.scope_index,
      }),
    },

    {
      name: 'evaluate_on_frame',
      description: 'Run arbitrary JS in the paused frame\'s context — DevTools-console-on-a-paused-frame. Backed by CDP `Debugger.evaluateOnCallFrame`, so the expression sees the frame\'s locals and closure-captured variables directly (unlike js_eval which runs at global scope). Typical uses: `JSON.stringify(arguments)` to snapshot the exact call args, `encodeSend.toString()` to read the encoder source, `this.__channel` to reach instance state. **Call `get_frame_scope(frame_index)` first** — the names and shapes of what\'s in scope depend on where the breakpoint landed (locals may be minified, `arguments[0]` may not be the payload you expect, `this` may be undefined in arrow bodies). Reading scope first avoids the "undefined.byteLength" class of error. Result is string-serialized (`result` on ok, `error` on throw). Execution is sync against the frozen page — no async IIFE wrap. Session must be paused. Expression cap 4096 chars; timeout default 5000, max 30000.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          frame_index: { type: 'number' },
          expression: { type: 'string' },
          timeout_ms: { type: 'number' },
        },
        required: ['session_id', 'frame_index', 'expression'],
      },
      handler: (args) => klura.evaluateOnFrameTool({
        session_id: args.session_id,
        frame_index: args.frame_index,
        expression: args.expression,
        timeout_ms: args.timeout_ms,
        result_offset: args.result_offset,
        result_length: args.result_length,
      }),
    },

    {
      name: 'step',
      description: 'Advance a paused execution by one step. `mode` is `over` (execute current line, pause at next), `into` (descend into a function call), or `out` (run to the end of the current function). Returns `{paused_at: {file, line, column, function_name}}` on the next pause, or `{done: true}` when execution resumes without pausing again within 5s. Session must be paused.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          mode: { type: 'string', enum: ['over', 'into', 'out'] },
        },
        required: ['session_id', 'mode'],
      },
      handler: (args) => klura.stepTool({ session_id: args.session_id, mode: args.mode }),
    },

    {
      name: 'resume',
      description: 'Release the current pause and let the page continue. No-op when the session isn\'t paused. Use after you have extracted everything you need from the paused frame. close_session also auto-resumes, so in practice this tool is optional if you are about to close.',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
      },
      handler: (args) => klura.resumeTool({ session_id: args.session_id }),
    },

    {
      name: 'add_resume_pointer',
      description: 'Record a forward-looking pointer on this session for `capability` — an intention the next run should read when deciding where to resume discovery. `kind` is one of: `js_source` (URL of a script to read; pair with `line` for a specific offset), `request_index` (captured HTTP request index), `frame_index` (captured WS frame index), `page_url` (a page worth re-visiting), `other` (free-form). `ref` carries the kind-specific reference string. Use when you identified a productive next step but the current session ran out of budget — the pointer lands on the capability\'s discovery artifact and the next session sees it inline in list_platform_skills / start_session / execute responses. Works even when no save_strategy succeeded this session.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          capability: { type: 'string', description: 'Capability slug this pointer applies to.' },
          kind: { type: 'string', enum: ['js_source', 'request_index', 'frame_index', 'page_url', 'other'] },
          ref: { type: 'string', description: 'The reference string; shape depends on `kind`.' },
          line: { type: 'number', description: 'Only valid when kind === "js_source" — the 1-indexed line.' },
          note: { type: 'string', description: 'Short disambiguation note (≤ 120 chars).' },
        },
        required: ['session_id', 'capability', 'kind', 'ref'],
      },
      handler: (args) => klura.addResumePointer({
        session_id: args.session_id,
        capability: args.capability,
        kind: args.kind,
        ref: args.ref,
        line: args.line,
        note: args.note,
      }),
    },

    {
      name: 'get_discovery_artifact_field',
      description: 'Fetch a single named field from an on-disk discovery artifact when `list_platform_skills` / `start_session` / `execute` elided it due to the MCP output budget. Check the `_elided_fields` marker on the inlined artifact to see which fields to request via this tool. Mirrors `get_network_log {full: true}`: default responses stay inside the budget, you opt into detail on demand. `field` is one of: `tool_call_trace`, `observations`, `resume_pointers`, `recommended_next_steps`.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string' },
          capability: { type: 'string' },
          field: { type: 'string', enum: ['tool_call_trace', 'observations', 'resume_pointers', 'recommended_next_steps'] },
        },
        required: ['platform', 'capability', 'field'],
      },
      handler: (args) => klura.getDiscoveryArtifactField({
        platform: args.platform,
        capability: args.capability,
        field: args.field,
      }),
    },

    {
      name: 'get_strategy',
      description: 'Return the full body of a previously-saved strategy — including `generated.<name>.code` and the complete `notes` block — so you can inspect a saved skill in detail. `list_platform_skills` only returns a summary; this is the detail-on-demand tool. Prior-discovery continuation context (verified expressions, envelope notes, resume pointers) lives in the capability\'s discovery_artifact, not in the strategy body — fetch it via `get_discovery_artifact_field` or read the inline block on close_session\'s LIFT handoff (`triage[<cap>].discovery_artifact`). Ordering: if `tier` is omitted, returns the highest-tier saved strategy. Returns the raw strategy object, or `null` if none exists.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: 'Platform name (e.g. "chat-app")' },
          capability: { type: 'string', description: 'Capability name (e.g. "send_message")' },
          tier: { type: 'string', enum: ['fetch', 'page-script', 'recorded-path'], description: 'Optional: fetch a specific tier. Omit to use the default ordering (highest-tier saved strategy).' },
        },
        required: ['platform', 'capability'],
      },
      handler: (args) => klura.getStrategy({
        platform: args.platform,
        capability: args.capability,
        tier: args.tier,
      }),
    },

    {
      name: 'get_platform_logbook',
      description: 'Return the platform working-dir summary: per-capability lift history, cross-session data sufficiency, field-stability classifier output, bundle-drift events, signer-anchor history, AND `known_modules` (in-page module / global names referenced by the platform\'s saved strategies — extract source is lexical, so if `LSMqttChannel` appears in a saved `require(...)` call, it\'s listed here as `{name:"LSMqttChannel", source:"require", used_by:["send_message", ...]}`). Use at close_session / LIFT entry to see "how much do we already know about this platform?" — BEFORE enumerating training-prior module name guesses at `js_eval`, probe the names in `known_modules` first; those are the identifiers the page actually exposed in prior successful lifts. Pass `capability` to narrow the payload to one capability.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string' },
          capability: { type: 'string', description: 'Optional capability slug to narrow.' },
        },
        required: ['platform'],
      },
      handler: (args) => klura.getPlatformLogbook({
        platform: args.platform,
        capability: args.capability,
      }),
    },

    {
      name: 'get_strategy_events',
      description: 'Return strategy life-cycle events for a platform, most recent first. Events are appended whenever a saved strategy is mutated: `discovered` / `rediscovered` on save, `tier_demote` on persistent transport failure, `archived` / `unarchived` on manual reset, `patched` on step patch, `healed` when a broken strategy recovers. Pass `capability` to narrow; pass `limit` to cap the slice (default 50). Use to answer "what changed about this skill lately?" without loading the full logbook.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string' },
          capability: { type: 'string', description: 'Optional capability slug to narrow.' },
          limit: { type: 'number', description: 'Max events to return (default 50).' },
        },
        required: ['platform'],
      },
      handler: (args) => klura.getStrategyEvents(args.platform, args.capability, args.limit),
    },

    {
      name: 'record_observed_capability',
      description: 'Record a companion capability you noticed during discovery but didn\'t lift as its own saved strategy. Persists to the platform logbook under `observed_capabilities[]`. Next run\'s `list_platform_skills` surfaces these so the next agent sees known unfinished candidates and can lift them. Dedup-by-name: re-observing updates `last_observed_at` and bumps `observed_in_sessions` once per session.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string' },
          name: { type: 'string', description: 'Canonical capability name, slug-shaped (≤60 chars, snake_case). e.g. "lookup_thread_by_name".' },
          evidence: {
            type: 'object',
            description: 'Evidence pointer. Must include `source` (e.g. "network" or "ui"); carry whatever source-specific fields help the next agent re-find the observation (endpoint, request_i, ws_i, ui_selector, ui_hint, etc.).',
            properties: { source: { type: 'string', description: 'Where the observation came from — "network", "ui", or another descriptor.' } },
            required: ['source'],
          },
          why_not_lifted: { type: 'string', description: 'One of: "separate_capability", "turn_budget", "unverified", "blocked", "other".' },
          hypothesis: { type: 'string', description: 'Optional structural prose (≤800 chars) — describe what the endpoint does, not the bytes it returned.' },
          session_id: { type: 'string', description: 'Optional current session id; repeat calls within the same session only bump `observed_in_sessions` once.' },
        },
        required: ['platform', 'name', 'evidence', 'why_not_lifted'],
      },
      handler: (args) => klura.recordObservedCapability({
        platform: args.platform,
        name: args.name,
        evidence: args.evidence,
        why_not_lifted: args.why_not_lifted,
        hypothesis: args.hypothesis,
        session_id: args.session_id,
      }),
    },

    {
      name: 'start_remote_session',
      description: 'Start a remote viewer so the user can see and interact with the browser. Returns `{viewerUrl, _hint}` — render `viewerUrl` verbatim in chat (it carries a JWT, any retype/edit/abbreviation breaks the signature). Use when you hit a gate you cannot pass (captcha, bot detection, QR code). Also invoked transparently at execute time by `strategy.interrupts[]` entries whose handler is `user-assist` — those fire the viewer on an existing warm session without an explicit tool call.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          prompt: {
            type: 'string',
            description: 'Goal the user needs to complete, shown in the viewer header for the entire session. Describe the goal, not the current obstacle — the user may hit captcha → image challenge → login → 2FA in sequence and needs to see the goal through to the end. Good: "Log in to your account", "Complete the payment", "Connect your account", "Verify your identity". Bad: "Solve the captcha", "Tick the checkbox", "Enter the 2FA code" (too step-specific). The runtime appends ", then press Done or tell me in chat" automatically — leave that off.',
          },
        },
        required: ['session_id'],
      },
      handler: (args) => klura.startRemote(args.session_id, { prompt: args.prompt }),
    },

    {
      name: 'stop_remote_session',
      description: 'Stop a remote viewer session.',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
      },
      handler: (args) => klura.stopRemote(args.session_id),
    },

    {
      name: 'wait_for_remote',
      description: 'Block until the user clicks Done in the remote viewer. Call this immediately after start_remote_session instead of a bash polling loop. Returns {done: true} when the user clicks Done, or {done: false, reason: "timeout"} if they did not respond in time.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          timeout_seconds: { type: 'number', description: 'How long to wait (default 600)' },
        },
        required: ['session_id'],
      },
      handler: (args) => klura.waitForRemote(args.session_id, { timeoutSeconds: args.timeout_seconds }),
    },

    {
      name: 'start_listener',
      description: 'Start a real-time event listener (WebSocket, SSE, or HTTP polling). Requires a saved listener strategy. Returns a listenerId for polling events.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: 'Platform name (e.g. "chat-app")' },
          capability: { type: 'string', description: 'Listener capability (e.g. "on_new_message")' },
          args: { type: 'object', description: 'Arguments (e.g. {"userId": "alice"})' },
        },
        required: ['platform', 'capability'],
      },
      handler: (args) => klura.startListener(args.platform, args.capability, args.args || {}),
    },

    {
      name: 'stop_listener',
      description: 'Stop a running event listener.',
      inputSchema: {
        type: 'object',
        properties: { listener_id: { type: 'string' } },
        required: ['listener_id'],
      },
      handler: (args) => klura.stopListener(args.listener_id),
    },

    {
      name: 'get_events',
      description: 'Get events received by active listeners. Paginated — default 20 events per page, max 100. Per-event `data` field is truncated to 1KB with `data_truncated: true` + `data_total_chars` markers when longer. Response shape: `{events, page, page_size, total, has_more}`. Without `since`, returns (and clears) the full queue. With `since` (timestamp ms), returns events after that time without clearing.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'number', description: 'Only return events after this timestamp (ms)' },
          page: { type: 'number', description: '1-indexed page number. Default 1.' },
          page_size: { type: 'number', description: 'Events per page. Default 20, max 100.' },
        },
      },
      handler: (args) => klura.getEvents(args.since, args.page, args.page_size),
    },

    {
      name: 'patch_step',
      description: 'Patch a single step in a recorded-path strategy by its stable slug id. Use for step-level healing when execution fails at a specific step — update the locators, action, or value without rewriting the whole strategy. Steps carry a required `id` field (e.g. "click_send", "type_message"); pass that id as `step_id`. 404 error names the known ids in the strategy.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string' },
          capability: { type: 'string' },
          strategy_type: { type: 'string', description: 'Strategy type (e.g. "recorded-path")' },
          step_id: { type: 'string', description: 'Slug id of the step to patch (matches the `id` field on the recorded-path step, e.g. "click_send"). See klura://reference#recorded-path-schema.' },
          patch: { type: 'object', description: 'Fields to merge into the step (e.g. {"locators": {"css": "button.new-class"}})' },
        },
        required: ['platform', 'capability', 'strategy_type', 'step_id', 'patch'],
      },
      handler: (args) => klura.patchStep(args.platform, args.capability, args.strategy_type, args.step_id, args.patch),
    },

    {
      name: 'resume_execution',
      description: 'Resume a paused recorded-path execution from the step after the last failure. Use after patching the failed step.',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
      },
      handler: (args) => klura.resumeExecution(args.session_id),
    },

    {
      name: 'get_config',
      description: 'Read the current klura runtime config (the merged ~/.klura/config.json, with defaults filled in). Returns the full DaemonConfig object — pool settings, driver, warm-pool, remote viewer, runtime boot fields, etc.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => klura.getConfig(),
    },

    {
      name: 'describe_config',
      description: 'List every tunable config field with its type, valid values, default, and whether it needs a runtime restart to take effect. Call this before `configure` so you know the exact dot-path and what values are allowed — it prevents hallucinated field names. Returns `{fields: [{path, type, enum?, range?, default, description, needsRestart}], current}`.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => klura.describeConfigTool(),
    },

    {
      name: 'configure',
      description: 'Set a single klura config field by dot-path. Example: `{path: "pool.driver", value: "playwright-stealth"}` to enable the stealth driver, or `{path: "pool.headful", value: true}` to show a visible browser window. Call `describe_config` first if you are unsure of the path or valid values. Returns `{config, changed, runtime_restart_required, runtime_restart_fields, suggested_user_prompt}`. When `runtime_restart_required` is true, relay `suggested_user_prompt` to the user as an assistant text turn and wait for their yes/no before calling `restart_runtime`.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Dot-path of the config field, e.g. "pool.driver" or "pool.warm.enabled".' },
          value: { description: 'New value. String, number, or boolean depending on the field type (see describe_config).' },
        },
        required: ['path', 'value'],
      },
      handler: (args) => klura.configureSetting({ path: args.path, value: args.value }),
    },

    {
      name: 'restart_runtime',
      description: 'Restart the klura runtime so boot-time config (runtime.listen, runtime.idleTimeout) takes effect. Refuses if any sessions are active unless `force: true` (which will kill them). After restart, the runtime auto-respawns on your next tool call — expect a ~1s delay.',
      inputSchema: {
        type: 'object',
        properties: { force: { type: 'boolean', description: 'Kill any active sessions and restart anyway.' } },
      },
      handler: (args) => klura.restartRuntime({ force: args.force }),
    },

    {
      name: 'list_interruption_resolvers',
      description: 'List registered interruption-handlers as `{name, description}` — the menu for agent-detected ambient page state (CAPTCHA, auth wall, 2FA prompt). Scope: AGENT-DETECTED only. Runtime-emitted events arrive as `_checkpoint` (ack via `ack_checkpoint`), NOT through this menu. Do not route dismissable UI noise (cookie banners, popups) through this surface — click those away yourself. See klura://reference#interruptions.',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'Optional. Reserved for future session-scoped filtering; ignored today.' } },
      },
      skipInterruptionGate: true,
      handler: (args) => klura.listInterruptionResolvers({ session_id: args.session_id }),
    },

    {
      name: 'resolve_interruption',
      description: 'Invoke a registered interruption handler by name. Scope: AGENT-DETECTED ambient page state (CAPTCHA / 2FA / auth-wall / login-form). Build context including a `reason` string matching handler-description phrasing (e.g. `{reason: "captcha_challenge", sitekey: "..."}`). Runtime-emitted checkpoints route via `_checkpoint` + `ack_checkpoint`, NOT this tool. Response: `{resolution: {status: "resolved"|"handover"|"continue", ...}, interruption_token?}`. On `handover` the next tool call must echo `interruption_token` + an ack (`user_response` / `viewer_result`) or `{cancelled: true, reason}`; otherwise subsequent calls reject with `invalid_strategy: pending_interruption`. Unknown resolver names throw `invalid_strategy: unknown resolver "<name>"`. See klura://reference#interruptions.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          resolver: { type: 'string', description: 'Name of a registered handler — one of the `candidates[].name` from `_interruption` OR `list_interruption_resolvers()`.' },
          context: { type: 'object', description: 'Event context. For runtime-initiated interruptions: echo back the `_interruption.context` verbatim. For agent-initiated: build a fresh object including a `reason` string that matches handler descriptions (e.g. `{reason: "captcha_challenge", sitekey: "...", iframe_src: "..."}`).' },
          capability: { type: 'string', description: 'Optional capability slug relevant to this event.' },
        },
        required: ['session_id', 'resolver', 'context'],
      },
      skipInterruptionGate: true,
      handler: (args) => klura.resolveInterruption({
        session_id: args.session_id,
        resolver: args.resolver,
        context: args.context,
        capability: args.capability,
      }),
    },

    {
      name: 'ack_checkpoint',
      description: `Acknowledge a runtime-emitted checkpoint. When a tool response carries \`_checkpoint: {kind, prompt?, viewer_url?, checkpoint_token}\`, runtime paused at a known lifecycle boundary and a handler returned \`handover\`. Echo \`checkpoint_token\` + the ack that matches the target: \`user_response: "<reply>"\` for text-turn checkpoints, \`viewer_result: {...}\` for viewer-handover checkpoints after the user completed the action in the viewer, OR \`{cancelled: true, reason: "..."}\` to abandon. Current checkpoint kinds and post-ack hints:\n${checkpointAckTable}\nWithout an ack, every other tool call on the session rejects with \`invalid_strategy: pending_checkpoint\`. See klura://reference#checkpoints.`,
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          checkpoint_token: { type: 'string', description: 'Token from the `_checkpoint` envelope on the prior tool response.' },
          user_response: { type: 'string', description: 'The user\'s reply for text-turn checkpoints (triage_plan, surface_changed, post_save_validation_consent).' },
          viewer_result: { type: 'object', description: 'Structured result for viewer-handover checkpoints (recorded_step_failed, session_expired) after the user completed the action in the viewer.' },
          cancelled: { type: 'boolean', description: 'Set true to abandon the checkpoint. Requires `reason`.' },
          reason: { type: 'string', description: 'When `cancelled:true`, a one-sentence reason for abandoning.' },
        },
        required: ['session_id', 'checkpoint_token'],
      },
      skipCheckpointGate: true,
      handler: (args) => klura.ackCheckpoint({
        session_id: args.session_id,
        checkpoint_token: args.checkpoint_token,
        user_response: args.user_response,
        viewer_result: args.viewer_result,
        cancelled: args.cancelled,
        reason: args.reason,
      }),
    },

    {
      name: 'get_secret',
      description: 'Fetch a secret from a configured shell-command resolver (macOS keychain, 1password CLI, pass, etc). Use during discovery when you hit a login form and the user has a password manager resolver configured — fetch the password with `get_secret(scheme, ref)` and type it into the form instead of escalating to the remote viewer. The response value is the raw secret; pass it directly to `perform_action({action: "type", selector: "input[type=password]", value})` and **never log, persist, or echo it**. If no resolver is configured for `scheme`, this throws with a setup hint — fall back to `start_remote_session` in that case. Call `get_config` first to see the `secrets` map (scheme → command template) so you know which schemes are configured; ask the user in chat once per platform per session for the `ref` if you don\'t already know it (never guess — wrong guesses are a silent exfil risk).',
      inputSchema: {
        type: 'object',
        properties: {
          scheme: { type: 'string', description: 'Resolver name as configured via `klura secret add <scheme>`. Common schemes: "keychain" (macOS), "op" (1password CLI), "pass" (passwordstore).' },
          ref: { type: 'string', description: 'Per-scheme key. Keychain: the service name (e.g. "klura-<platform>"). 1password: a vault/item path (e.g. "<platform>/password"). Ask the user in chat if unclear — do not guess.' },
        },
        required: ['scheme', 'ref'],
      },
      handler: (args) => klura.getSecret(args.scheme, args.ref),
    },
  ];
};
