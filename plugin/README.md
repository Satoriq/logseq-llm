# Logseq AI panel (plugin)

The chat panel for Logseq DB. It talks only to the local bridge (`../bridge`)
on `127.0.0.1`.

```bash
npm ci --ignore-scripts && npm run build
```

Then load the folder in Logseq: Settings → Plugins → Load unpacked plugin
(Developer mode must be on). Setup and checks are in `../docs/TESTING.md` §2.

- `src/host.ts`: where the panel goes in Logseq's DOM (all host selectors).
- `src/panel.ts`: the UI.
- `src/render.ts`: the safe Markdown renderer (text nodes only, no images or HTML).
- `src/bridge.ts`: the bridge client (SSE, with a `logseq.Net` long-poll fallback).
