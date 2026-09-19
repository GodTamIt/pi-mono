---
"pi-agent-roster": patch
---

Fix an uncaught crash when rendering subagent invocation rows whose tool-result details lack a display name or description — a gap that opens when details cross the JSON or session-restore boundary without every field TS types as required. `sanitizeTerminalText` now tolerates absent input, invocation rows fall back to "—" for missing names, descriptions, and task text, and live-record merging no longer clobbers a good base description with an absent one.
