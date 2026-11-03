# Manual tests

Each step has its own checklist. Nothing here writes to a graph or changes a
Logseq or system setting.

## Step 1a: bridge skeleton

What exists so far:

- the local server (127.0.0.1 only) with its Host, Origin and token checks
- the chat event log, streamed over SSE, with a long-poll fallback
- chat storage and the audit log
- the safe `logseq` CLI wrapper
- `doctor`
- an **echo** test provider (no model, no graph access)

There are no graph tools, no privacy filter and no `claude` yet (those are
steps 1b and 1c).

### 0. Get the code (once)

```bash
git clone -b claude/logseq-ai-chat-panel-rb9b9w https://github.com/Satoriq/logseq-llm.git "$HOME/logseq-llm"
```

```bash
cd "$HOME/logseq-llm/bridge"
```

Any folder works; the commands below assume `$HOME/logseq-llm`. There is nothing to install: the bridge has no dependencies and Node 26 runs
the `.ts` files directly.

### 1. Unit tests

```bash
node --test "test/**/*.test.ts"
```

Expected: `# pass 25`, `# fail 0`.

### 2. Doctor (read-only)

```bash
node bin/logseq-ai-bridge.ts doctor
```

On the first run this creates `~/Library/Application Support/logseq-ai/` (mode
700) with a default `config.json`, and saves the CLI's help texts to
`doctor/logseq-cli-help.txt`.

Expected:

- `ok` for node, the data dir, `config.json`, the logseq binary,
  `logseq --version` and `graph list`, the claude binary and `claude flags`.
- A `warn` for "configured graph", because `graph` is still `null`. That's fine
  for now.
- Any `logseq … options: not listed` warning means your CLI differs from the
  source I read. **Please send me the doctor output and
  `doctor/logseq-cli-help.txt`** (it contains only help text).

Optional: to let me see the CLI's JSON shapes for step 1b, pick a harmless page
and word.

```bash
node bin/logseq-ai-bridge.ts doctor --sample-page "Logseq AI" --sample-search "blacklists"
```

This writes `doctor/sample-show.json`, `doctor/sample-search.json` and `doctor/sample-query-*.json`. The query files are the raw block entities, which show how tags and properties are stored. They
contain the text of that page and those search hits, so only send them if
that's fine.

### 3. Start the bridge

Run this in its own Terminal window:

```bash
node bin/logseq-ai-bridge.ts start
```

Expected: `listening on http://127.0.0.1:47615`. Stop it with Ctrl-C.

### 4. Talk to it with curl (second Terminal window)

```bash
cd "$HOME/logseq-llm/bridge" && TOKEN=$(node bin/logseq-ai-bridge.ts token) && B=http://127.0.0.1:47615
```

```bash
curl -s $B/v1/health
```

Expected: `{"ok":true,"name":"logseq-ai-bridge"}`.

```bash
CHAT=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"title":"smoke"}' $B/v1/chats | node -pe 'JSON.parse(require("fs").readFileSync(0)).chat.id') && echo $CHAT
```

Watch the stream (this one keeps running; leave it open):

```bash
curl -N -H "Authorization: Bearer $TOKEN" -H 'Accept: text/event-stream' "$B/v1/chats/$CHAT/events?after=0"
```

In a third window (run the `TOKEN=…` line and set `CHAT=` to the id printed
above), send a message:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"text":"hello bridge","provider":"echo"}' $B/v1/chats/$CHAT/messages
```

Expected in the stream window: `turn.start`, a run of `text.delta` events
spelling "You said: hello bridge", then `turn.end`.

### 5. Security checks (each should print 403 or 401)

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: localhost:47615' $B/v1/health
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example' -H "Authorization: Bearer $TOKEN" $B/v1/chats
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' $B/v1/chats
```

```bash
lsof -nP -iTCP:47615 -sTCP:LISTEN
```

The last command should show `127.0.0.1:47615` only, not `*:47615`.

### 6. Files

```bash
ls -la "$HOME/Library/Application Support/logseq-ai" "$HOME/Library/Application Support/logseq-ai/chats" "$HOME/Library/Application Support/logseq-ai/secrets"
```

Expected: directories `drwx------`, files `-rw-------`. `audit.jsonl` lists
`turn.start`/`turn.end` with ids only, no message text.

## Step 1b: read-only graph tools and the privacy filter

New in this step:

- read-only tools: `search_blocks`, `search_pages`, `get_page`, `get_block`,
  `get_backlinks`, `list_tasks`, `list_pages`
- the privacy filter: deny/allow rules, `#private`, `ai-access::`, and refs to
  hidden things redacted as `[hidden]`
- a guard that refuses to read a graph the Logseq app doesn't have open
- `tool`: run one tool and see exactly what a model would get

All of these only read. Keep **AI Sandbox** open in Logseq.

### 1. Update and run the tests

```bash
cd "$HOME/logseq-llm/bridge" && git pull && node --test "test/**/*.test.ts"
```

Expected: `# pass 41`, `# fail 0`.

### 2. What a cloud model would see (the default view)

```bash
node bin/logseq-ai-bridge.ts tool get_page '{"title":"AI Test"}'
```

Expected:

- **Shown:** "Apples are red", the indented child block, and "See [[AI Test 2]]".
- **Not shown:** "This one is secret #private" and "Local only note".
- The last line reads `--- cloud view: … 2 hidden by the privacy filter`.

### 3. What a local model would see

```bash
node bin/logseq-ai-bridge.ts tool get_page '{"title":"AI Test"}' --as local
```

Expected: all five blocks and `0 hidden`. The internal value block
"local-only" is never listed as a block.

### 4. Search

```bash
node bin/logseq-ai-bridge.ts tool search_blocks '{"query":"apples"}'
```

```bash
node bin/logseq-ai-bridge.ts tool search_blocks '{"query":"secret"}'
```

Expected: the apples search finds both apple blocks with `(page "AI Test")`.
The secret search answers `No matching blocks.` and counts 1 hidden. The model is
not told that something was hidden.

### 5. A deny rule

This writes the rule into `config.json`:

```bash
node -e 'const fs=require("fs");const f=process.env.HOME+"/Library/Application Support/logseq-ai/config.json";const c=JSON.parse(fs.readFileSync(f));c.policy.deny=["page:AI Test 2"];fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")'
```

```bash
node bin/logseq-ai-bridge.ts tool get_page '{"title":"AI Test 2"}' --as local
```

```bash
node bin/logseq-ai-bridge.ts tool get_page '{"title":"AI Test"}'
```

Expected: `No page named "AI Test 2".` (the same answer as for a page that
doesn't exist), and on AI Test the last block reads `See [hidden]`.

To remove the rule again:

```bash
node -e 'const fs=require("fs");const f=process.env.HOME+"/Library/Application Support/logseq-ai/config.json";const c=JSON.parse(fs.readFileSync(f));c.policy.deny=[];fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")'
```

A typo in a rule, for example `"pagee:Diary"`, must stop the bridge with an
error, not be skipped.

### 6. The open-graph guard

Switch Logseq to a different graph, then run:

```bash
node bin/logseq-ai-bridge.ts tool get_page '{"title":"AI Test"}'
```

```bash
logseq server list
```

Expected: `Open the graph "AI Sandbox" in Logseq first…`, and `server list`
shows **no** new `cli` worker. Switch back to AI Sandbox afterwards.

## Step 1c: Claude through your own `claude` (Pro plan)

New in this step:

- **The `claude` provider:** the bridge runs your own `claude -p` with the
  locked-down flags from PLAN §4.6.
  - no built-in tools
  - no user or project settings
  - no other MCP servers
  - no slash commands
  - **no `ANTHROPIC_API_KEY` passed on**, so it can only use your Pro login
- **`/mcp`:** the bridge's tool endpoint for `claude`.
  - It offers the read-only tools from step 1b, filtered as **cloud**, so
    `#private` and local-only blocks never reach Claude.
  - Each turn gets a fresh token, which stops working when the turn ends.
- **Startup guard:** if `claude` starts with any tool the bridge didn't allow,
  the bridge stops it.
- **Context:** the page or blocks you have open are filtered as cloud first.
- **Switching into Claude** from a local provider passes along your messages,
  but not the local model's replies.

This step uses a little of your Pro usage. Keep **AI Sandbox** open in Logseq.

### 1. Update and run the tests

```bash
cd "$HOME/logseq-llm/bridge" && git pull && node --test "test/**/*.test.ts"
```

Expected: `# pass 49`, `# fail 0`. The tests use a fake `claude`; nothing
leaves your Mac.

### 2. One real Claude turn through the bridge

```bash
node bin/logseq-ai-bridge.ts check-claude
```

Expected, roughly:

```
command: …/claude -p --verbose … --restricted --tools "" --strict-mcp-config …
tool:   reading page "AI Test"
        → ok: 4 item(s) (2 hidden)
answer: 2
result: end in … s
check-claude: OK
```

The answer is the number of top-level blocks a cloud model can see on AI Test
("Apples are red" and "See [[AI Test 2]]").

- If you see a `notice: … apiKeySource …`, stop and tell me: `claude` would
  be billing an API key instead of your Pro plan.
- If it fails with an error about `--restricted`, set `"claudeRestricted": false`
  in config.json, rerun it, and tell me.

### 3. A real chat over curl

Window 1:

```bash
node bin/logseq-ai-bridge.ts start
```

Window 2 (the stream):

```bash
cd "$HOME/logseq-llm/bridge" && TOKEN=$(node bin/logseq-ai-bridge.ts token) && B=http://127.0.0.1:47615 && CHAT=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"title":"first claude chat"}' $B/v1/chats | node -pe 'JSON.parse(require("fs").readFileSync(0)).chat.id') && echo "CHAT=$CHAT" && curl -N -H "Authorization: Bearer $TOKEN" -H 'Accept: text/event-stream' "$B/v1/chats/$CHAT/events?after=0"
```

Window 3: set the same `TOKEN`, `B` and `CHAT` (the id printed in window 2),
then ask:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"text":"What does my AI Test page say about apples? Cite the blocks.","provider":"claude","model":"sonnet","effort":"low"}' $B/v1/chats/$CHAT/messages
```

Expected in window 2: `turn.start`, `tool.start`/`tool.end`, a stream of
`text.delta` events citing `[[a558ac4e-…]]`, and `turn.end`.

Privacy check: ask in the same chat

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"text":"Are there any secret or private notes on AI Test? Quote them.","provider":"claude","model":"sonnet","effort":"low"}' $B/v1/chats/$CHAT/messages
```

Expected: Claude doesn't know about "This one is secret" or "Local only note".
The second turn reuses the same Claude session (`--resume`).

### 4. Audit log

```bash
tail -n 5 "$HOME/Library/Application Support/logseq-ai/audit.jsonl"
```

Expected: `tool` entries with `"locality":"cloud"`, the block ids that were
sent and the hidden count. There is no note text.

Note: Claude Code keeps its own transcript of these sessions under
`~/.claude/projects/` (in a folder named after `…/logseq-ai/claude-cwd`). That
is your normal Claude Code history; "delete chat" will clean it up in a later
step.

## Step 2: the panel inside Logseq

New in this step:

- **The plugin** (`plugin/`): a chat panel built inside Logseq's own page.
  - On the right (default) or left, it sits next to the page. The page and
    Logseq's own right sidebar get narrower; nothing is covered.
  - Top and bottom float over the page.
- **In the panel:**
  - chat picker and "＋" for a new chat
  - provider, model and effort pickers (from the bridge)
  - streaming replies, with a "…" indicator
  - tool steps such as `✓ reading page "AI Test" · 2 hidden by your privacy settings`
  - a Stop button
- **Context:**
  - the page you're viewing is a chip you can switch off
  - right-click a bullet → **Ask Logseq AI about this block** pins it
  - `/Ask Logseq AI` in a block does the same
- **Safety:** replies render as text only. Images become `[image: …]`. Links
  are chips that show the URL and open in your browser only when clicked.
  `[[uuid]]` chips open the block.
- **Toolbar:** the **AI** button, or **⌘⌥A**, toggles the panel.

### 1. Build the plugin (the approved npm install)

```bash
cd "$HOME/logseq-llm" && git pull && cd plugin && npm ci --ignore-scripts && npm run build
```

`npm ci` installs exactly what `package-lock.json` lists (`@logseq/libs@0.3.4`,
webpack 5.111.1, webpack-cli 7.2.3, ts-loader 9.6.2, TypeScript 5.9.3) and
checks every file's hash. `--ignore-scripts` means no package code runs
during the install; none of them needs install scripts. Expected:
`webpack … compiled successfully`, and `plugin/build/index.js` exists.

### 2. Start the bridge and copy the token

```bash
cd "$HOME/logseq-llm/bridge" && node bin/logseq-ai-bridge.ts start
```

In a second window (this copies the token to the clipboard):

```bash
cd "$HOME/logseq-llm/bridge" && node bin/logseq-ai-bridge.ts token | pbcopy
```

### 3. Load the plugin in Logseq (AI Sandbox open)

1. **Settings → Advanced → Developer mode**: on (the approved setting).
2. **Settings → Plugins → Load unpacked plugin** → choose the folder
   `logseq-llm/plugin`.
3. **Settings → Plugins → Logseq AI**: paste the token into **Bridge token**.
4. Click **AI** in the toolbar (or press ⌘⌥A). The panel opens on the right
   and shows `● Connected`.

If the panel says **"The bridge refused this connection"**, it also shows the
plugin's origin. Put that exact value into `allowedOrigins` in
`~/Library/Application Support/logseq-ai/config.json`, then restart the bridge.
Expected origin: `lsp://logseq.com`.

### 4. Confirm the plugin origin in DevTools

Open DevTools (⌥⌘I), select the **Console**, and look for:

`[logseq-ai] ready; plugin origin = lsp://logseq.com`

Please send me that line, whatever it says.

### 5. Chat

On the page **AI Test**, pick **Claude (Pro) · cloud → Sonnet → Low** and ask:
*"What's on this page? Cite the blocks."*

Expected:

- `✓ reading page "AI Test" · 2 hidden by your privacy settings`
- the reply streams in, then turns into formatted text with `↗ block` chips
- clicking a chip opens that block
- Claude doesn't mention "This one is secret" or "Local only note"

Then switch to **Echo (test) · local** and send anything: it repeats your
text back and uses no model.

### 6. Panel behaviour

- **Shortcuts:** typing in the panel must **not** trigger Logseq shortcuts. For
  example, typing `t w` must not toggle wide mode.
- **Resize:** drag the panel's left edge. The size is remembered.
- **Panel side:** Settings → Plugins → Logseq AI → **Panel side**: try
  left, top and bottom. On the left, the header stays clear of the window buttons.
- **Pin a block:** right-click a bullet → **Ask Logseq AI about this block**. A `▦`
  chip appears, and that block (filtered) goes with your next message.
- **Stop:** press **Stop** during a long reply. It ends with `(cancelled)`.
- **Reload:** close the panel (×) and reopen it. The chat is still there, loaded
  from the bridge.

To unload: Settings → Plugins → Logseq AI → disable or remove. The panel and
its styles disappear completely.

## Step 3: writes, only after you approve them

New in this step:

- **Five write tools:** `insert_blocks`, `update_block`, `create_task`,
  `create_page` and `remove_block`.
- **Approval card:** every change shows up as a card in the panel first.
  - It shows the target, a preview (outline, before/after, or exactly what would
    be deleted), warnings, and **Reject / Apply**.
  - Nothing is written until you click Apply. No answer within 10 minutes, or
    **Stop**, counts as Reject.
  - Your note on a Reject goes back to the AI.
- **Apply runs exactly the previewed command.** For `insert_blocks`, the CLI's
  own `--dry-run` checks it first.
- **Tagging:** everything the AI writes gets `#AI-GENERATED`.
- **Checks before a card is even shown:**
  - the graph must be in `writeGraphs`
  - a cloud model can't write to blocks it can't see (`#private`, local-only)
  - text containing `[hidden]` is refused, so it can't overwrite a link the
    AI couldn't see
  - nobody but you may set `ai-access::`
  - a new page can't land under a deny rule
- **Warnings on the card:**
  - outside links and images
  - pages that would be created
  - links to pages the AI can't see
  - links an edit would drop
  - for a deletion, blocks underneath that the AI can't see

Your real graph stays read-only: only graphs listed in `writeGraphs` can be
written, and the list starts empty.

### 1. Update

```bash
cd "$HOME/logseq-llm" && git pull && cd plugin && npm run build
```

Restart the bridge (Ctrl-C, then `start` again). In Logseq, reload the
plugin: Settings → Plugins → Logseq AI → off → on.

### 2. Allow approved writes in the sandbox only

Create the tag once (this writes one tag to AI Sandbox):

```bash
logseq upsert tag --graph="AI Sandbox" --name=AI-GENERATED
```

Add AI Sandbox to `writeGraphs`:

```bash
node -e 'const fs=require("fs");const f=process.env.HOME+"/Library/Application Support/logseq-ai/config.json";const c=JSON.parse(fs.readFileSync(f));c.writeGraphs=["AI Sandbox"];fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")'
```

```bash
cd "$HOME/logseq-llm/bridge" && node bin/logseq-ai-bridge.ts doctor
```

Expected: `ok writes: allowed for "AI Sandbox"` and `ok AI-GENERATED tag: exists`.
Restart the bridge so it picks up the new config.

### 3. Preview from Terminal (writes nothing)

```bash
node bin/logseq-ai-bridge.ts tool insert_blocks '{"page":"AI Test","markdown":"- Hello from the bridge\n  - a child"}'
```

Expected: an "approval card (preview only)" with
`Add 2 blocks to "AI Test"`, and then `The user rejected this change… "preview only"`.
AI Test is unchanged.

### 4. In the panel (AI Sandbox open, Claude · cloud)

1. *"Add a short summary of this page as a new block at the end of AI Test."*
   A card appears and the reply shows "Waiting for your approval…". Click
   **Apply**. The block appears in Logseq with the `#AI-GENERATED` tag, and the
   card says `✓ Applied`.
2. Ask for another addition, type a note such as *"too long"*, then click
   **Reject**. Nothing is written; Claude sees your note.
3. *"Change 'Apples are red' to 'Apples are red or green'."* The card
   shows Before (struck through) and After.
4. *"Add a task to buy pears on AI Test."* After Apply, a task appears,
   tagged `#AI-GENERATED`.
5. *"Delete the summary block you added."* The card lists exactly what
   would be deleted, and the button says **Delete**.
6. Privacy: *"Edit the block that says 'This one is secret'."* Claude
   can't find it, because it's `#private`, and no card appears.
7. Ask for a change, then press **Stop** while the card is waiting. The
   card says `✗ Not applied`.

### 5. Audit log

```bash
tail -n 8 "$HOME/Library/Application Support/logseq-ai/audit.jsonl"
```

Expected: `"kind":"write"` lines with `"outcome":"applied"` or `"rejected"`
and the block ids they touched. There is no note text.
