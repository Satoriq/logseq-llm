# Logseq AI: plan v0.2

## Decisions log

| Date | Decision |
|---|---|
| 2026-11-03 | Panel is **injected into Logseq's DOM**, not shown as a plugin iframe (§4.3). |
| 2026-11-03 | The bridge targets **Node 26** and is written in **TypeScript run directly by Node** (type stripping, no build step). It has no runtime dependencies. |
| 2026-11-03 | Transport stays **HTTP + SSE**. Node 26 adds WebSocket masking helpers but still has no WebSocket server (§4.2). |
| 2026-11-03 | Q4 allow/deny defaults accepted as proposed (§3). |
| 2026-11-03 | Everything in §6 is approved. The plugin uses the official **`@logseq/libs`** and the same build setup as logseq-panes-mode: webpack 5 + ts-loader + TypeScript 5, with CSS imported as strings. **Version still to confirm:** panes-mode uses `^0.0.17` (npm `latest`); the proposal is exact `0.3.4` (§6). |
| 2026-11-03 | Reference read so far: panes-mode's public repo and its `logseqAPI.instructions.md`. Still missing: the other git-ignored `.github/instructions/*.instructions.md` files (project context, DOM notes). |
| 2026-11-03 | **Coding waits** for your go-ahead. |
| 2026-11-03 | Bridge tokens live in `secrets/tokens.json` (0600, in the 0700 data dir), not the Keychain. The plugin's copy sits in Logseq's plain-text plugin settings anyway, and writing to the Keychain with the `security` command would put the token in process arguments. API keys (step 4) go in the Keychain. |
| 2026-11-03 | Step 1 is split into 1a, 1b and 1c so each part can be tested on its own. |
| 2026-11-03 | `@logseq/libs` pinned to exactly **0.3.4** (npm tag `next`), installed with `npm install --save-exact @logseq/libs@0.3.4`. |
| 2026-11-03 | Sandbox graph "AI Sandbox" created and set as `graph` in config.json. |
| 2026-11-03 | Graph reads use **only `query` with the bridge's own pull patterns** (plus `search`/`list` for ids). `show` is not used, because its output omits user properties. Property and tag idents carry random suffixes, so rules match by title. The value blocks Logseq creates for text properties (`created-from-property`) are skipped. |
| 2026-11-03 | Unknown `ai-access` values hide the block (fail closed), and so do blocks whose page can't be resolved. A hidden page answers like a missing page. |
| 2026-11-03 | `claude -p` runs **one process per turn** and continues the chat with `--resume`; that's simpler and cheaper on battery than a long-lived process. Input goes in on stdin (`--input-format text`), so prompts aren't visible in `ps`. The bridge strips `ANTHROPIC_API_KEY` from the child environment and warns if `apiKeySource` isn't `none`. |
| 2026-11-03 | When a chat switches into Claude, the bridge passes along the user's messages and earlier cloud replies only. Replies from local models stay local until the step-5 consent card exists. |
| 2026-11-03 | Plugin build: webpack 5.111.1, webpack-cli 7.2.3, ts-loader 9.6.2, TypeScript 5.9.3, `@logseq/libs` 0.3.4. All pinned exactly with a lockfile and installed with `--ignore-scripts`; none of them has install scripts. Newer webpack releases were skipped because they were under two weeks old. |
| 2026-11-03 | The panel's fallback transport, if the iframe can't fetch 127.0.0.1, is `logseq.Net.request`. Logseq makes the request itself, and events are long-polled. Top and bottom placements float over the page; left and right are flex children of `#app-container`. Panel state lives in the plugin's settings, not in `localStorage` (which the plugin shares with the app's origin). Toggle shortcut: ⌘⌥A. |
| 2026-11-03 | The CLI only has `--dry-run` for inserts (`upsert block` in create mode). For updates, tasks, pages and removals, the card is built from a fresh read, and Apply runs the same command. `upsert task` has no `--update-tags`, so the new task is tagged `#AI-GENERATED` in a second command within the same approval. |
| 2026-11-03 | Write-side privacy: the target must be visible to the requesting model, text containing `[hidden]` is refused, `ai-access::` can only be set by the user, and a new page can't match a deny rule. A deletion card lists the full subtree, including blocks hidden from the AI, and warns about them. |
| 2026-11-04 | **Auto-apply, option B:** a per-graph `autoApply` setting (`none` / `additions` / `all`, default `none`); AI Sandbox uses `additions`. Additions (insert_blocks, create_task, create_page) skip the card **only if the card would show no warnings**: no web or image links, no new pages, no links to hidden pages. Edits and deletes always need Apply. Every auto-applied change still leaves a record card in the chat and an audit entry. |
| 2026-11-04 | **Approvals fail fast:** panels subscribe with `caps=approvals`. If no such panel is attached to the chat, a write that needs approval is rejected at once, with a notice, instead of waiting 10 minutes. The panel status line shows the panel and bridge versions. |
| 2026-11-04 | autoApply mode **`own`** (AI Sandbox): additions, plus edits and deletes of blocks the AI created **in the same chat**. Tracked per chat as UUIDs in the chat's metadata, and a deletion qualifies only if the whole subtree is the AI's own. Anything with warnings, or touching your blocks, still gets a card. Edits are batched in one tool, **`update_blocks`** (up to 50, one card). Auto-applied changes show as one compact line with "Show"; card status lines no longer list block ids (only the model gets those). |
| 2026-11-04 | **Apply all (per answer):** a card button that applies this change and auto-applies every further change in the same turn, your blocks included; it's forgotten when the turn ends. Edits and deletes applied without a click wait **2 s** with **Abort**, and batches show progress and can be aborted between items. Cards fold to one line 1 s after they finish; two or more in one answer form a group, "N changes · ✓ · ✗", which folds the same way. Panel and bridge versions are 0.4.0. |
| open | Q5 voice edits, Q6 trigger, Q7 D approval (defaults in §3). |

An AI chat panel inside Logseq DB (desktop, macOS) for personal use. It has a
local Node "bridge", graph tools built on the `logseq` CLI, privacy filtering in
the bridge, and an approval step before every write.

> This repository is **public**. Don't commit personal paths, graph names,
> tokens, chat logs or note content. The bridge keeps all of that under
> `~/Library/Application Support/logseq-ai/`, outside the repo.

Status: research only. No code yet. Researched on 2026-11-03 against:

- Logseq source, `main` branch (commit `25b5ecf`, Nov 3 2026). This is newer
  than the 2.0.2 release, so anything marked "source" needs re-checking on the
  installed app.
- Claude Code 2.1.317 (one patch newer than the target machine's 2.1.316).
- Anthropic's effort and thinking docs, and Claude Code's legal and CLI
  reference pages.
- Ollama's docs sources on GitHub.
- OpenAI and MacWhisper pages could not be fetched from the research
  environment (network policy). Those points are marked **unverified**.

---

## 1. What changed vs. the brief

| Topic | Finding | Source |
|---|---|---|
| Subscription terms | Still hold. "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK." Third parties may not "offer Claude.ai login" or "route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users", or "collect, store, or intermediate" tokens. The terms do not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription." | code.claude.com/docs/en/legal-and-compliance |
| `--permission-prompt-tool` | Exists. It is hidden from `--help` but documented in the CLI reference. We don't need it (see §4.6). | binary + CLI reference |
| New useful flags | `--effort low\|medium\|high\|xhigh\|max`, `--restricted` (drops command/code tools and WebFetch, ignores user/project/local settings; needs ≥ 2.1.248), `--permission-prompts none`, `--disable-slash-commands`, `--tools ""`, and a per-server MCP `timeout` (ms) in `--mcp-config`. | `claude --help`, binary strings |
| `--bare` | **Must not be used.** In bare mode "OAuth and keychain are never read", so the Pro login would not work. | `claude --help` |
| CLI internals | The `logseq` CLI (written in OCaml/Melange) talks to a local **db-worker HTTP server** on 127.0.0.1. It finds the app's own server or starts one. That is why its writes show up live. | `cli/lib/server_runtime.ml`, `transport.ml` |
| Comments / reactions in the CLI | **No comment or reaction command**, and no `--assignee` option. Logseq's own agent toggles the `eyes` reaction through an internal db-worker op (`toggle-reaction`), not through a CLI command. Comments are blocks tagged `logseq.class/Comment` ("Comment") inside a block tagged `logseq.class/Comments`, linked from the target with `logseq.property.comments/blocks`. | `cli/lib/agent.ml`, `deps/db/.../class.cljs` |
| How Logseq's agent finds work | It subscribes to the db-worker's `/v1/events` stream (`sync-db-changes`). It does not poll. A comment matches when it is tagged Comment and contains `[[agent-name]]` or references that page. | `cli/lib/agent.ml` |
| Plugin iframe origin | It depends on how the plugin is installed. Marketplace installs load from `lsp://logseq.io/plugins/...` unless the manifest sets `effect: true`. **Unpacked (dev) plugins load from `lsp://logseq.com/external/...`**, the app's own origin, unless `effect: false`. That's why `parent.document` works, as in logseq-panes-mode. The `lsp:` scheme is registered as standard, secure, CORS-enabled and fetch-capable. **Confirm in DevTools.** | `libs/src/LSPlugin.core.ts`, `src/electron/electron/core.cljs` |
| Ollama context | Default context depends on VRAM: **< 24 GiB → 4k**, 24–48 GiB → 32k, ≥ 48 GiB → 256k. A 24 GB Mac gives the GPU less than 24 GiB, so expect 4k. We set `options.num_ctx` on every request. | ollama `docs/context-length.mdx` |
| Ollama cloud | Cloud tags look like `gemma4:cloud`. There is an official switch: `OLLAMA_NO_CLOUD=1`, or `"disable_ollama_cloud": true` in `~/.ollama/server.json` (it's a settings change, so it needs approval). | ollama `docs/cloud.mdx`, `docs/faq.mdx` |
| `@logseq/libs` on npm | Official (maintainers use `@logseq.com` addresses). **`latest` is the old 0.0.17.** The DB-era SDK is the **`next` tag, 0.3.4** (2026-06-24), which matches the libs version on Logseq's `main`. A plain `npm install @logseq/libs` installs the wrong one, so we pin an exact version. Provenance checked: both versions were published by the same npm account (`xyhp915`), and 0.3.4's `gitHead` is commit `3de7c75` in logseq/logseq ("chore(libs): bump new version", 2026-06-24, `libs/package.json` = 0.3.4). | `npm view @logseq/libs`, logseq/logseq git |
| Node 26 | Node 26 is LTS. It has a global `WebSocket` **client** and `http.websocketMask/Unmask` helpers (26.12.0), but **no WebSocket server**. TypeScript type stripping is **stable** and on by default. | nodejs/node `doc/api`, `CHANGELOG_V26.md` |
| `logseqAPI.instructions.md` | Useful map of the SDK's UI and editor methods. A few entries describe **file-graph** behavior ("page file", `prop::` properties, namespaces). In DB graphs, graph reads and writes go through the CLI; the SDK is used only for UI and editor actions such as `pushState`, `scrollToBlockInPage`, `getSelectedBlocks`, `insertAtEditingCursor` and `registerUIItem`. | your upload |
| `provideUI` | Templates go through DOMPurify, which **allows `<img>` and `<iframe>`**. Events are forwarded only as `value`/`id`/`className`/`dataset`, with **no `key`** for keyboard events, so templates can't handle Enter-to-send. | `libs/src/common.ts` |

---

## 2. Answers to open questions 1–3

### Q1. Markdown Mirror: not needed. Keep it off.

- The CLI already gives us what the AI needs, and more. `show`, `search` and
  `query` return text **with block UUIDs**. We need the UUIDs for citations
  (`[[uuid]]`), for pinning context, and as write targets. A Markdown file
  doesn't carry them in a usable form.
- Mirror only copies pages edited after it was turned on, so it would be
  incomplete.
- Mirror would put a **second plaintext copy of every edited page on disk**,
  `#private` blocks included. Spotlight, backups and any tool that can read
  files could see that copy, and it would sidestep the bridge's filter. Our
  design gives no model any file tools, so the copy would add risk and no use.
- If whole-graph Q&A is ever too slow through the CLI, the bridge can build its
  own index from CLI reads, filtered by policy and kept in memory. That still
  doesn't need Mirror.

### Q2. MacWhisper 2: partly unverified. Inspect the app before we design around it.

I couldn't reach the official MacWhisper pages from the research environment.
Here is what I could gather:

- *Third-party, unverified:* MacWhisper Pro has a command-line tool `mw`. You
  install it from Settings → Advanced → Command-Line Tool → Install, which
  writes `/usr/local/bin/mw`. Installing it **counts as an install and needs
  your approval**. That project also reports that some releases ship an `mw`
  that fails to load.
- *From memory, unverified for v2:* system-wide dictation with a hotkey that
  types into the frontmost app, and a watch folder (Pro).
- To find out what v2 really exposes, run the read-only commands in §8.B. They
  print the URL schemes, App Intents (Shortcuts actions), the AppleScript
  dictionary, bundled CLIs and settings keys.

How it fits:

1. **Voice v0, no code:** focus the panel's input and use MacWhisper's
   dictation hotkey. It works as soon as the panel exists.
2. **For option 3A I recommend Apple's SpeechAnalyzer/SpeechTranscriber**
   instead of MacWhisper. It's on-device, streams partial results, needs no file
   round-trip, needs no Pro license and installs nothing.
3. MacWhisper's CLI or watch folder would only be a fallback for higher
   accuracy. It is file-based, so it adds latency.

### Q3. Effort picker: how it maps to each provider

The picker offers **Auto** (send nothing, so the model uses its default),
**Off**, **Low**, **Medium**, **High**, **Extra high** and **Max**. It shows only
the levels the selected model supports.

| Picker | `claude -p` | Anthropic API (Claude 5 family) | OpenAI (Responses API) | Ollama |
|---|---|---|---|---|
| Auto | omit `--effort` | omit `output_config` | omit `reasoning` | omit `think` |
| Off | not offered | Haiku 5.5: `thinking:{type:"disabled"}` (high effort or lower only). Sonnet 5.5: lowest is `thinking:{type:"between_tools"}`. Opus 5.5 and Fable 5.1: can't be turned off. | `reasoning:{effort:"none"}` where supported | `think:false` if `/api/show` lists `false` |
| Low / Medium / High | `--effort low\|medium\|high` | `output_config:{effort:"low\|medium\|high"}` | `reasoning:{effort:…}` | `think:"low"\|"medium"\|"high"`, or `true` for on/off models |
| Extra high | `--effort xhigh` | `effort:"xhigh"` | `effort:"xhigh"` where supported | not offered |
| Max | `--effort max` | `effort:"max"` | not offered | `think:"max"` if listed |

Notes:

- **Anthropic** (verified): effort goes in top-level `output_config.effort`
  with no beta header. Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 support all
  five levels. The default is `medium` on Opus 5.5 and Haiku 5.5, and `high`
  elsewhere. Claude 5 models think adaptively by default.
  `thinking:{type:"enabled", budget_tokens}` returns **400** on Claude 5 models.
  A "show thinking" toggle maps to
  `thinking:{type:"adaptive", display:"summarized"}`. Streams carry
  `thinking_delta` and `text_delta` events.
- **`claude -p`** (verified on 2.1.317): effort is fixed for the life of the
  process. Changing it mid-chat restarts the process with `--resume <session>`
  and the new `--effort`/`--model`. That's cheap.
- **OpenAI** (*unverified*: the docs were blocked; this comes from search
  snippets of the official guide): `reasoning.effort` takes model-dependent
  values out of `none`, `minimal`, `low`, `medium`, `high` and `xhigh`. The
  bridge keeps an editable per-model table. If OpenAI rejects a value with a
  400, the bridge retries with the nearest supported value and shows a notice.
- **Ollama** (verified): `think` is a boolean or a level. `/api/show` returns
  `thinking.values` and `thinking.default` for each model, so the picker is
  built from that and nothing is hard-coded.

---

## 3. Questions for you (proposed defaults in bold)

**Q4. Allow/deny list entries and precedence. Decided: the defaults below.**

- Entry types:
  - `page:` exact title, covering the page and all its blocks
  - `tag:` tagged pages, plus tagged blocks and their children
  - `namespace:` a title prefix or parent page (to be checked on your graph)
  - `journal:` a date range such as `2026-01-01..2026-06-30`, open-ended allowed
  - `property:` a `name=value` pair
  - `tools:` which tools each provider class may use, e.g. cloud models
    read-only
- **Deny always wins.** An empty allowlist means everything not denied is
  allowed. A non-empty allowlist means only what it matches is allowed.
- **Graph marks:** `#private` means *local-only*, matching the consent card.
  `ai-access:: none` hides a block from every model. `ai-access:: local-only`
  hides it from cloud models. The most restrictive mark on the block, its
  ancestors or its page wins.
- **Anything the bridge can't classify is hidden** (fail closed).
- **Lists also apply to writes:** a model can't write where it can't read.

**Q5. Voice edits in v1**

- **Proposed: add-only.** Voice can ask questions, add notes and tasks (to
  today's journal or a named page) and open pages.
- **Every voice write still shows a preview card. You confirm with a click or
  ⌘↩, not a spoken "OK"**, because a spoken "OK" can be misheard.
- Editing or removing existing blocks by voice comes later.

**Q6. "Shortcut" trigger**

- **Proposed: a global keyboard hotkey owned by the Swift helper**, for example
  ⌥Space: hold to talk, tap to toggle. It uses Carbon `RegisterEventHotKey`,
  which needs no Accessibility permission.
- macOS Shortcuts support comes later, through an App Intent ("Start
  listening"). That also opens a wake-phrase path through **Vocal Shortcuts**
  without installing a wake-word engine.

**One more conflict (default chosen, tell me if you disagree):** D jobs run in
the background, but every write needs your approval. **Default: a D job drafts
its reply, and the draft waits as an approval card in the panel's Inbox.**
Nothing is written to the graph until you approve. That includes status marks,
since there's no CLI reaction command anyway.

---

## 4. Architecture

### 4.1 File layout

The bridge is TypeScript run directly by Node 26: `.ts` files, erasable syntax
only (no `enum`, `namespace` or parameter properties), `import type`, and
explicit `.ts` import extensions. A `tsconfig.json` (`noEmit`,
`erasableSyntaxOnly`, `allowImportingTsExtensions`, `verbatimModuleSyntax`) is
there only for editor checking. It has no runtime dependencies; `@types/node` is
the only dev dependency. Tests use `node --test`. The bridge refuses to start on
Node < 26.

The plugin copies logseq-panes-mode's setup:

- `webpack.config.js`: entry `src/index.ts` → `build/index.js` (UMD), `ts-loader`,
  `.css`/`.svg` imported as `asset/source`.
- `index.html` loads `./build/index.js`; `package.json` has a `logseq` manifest
  block and `main: index.html`.
- `npm run dev` runs webpack in watch mode; `npm run build` makes the
  production bundle.

Differences from panes-mode:

- `@logseq/libs` pinned to an exact version, with `package-lock.json`
  committed.
- `"strict": true` in `tsconfig.json`.

```
logseq-llm/
├─ README.md
├─ docs/
│  ├─ PLAN.md                 this file
│  └─ TESTING.md              manual test script per step (grows per step)
├─ bridge/                    Node 26, built-ins only, TypeScript via type stripping
│  ├─ package.json            "type": "module", engines node >=26, no runtime dependencies
│  ├─ tsconfig.json           editor type-checking only (noEmit)
│  ├─ bin/logseq-ai-bridge.ts entry: start | doctor | print-token | rotate-token
│  ├─ prompts/                system prompts (Logseq CLI rules from `logseq skill show`, untrusted-data rules)
│  ├─ src/
│  │  ├─ config.ts            loads <data>/config.json (port, graph, policy, providers)
│  │  ├─ server.ts            http server: Host/Origin/token checks, routing, CORS
│  │  ├─ events.ts            per-chat event log → SSE stream and JSON long-poll
│  │  ├─ auth.ts              tokens (crypto.randomBytes), timingSafeEqual, scopes
│  │  ├─ keychain.ts          wraps /usr/bin/security via execFile
│  │  ├─ chats/store.ts       provider-neutral transcripts (JSONL), chat metadata
│  │  ├─ chats/router.ts      turn loop, model switching, escalation, consent
│  │  ├─ policy/policy.ts     allow/deny + #private + ai-access → hidden | local | cloud
│  │  ├─ policy/redact.ts     prune hidden subtrees, redact refs to hidden nodes
│  │  ├─ tools/cli.ts         the ONLY code that runs `logseq` (execFile, subcommand allowlist)
│  │  ├─ tools/registry.ts    tool definitions (JSON Schema), shared by all providers
│  │  ├─ tools/read.ts        search, show page/block, list tasks/pages, backlinks
│  │  ├─ tools/write.ts       dry-run → approval card → apply → audit
│  │  ├─ tools/editor.ts      actions the plugin performs (open page, scroll to block)
│  │  ├─ mcp/http-mcp.ts      minimal MCP server (JSON-RPC over HTTP) for claude -p
│  │  ├─ providers/claude-cli.ts
│  │  ├─ providers/anthropic.ts
│  │  ├─ providers/openai.ts
│  │  ├─ providers/ollama.ts
│  │  ├─ worker/d-worker.ts   @ai comments and #Task assignments
│  │  └─ audit.ts             append-only audit log (provider, model, block UUIDs sent, writes)
│  └─ test/                   node --test, with a fake `logseq` executable
├─ plugin/                    webpack + ts-loader + TypeScript, like logseq-panes-mode
│  ├─ package.json            logseq manifest + exact @logseq/libs pin; dev: webpack, ts-loader, typescript
│  ├─ webpack.config.js       src/index.ts → build/index.js (UMD); css/svg as asset/source
│  ├─ tsconfig.json
│  ├─ index.html              loads ./build/index.js in the (hidden) plugin iframe
│  ├─ src/main.ts             registration: toolbar button, slash/context-menu commands, settings
│  ├─ src/host/mount.ts       creates/re-attaches the panel inside Logseq's DOM (all host selectors here)
│  ├─ src/host/styles.ts      provideStyle CSS, scoped to #lsai-panel, using Logseq CSS variables
│  ├─ src/panel/*.ts          layout, side setting, pickers, composer, message list, tool steps
│  ├─ src/panel/render.ts     safe renderer: createElement/textContent only, no remote media
│  ├─ src/panel/cards.ts      approval, consent and escalation cards
│  ├─ src/bridge-client.ts    fetch + SSE parser; falls back to logseq.Request long-poll
│  └─ src/context.ts          current page and selected block UUIDs, DB.onChanged forwarding
└─ voice/                     step 8: SwiftPM menu-bar helper and an .app bundle script
```

Data dir: `~/Library/Application Support/logseq-ai/` (mode 0700). It holds
`config.json`, `chats/`, `audit.jsonl`, `logs/`, `run/` (temporary 0600 MCP
configs) and `claude-cwd/` (an empty working directory for `claude`).

### 4.2 Plugin ↔ bridge transport: HTTP + SSE

**Choice:** plain HTTP. Commands are `POST` requests. The bridge streams events
with **server-sent events** read through `fetch()` and a `ReadableStream`, not
`EventSource`, so the request can carry an `Authorization` header.

Why not WebSocket? (Decided 2026-11-03.)

- Node 26 has a WebSocket client and `http.websocketMask/Unmask` helpers, but
  still **no WebSocket server**. A server would mean writing the handshake and
  framing ourselves (about 200 lines of security-sensitive parsing).
- Browsers can't send an `Authorization` header on a WebSocket. With
  fetch-based SSE they can.
- The `logseq.Request` fallback below works with polling the same event log. It
  can't do WebSocket.
- We only need streaming in one direction: everything the plugin sends is a
  discrete action.
- SSE is easy to inspect with `curl -N`.

Each chat has an **event log with sequence numbers**. Both the stream and the
fallback read from the same log, so a reconnect resumes from `after=<seq>` and
loses nothing.

Fallback: Chromium's newer Local Network Access rules may block `fetch` from the
plugin iframe to 127.0.0.1. If so, the plugin long-polls
`GET /v1/chats/:id/events?after=N&wait=25` through `logseq.Request`, which runs
in the host app and so isn't subject to CORS. We'll find out in step 2.

Endpoints (all under `http://127.0.0.1:<port>`; default port 47615,
configurable):

| Method and path | Purpose |
|---|---|
| `GET /v1/health` | Version and status. No graph data. |
| `GET /v1/providers` | Providers, models and the effort levels each supports |
| `POST /v1/chats` · `GET /v1/chats` · `GET /v1/chats/:id` | Create, list or get chats |
| `POST /v1/chats/:id/messages` | `{text, context:{pageUuid, blockUuids[]}, provider, model, effort}` |
| `GET /v1/chats/:id/events?after=N` | SSE stream (or JSON long-poll with `&wait=`) |
| `POST /v1/chats/:id/cancel` | Stop the current turn |
| `POST /v1/approvals/:id` | `{decision: "apply" \| "reject", note?}` |
| `POST /v1/consents/:id` | `{choice: "once" \| "switch" \| "stay"}` |
| `POST /v1/editor-results/:id` | The plugin reports the result of an editor action |
| `POST /v1/graph-events` | The plugin forwards changed block UUIDs (UUIDs only), used by D |
| `POST /v1/voice/utterance` | Voice helper. Needs a voice-scoped token. |
| `POST /mcp` | MCP endpoint for `claude -p`. Needs a per-process token. |

Event types: `turn.start`, `text.delta`, `thinking.delta`, `tool.start` (with a
label such as "searching…" or "reading page X"), `tool.end` (with a hidden-items
count, shown only to you), `approval.request`, `approval.resolved`,
`consent.request`, `editor.action`, `notice`, `error`, `turn.end` (with usage).

Bridge hardening:

- Listens on **127.0.0.1 only**.
- Rejects any `Host` header other than `127.0.0.1:<port>`, which defeats DNS
  rebinding.
- Requires an **`Origin` that exactly matches** the plugin origin confirmed in
  DevTools. Requests with no Origin (the voice helper, curl) are allowed only
  with a token.
- **Bearer tokens** are random 32-byte values, compared in constant time, and
  scoped:
  - `plugin`: everything except `/mcp`
  - `voice`: send an utterance, read replies
  - `mcp:<chat>`: one `claude` process and one privacy level
- CORS headers echo the single allowed origin and allow only `Authorization`
  and `Content-Type`.
- Bodies are JSON only, size-capped at 1 MB, with no cookies.

### 4.3 Panel: injected into Logseq's DOM (decided)

We follow the approach of your own plugin, logseq-panes-mode (the "Thinkering
mode" codebase):

- **Host DOM access:** plugin code builds the panel directly in Logseq's
  document through `parent.document` / `parent.window`, with real event
  listeners. The plugin's own iframe stays hidden and only runs our code. This
  works for a plugin loaded unpacked: per Logseq's source, unless the manifest
  sets `effect: false`, it loads from `lsp://logseq.com/external/...`, the same
  origin as the app. Panes-mode does the same thing.
- **Not `provideUI` templates for the chat itself.** Templates are re-set with
  `innerHTML` on every update. They pass DOMPurify, which still allows `<img>`
  and `<iframe>`, and keyboard events arrive without the `key`. We use
  `provideUI` only for the toolbar button, through
  `App.registerUIItem('toolbar', …)` with `data-on-click` and `provideModel`,
  as panes-mode does.
- **Styles:** CSS files are imported as strings (webpack `asset/source`) and
  injected with `logseq.provideStyle({key, style})`. All rules are scoped under
  `#lsai-panel`, and they use Logseq's own CSS variables, so the panel follows
  the theme.
- **Placement:** fitted into the layout from your screenshot.
  - Right (default) or left: the panel is a flex child of `#app-container`,
    after `#right-sidebar` (or before `#left-container` using `order:-1`). The
    page and Logseq's own right sidebar shrink to make room, so nothing is
    covered.
  - Top or bottom: the panel is inserted into `main#app-container-wrapper`
    around `#app-container`. The exact layout gets checked in DevTools.
  - Width or height is resizable. All host selectors live in one file
    (`src/host/mount.ts`).
- **Staying attached:** a MutationObserver puts the panel back if a Logseq
  re-render removes it. As in panes-mode, our own planned mutations are labeled
  so the observer doesn't react to them in a loop.
- **Cleanup:** `logseq.beforeunload` removes the panel, the styles, the
  observers and the listeners, so reloading the plugin during development
  leaves nothing behind.
- **Streaming:** text is appended incrementally to text nodes, batched per
  animation frame. The composer is never re-rendered while you type.

The trade-off we accept: our code runs with the app's own origin and access. A
rendering bug that let note or model text become HTML would therefore run with
the app's privileges. So the plugin follows hard rules:

- Model and note text only ever goes into `textContent`. Elements are built with
  `createElement`. `innerHTML`, `outerHTML` and `insertAdjacentHTML` are
  forbidden in `src/panel/`, and a test greps for them.
- **No `<img>`, `<iframe>`, `<video>`, `<audio>` or `<link>` is ever created
  from model output.** Image Markdown is shown as text. Links appear as chips
  that show the full URL and open (with `logseq.App.openExternalLink`) only when
  you click.
- Block refs in answers (`[[uuid]]`) become chips that open the block.

### 4.4 Where the allow/deny lists are enforced

**In one place: the bridge's tool layer.** Every graph read by any model goes
through `tools/*.ts` → `cli.ts` → `policy.ts`/`redact.ts`. No model ever gets a
shell, file tools, web tools or raw CLI access.

- **Locality per request:** `cloud` for `claude`, the Anthropic API and OpenAI;
  `local` for Ollama. Model names that look like Ollama cloud models (`cloud`
  tags) are refused.
- **For every returned node** (block or page), the filter resolves the node, its
  ancestors and its page through one batched CLI query, then gives it a
  visibility of `hidden`, `local` or `cloud` (rules in Q4). Hidden subtrees are
  dropped. References (`[[uuid]]`, `((uuid))`, page refs) pointing at hidden
  nodes become `[hidden]`. Search results never say that hidden matches exist;
  only the panel shows "3 hidden".
- **The plugin's context is not trusted as content.** It sends UUIDs only; the
  bridge reads and filters them itself.
- **Queries:** models don't get raw Datascript at first. They get fixed,
  parameterized tools such as backlinks and tasks by status. Any UUIDs placed
  into a query template are regex-validated first; free text never goes into
  EDN.
- **CLI safety:** calls use `execFile` with an argument array. A hard-coded
  subcommand allowlist covers `list *`, `search *`, `show`, `query`,
  `upsert block|page|task|tag|property` and `remove block`. It never includes
  `graph`, `server`, `sync`, `login`, `logout`, `agent` or `skill install`.
  Each subcommand also has an option allowlist.
  **Every option goes in one argv element, `--key=value`** (implemented in step
  1a). The CLI's parser (`cli/lib/cli_parse.ml`) reads `--key value` as a new
  option whenever the value starts with `-`. That means model or note text such
  as `--graph=Other` could inject an option. With `--key=value`, everything
  after the first `=` is the value. No positional arguments are ever passed,
  and the child process gets a minimal environment (no API keys).
- **Writes:** the target must be visible at the requester's locality. Content
  written by a model gets `--update-tags '["AI-GENERATED"]'`; the tag is created
  once during setup, with your approval. Every write runs `--dry-run` first,
  shows an approval card and is applied only after you click Apply.
- **Graph allowlist for writes:** writes are limited to a sandbox graph until
  you add your real graph to `writeGraphs` in `config.json`.

### 4.5 Tools (the same set for every provider)

- **Read:**
  - `search_blocks`, `search_pages`
  - `get_page`, `get_block` (with or without children)
  - `list_tasks`, `list_pages` (by tag or journal range)
  - `get_backlinks`
- **Write** (all preview then approve):
  - `insert_blocks` (a block tree at a target and position)
  - `update_blocks` (one or more blocks: content, tags)
  - `create_task`, `create_page`
  - `remove_block`
- **Editor** (run by the plugin):
  - `open_page`, `open_block`
  - `insert_at_cursor`, which is a write and so needs approval
- **Routing:**
  - `request_escalation(reason, target, scope)`: local models only
  - `consult_cloud(question)`: consult mode; shows a consent card with the exact
    question text

Claude gets these over MCP. The API and Ollama models get the same definitions
as ordinary function calls.

### 4.6 The exact `claude` command line

The bridge runs this with `execFile`, never through a shell. The working
directory is `<data>/claude-cwd` (empty). The environment is reduced to `HOME`,
`PATH`, `USER`, `LANG` and `TMPDIR`.

```bash
claude -p \
  --verbose \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --restricted \
  --tools "" \
  --strict-mcp-config \
  --mcp-config "<data>/run/mcp-<chatId>.json" \
  --allowedTools "mcp__lsq__search_blocks,mcp__lsq__search_pages,mcp__lsq__get_page,mcp__lsq__get_block,mcp__lsq__list_tasks,mcp__lsq__list_pages,mcp__lsq__get_backlinks,mcp__lsq__insert_blocks,mcp__lsq__update_blocks,mcp__lsq__create_task,mcp__lsq__create_page,mcp__lsq__remove_block,mcp__lsq__open_page,mcp__lsq__open_block,mcp__lsq__insert_at_cursor" \
  --permission-mode dontAsk \
  --permission-prompts none \
  --disable-slash-commands \
  --system-prompt "<contents of bridge/prompts/claude-system.md>" \
  --model sonnet \
  --effort medium \
  --session-id <new-uuid>          # first launch; later launches use: --resume <uuid>
```

`<data>/run/mcp-<chatId>.json` has mode 0600 and is deleted when the process
exits. The token is in a file so it doesn't show up in `ps`.

```json
{"mcpServers":{"lsq":{"type":"http","url":"http://127.0.0.1:47615/mcp",
  "headers":{"Authorization":"Bearer <per-process token>"},"timeout":900000}}}
```

- **No built-in tools:** `--tools ""` plus `--restricted`. `--restricted` also
  skips user, project and local settings files, so no hooks or plugins load.
  `--strict-mcp-config` ignores every other MCP server.
- **Approvals:** `dontAsk` plus `--permission-prompts none` deny anything not
  pre-approved. Approval for writes happens **inside our write tools**: the tool
  call stays open while the card is shown, for up to the 15-minute `timeout`.
  That works the same for all providers, so `--permission-prompt-tool` isn't
  needed.
- **Runtime guard:** the bridge checks the `system/init` event. If the tool list
  contains anything besides `mcp__lsq__*`, the bridge kills the process and
  shows an error.
- **Process lifetime:** one long-lived process per active chat, killed after
  10 minutes idle to save battery and resumed later with `--resume`.
  Switching model or effort means a restart with `--resume`.
- **Not used:** `--bare` (it breaks Pro OAuth) and `--no-session-persistence`
  (it breaks `--resume`). Claude Code keeps its own session files under
  `~/.claude/projects/<claude-cwd>`. "Delete chat" also removes that
  session's file.
- **`doctor` command:** `node bridge/bin/logseq-ai-bridge.ts doctor` runs one
  tiny `claude -p` turn with these flags. It checks that the Pro login works
  under `--restricted` and that the init event lists only our tools.

### 4.7 The other providers

- **Anthropic API:** `fetch` to `/v1/messages` with `stream: true` and
  `output_config.effort`. The bridge parses SSE (`content_block_delta` with
  `text_delta`/`thinking_delta`) and runs the tool loop itself. The key comes
  from the Keychain.
- **OpenAI:** `fetch` to the Responses API with `stream: true` and `reasoning`
  (and `effort`); function tools; the key comes from the Keychain. Event names
  are re-checked when we build it (unverified here).
- **Ollama** (after approval): `POST http://127.0.0.1:11434/api/chat` with
  `stream: true`, `tools`, `think` from `/api/show`, an explicit
  `options.num_ctx` (start at 32k for the 26B-A4B model and measure memory), and
  a short `keep_alive` to save RAM and battery. Cloud tags are refused.
- **Keys:** you add each key yourself in Terminal, where it's typed at a hidden
  prompt and never passed as an argument:

  ```bash
  security add-generic-password -s logseq-ai -a anthropic -w
  ```

  The bridge reads keys with `security find-generic-password -s logseq-ai -a
  <name> -w`.

### 4.8 Switching, escalation and consult mode

- **Transcripts:** the bridge keeps one provider-neutral transcript per chat.
  Each message records `provider`, `model`, `effort`, `locality` and the block
  UUIDs that were sent.
- **Switching between API and local models:** the bridge re-sends the
  transcript after re-filtering it for the new locality.
- **Switching into `claude`:**
  1. Start a new session (`--session-id`). Its first message is a **handoff**
     the bridge builds: the last N turns plus pinned blocks, filtered at `cloud`
     level. A summary written by the local model is optional and shown for
     review.
  2. Continue that session with `--resume`.
  3. Copy claude's text and its tool calls back into our transcript. The tool
     calls pass through our MCP server, so the bridge already has them.
- **Consent card:** as in the brief: *Ask once*, *Switch this chat*, *Stay
  local*, *Review what's sent*. The bridge computes the payload, not the model,
  so a model can't choose to include hidden blocks.
- **Consult mode:** the cloud model gets only the question the local model
  wrote, with no tools. That text could repeat things the local model saw, so
  the card shows it word for word.

### 4.9 D: comment and #Task worker. How it detects work.

**Choice: the plugin forwards change events, and the bridge catches up at
startup.**

- The plugin subscribes to `logseq.DB.onChanged`. It collects the UUIDs of
  changed blocks and sends them, debounced, to `POST /v1/graph-events`, with
  **UUIDs only**.
- The bridge re-reads each candidate through the CLI. It queues work when it
  finds either:
  - a block tagged *Comment* that references the `[[AI]]` page, or
  - a #Task whose `logseq.property/assignee` is `AI` and whose status is todo.
- At bridge start and after a reconnect, one CLI query finds unanswered
  requests from the last N days. **You confirm before a backlog is processed.**

Why not the alternatives:

- **Polling with the CLI:** each CLI call starts Logseq's runtime as Node.
  Polling every few seconds costs battery; polling every few minutes adds
  delay.
- **Subscribing to the db-worker's `/v1/events`,** as Logseq's own agent does:
  that's an internal, undocumented API that can change in any release.
  `DB.onChanged` is a documented SDK hook.
- **Trade-off:** D only runs while Logseq is open. That's also when the graph is
  live.

Job flow:

1. The panel Inbox shows "working". There's no CLI or SDK reaction API, so the
   bridge doesn't add the "eyes" reaction.
2. The model you chose for D runs with the same filtered tools.
3. Its reply becomes an **approval card** (optionally with a macOS notification
   via `osascript`).
4. When you approve, a short reply goes in as a new Comment block after the
   requesting comment. A long reply becomes a block tree after the comments
   area, plus a comment that links to it with `[[uuid]]`. These are Logseq's
   own conventions.

The provider's session ID is kept in bridge state, not in the graph, since
storing it in the graph would mean another write. The exact CLI form for
creating a real Comment block gets tested in a sandbox graph.

### 4.10 Voice (3A)

- **App:** a SwiftPM executable wrapped by a script into a minimal `.app`
  (`LSUIElement`, with `NSMicrophoneUsageDescription` and
  `NSSpeechRecognitionUsageDescription`) and ad-hoc signed. Because an ad-hoc
  signature changes with each build, macOS may ask for mic permission again
  after rebuilds.
- **Hotkey:** Carbon `RegisterEventHotKey`.
- **Speech to text:** SpeechAnalyzer + SpeechTranscriber (en-US, on-device).
  Audio is never written to disk.
- **Sending:** text goes to `POST /v1/voice/utterance` with the voice-scoped
  token, read from the Keychain.
- **Replies:** shown in the panel and optionally spoken with
  `AVSpeechSynthesizer` using a system voice.
- **Unknown:** building App Intents (for Shortcuts and Vocal Shortcuts) may
  need Xcode's metadata tools rather than plain `swift build`. We'll check this
  at step 8.

### 4.11 Prompt-injection and exfiltration defenses

- **No dangerous tools:** no model has a shell, file, web or raw-CLI tool. Every
  write is previewed and approved, and the preview flags external URLs or images
  and references to hidden nodes.
- **Note text is labeled as data:** it's wrapped in delimiters and labeled
  untrusted, and the system prompt says to never follow instructions found in
  it.
- **No hidden network requests from the panel:** the renderer never loads remote
  images (`![](https://…?q=secret)` is a classic leak) and never renders raw
  HTML. Links show their full URL and open only when you click. The panel
  lives in Logseq's own page, so we can't set its CSP; these rules are enforced
  in `render.ts` (§4.3).
- **Audit:** the log records what was sent where, by UUID. It doesn't store the
  content.

---

## 5. Build order: each step can be tested on its own

I moved the privacy filter **into step 1**, because step 1 already sends graph
text to a cloud model. Step 0 is new.

| Step | Deliverable | How you test it |
|---|---|---|
| 0 | Fact check on your Mac (read-only commands, §8) and a **sandbox DB graph** you create in Logseq | You paste the outputs |
| 1a ✅ | Bridge skeleton: server with Host, Origin and token checks, tokens, event log, SSE and long-poll, transcripts, audit log, safe CLI wrapper, echo test provider, `doctor` | `docs/TESTING.md` §1a: `node --test`, `doctor`, `curl` |
| 1b ✅ | **Read-only** graph tools, the full allow/deny rules, `#private` and `ai-access::`, ref redaction, the open-graph guard, and the `tool` command | `docs/TESTING.md` §1b |
| 1c ✅ | `claude -p` provider and the `/mcp` endpoint (per-turn tokens, read tools filtered as cloud), the startup guard, context, handoff, `check-claude` | `docs/TESTING.md` §1c |
| 2 ✅ | Plugin panel injected into the DOM: side setting, pickers, streaming, "…" indicator, tool steps, page and block context, safe renderer | `docs/TESTING.md` §2 |
| 3 ✅ | Writes: approval cards (dry-run where the CLI has it), `#AI-GENERATED`, `writeGraphs`, write-side privacy checks and warnings | `docs/TESTING.md` §3 |
| 4 | Anthropic and OpenAI API providers, with keys in the Keychain | Switch providers mid-chat |
| 5 | Ollama provider and model (**needs approval**), escalation, consent cards, consult mode | Local chat → escalate → review what's sent |
| 6 | Save chat to graph (`#AIChat` page, one block per message) | Save a chat in the sandbox graph |
| 7 | D worker (comments and #Tasks) with the Inbox | Comment `[[AI]] …` in the sandbox graph |
| 8 | Voice helper (3A) | Hotkey → speak → reply in the panel |

---

## 6. Needs your approval (with no-install alternatives)

| Item | Why | No-install alternative | When |
|---|---|---|---|
| Logseq **Developer mode** (a setting) | Needed for "Load unpacked plugin" | none | step 2 |
| `npm install` in `plugin/`: `@logseq/libs` (exact pin), `webpack`, `webpack-cli`, `ts-loader`, `typescript` (as in panes-mode) | SDK and bundling | a vendored `lsplugin.user.js`, no build | step 2 (**approved**) |
| `@types/node` (dev only, in `bridge/`) | Editor type checking of Node APIs; nothing at runtime | no types in the editor | step 1 (**covered by the TypeScript approval**) |
| Create a sandbox graph | Writes are tested off your real graph | test on the real graph (not recommended) | step 0 |
| Create the `AI-GENERATED`, `AIChat` and `AI` tags or pages | Tags must exist before use | none (the first write in each graph) | steps 3, 6, 7 |
| Keychain items | API keys | a 0600 file (worse) | step 4 |
| **Ollama** app and models (e.g. a Gemma 4 26B-A4B tag, about 15 GB) | Local model | API and `claude` only | step 5 |
| `OLLAMA_NO_CLOUD=1` or `disable_ollama_cloud` (a setting) | Hard block on Ollama cloud | the bridge's own name filter only | step 5 |
| Mic and speech recognition permission for the helper (TCC prompts) | Voice | MacWhisper dictation into the panel | step 8 |
| MacWhisper `mw` CLI (it writes `/usr/local/bin/mw`) | File transcription | Apple SpeechTranscriber (default) | only if wanted |
| launchd agent | Start the bridge at login | run it in Terminal | later |
| `ws`, the MCP SDK, the Vercel AI SDK, ACP adapters | — | not needed: SSE, hand-written JSON-RPC and `fetch` | never |

No change is needed to Logseq's HTTP API server (it stays off) or to Markdown
Mirror (it stays off).

---

## 7. Known risks to check early

- **Local Network Access:** the plugin iframe's `fetch` to 127.0.0.1 might be
  blocked by Chromium's Local Network Access rules. The fallback is the
  `logseq.Request` long-poll (§4.2).
- **DOM injection:**
  - whether `#app-container` tolerates an extra flex child across Logseq
    re-renders (the MutationObserver re-attaches it)
  - how top and bottom placement fits `main#app-container-wrapper`
  - Logseq's keyboard shortcuts firing while you type in the panel (we stop
    key events from reaching them while the composer has focus)
  - selectors changing in future Logseq versions (all of them are in one file)
- **CLI details:**
  - the CLI's handling of values that start with `-`
  - its JSON output shape
  - whether `query` accepts inputs
  - the right way to create Comment blocks
- **The CLI's background workers** (seen 2026-11-03): if the app doesn't have a
  graph open, any `logseq … --graph=X` command starts a CLI-owned db-worker for
  X and leaves it running (`logseq server list` shows `owner-source: cli`).
  **Rule for 1b:** before reading, the bridge checks that the configured graph
  is served by the app (`electron`). If it isn't, the bridge refuses the call
  instead of starting a background worker, and `doctor` warns about any leftover
  CLI workers.
- **CLI JSON envelope** (seen): `{"status":"ok","data":{…}}`, for example
  `search block` → `{"data":{"items":[…]}}`. Errors look like
  `{"status":"error","error":{"code":"page-not-found","message":"…"}}`.
- **`DB.onChanged` payloads:** what the DB version actually sends.
- **Flags in 2.1.316:** whether that version has `--restricted`,
  `--permission-prompts` and `--disable-slash-commands` (all exist in 2.1.317).

---

## 8. What I need from your Mac (all read-only)

**A. Reference folder.** Done: logseq-panes-mode's public repo and
`logseqAPI.instructions.md`. Still missing: the other git-ignored
`.github/instructions/*.instructions.md` files (project context, DOM notes).
Attach them in chat. Don't commit them here, because this repo is public.

**B. Command outputs.** The exact commands are in the chat message that came
with this plan. They cover:

- `claude --help`
- `logseq --help`, `logseq example`, `logseq skill show`, and `--help` for
  `show`, `search block`, `list task`, `query`, `upsert block`, `upsert task`
  and `remove block`
- a JSON `show` of one harmless page
- `which -a node` and `node --version` (the bridge needs Node ≥ 26; the
  brief listed Node 20.16.0 at `/usr/local/bin/node`)
- MacWhisper's `Info.plist` URL types, App Intents metadata, `.sdef` and
  bundled binaries
