---
"pi-agent-roster": patch
---

Show a one-line task summary in the subagent TUI call row so pending, resumed, and error invocations are legible before a rich result row arrives. The rich invocation row keeps ownership of its summary, so the call preview appears only when no result row supplies one.