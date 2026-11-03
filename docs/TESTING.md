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
