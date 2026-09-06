# Changelog

## 0.4.2

### Patch Changes

- Restore compact built-in tool rendering in the `/subagents:sessions` transcript. Pi 0.85 removed the built-in tool fallback from `ToolExecutionComponent`, so child sessions' `read`, `edit`, `write`, `bash`, `find`, `grep`, and `ls` calls fell back to the default shell. The transcript now rebuilds those definitions from the child's `cwd` when the source has none, while custom definitions keep precedence.

## 0.4.1

### Patch Changes

- 440b6cc: Refresh terminal preview artwork for the current roster UI.
- Extend Pi compatibility to `>=0.84.0 <0.86.0`, lowering the minimum from 0.84.3 to 0.84.0 and adding the 0.85.x line. Development/test pins and smoke fixtures use exact Pi 0.85.0.

## 0.4.0

### Minor Changes

- Add RPC and headless compatibility for the /agent, /stack, and /subagents:sessions pickers, and render the TUI searchable picker inside a responsive border box.

## 0.3.1

### Patch Changes

- Preserve explicit primary stacks across resumed sessions, support direct active-stack selection, and harden subagent invocation rendering against duplicate rows and terminal-output leakage.

## 0.3.0

### Minor Changes

- f99cad6: Enrich subagent progress displays with compact two-line Background agents blocks, richer tool-call summary and activity details, and UI-only inline foreground child conversations.

## 0.2.0

### Minor Changes

- 8554999: Add a unified one-line footer for the current task, selected primary and stack, and active background counts.

## 0.1.0

### Minor Changes

- 9310c88: Prepare the initial release of the agent roster package.

## 0.1.0-alpha.8

### Minor Changes

- 5e6579e: Streamline primary stack selection, add agent and stack shortcuts, and show the effective stack in the footer.

## 0.1.0-alpha.7

### Minor Changes

- f1f487c: Support named `default` stacks, add `/stack` argument completion, and propagate the user-selected primary stack to matching subagent profiles with primary model/thinking fallback.

## 0.1.0-alpha.6

### Patch Changes

- 4236aba: Show the selected primary agent in Pi's footer and remove obsolete roster readiness diagnostics.

## 0.1.0-alpha.5

### Patch Changes

- 8661b78: Render subagents in Pi's native tool shell, avoid duplicate turn-limit wrap-ups, support asynchronous background resumes, and reinforce required child output contracts.

## 0.1.0-alpha.4

### Patch Changes

- 97e077c: Polish subagent panels, preserve full results and child runtime prompts, restrict delegation to child-capable agents, improve usage formatting, and prevent background activity from resetting terminal scrollback.

## 0.1.0-alpha.3

### Patch Changes

- 6210b27: Warn and continue when a primary agent references unknown permission tools.

## 0.1.0-alpha.2

### Patch Changes

- 23ab734: Clarify agent tool permissions and context-file configuration.

## 0.1.0-alpha.1

### Minor Changes

- ca800ce: Add configurable context-file loading and tool permissions to agent profiles.

## 0.1.0-alpha.0

### Minor Changes

- 9310c88: Prepare the initial release of the agent roster package.
