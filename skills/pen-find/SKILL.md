---
name: pen-find
description: Find a frame, screen or component in a Pen (pen.dev) design file by describing it ("the Shelf empty state in dark mode", "the toast with Undo"), without reading the whole node tree. Jev (TypeSafe's fast judgment model) ranks every frame by meaning through Pen's own MCP server and returns the top node IDs, with optional screenshots. Use BEFORE browsing a .pen file with Get/TakeScreenshot to locate something, when the user asks where a design is, or before editing an existing screen.
---

# pen-find

`pf` below means `node "<base directory of this skill>/scripts/pen-find.mjs"`. Needs Node 18+, the Pen app open,
and a Jev key (`pf status` checks both).

- No key → ask the user to run `! node "<skill dir>/scripts/pen-find.mjs" setup` in their terminal (hidden input),
  or get one at https://console.typesafe.ai. Don't ask them to paste the key in chat.

```bash
pf "<what you're looking for>" [--top 5] [--file x.pen] [--deep] [--shot DIR] [--json] [--refresh]
pf list "ARCHIVE 2*"      # ids + bounds of frames by name glob, natural order, overlaps flagged (free, no Jev)
pf index                 # rebuild the cached node index after big edits
```

- Default file: the one open in Pen (else the last one used). The index is cached per file and rebuilt when the
  file changes on disk; pass `--refresh` after unsaved edits.
- By default it judges screens and their main parts (depth ≤ 4, plus all components); `--deep` judges every
  frame, group and instance.
- Output: `score  nodeId  Board › … › Name  (kind, w×h)`. Use the node IDs directly in Pen's `execute`
  (`Get(id)`, `TakeScreenshot([id])`). `--shot DIR` exports PNGs of the matches.
- It matches names, text and structure (components, icons, background, device shape), not pixels. If nothing
  matches confidently it prints `no confident match`, marks the closest frames `?` and gives thumbnail paths:
  Read those images and pick by eye, or rephrase by what the frame contains. Treat results as a shortlist.
- Privacy: node names, paths and text go to Jev. Anything key-shaped is redacted first. Don't use it on files
  whose text must not leave the machine.
