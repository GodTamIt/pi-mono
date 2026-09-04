---
"@ohgodtamit/pi-usage": patch
---

Fix TUI redraw corruption after visiting the Delegation tab: sanitize session-derived task, parent, agent-type, and status text so rendered lines never contain embedded newlines, tabs, or escape bytes. Previously one logical line could wrap into extra physical terminal rows, desyncing pi-tui's differential renderer and leaving stale rows, a duplicated header, and remnants of adjacent tabs when switching views or closing the panel.
