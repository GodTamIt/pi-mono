# Pi plugins

Focused extensions for [Pi](https://github.com/earendil-works/pi) with typed APIs and explicit, opt-in configuration.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./packages/pi-agent-roster/media/terminal-dark.svg">
  <img src="./packages/pi-agent-roster/media/terminal-light.svg" alt="Sanitized Pi terminal showing Agent Roster running two background agents while a third waits in the concurrency queue." width="1200">
</picture>

## Catalog

### [`pi-agent-roster`](./packages/pi-agent-roster/README.md)

Primary-agent profiles and in-process subagent orchestration for Pi.

- **Bring your own roster.** No agent definitions ship in the package; project and global Markdown profiles opt in explicitly.
- **One profile format.** Use an agent as a primary, a subagent, or both, with tool permissions, prompts, delegation policy, models, thinking, and turn budgets.
- **Switch models quickly.** Named stacks are reusable model/thinking presets that let you switch between authenticated models without editing agent definitions.
- **Observable work.** Foreground progress, a live background tree, completion notifications, expandable tool rows, and a read-only child-session viewer stay inside Pi's TUI.
- **Controlled lifecycle.** FIFO background admission, steering, result collection, transcript-backed resume, bounded child shutdown, retention, and an optional workspace-isolation seam.
- **Extension API.** Other Pi extensions can spawn, inspect, resume, steer, abort, await, and isolate children through a typed service.
- **RPC-friendly interaction.** Pickers use Pi's RPC-capable `ui.select`, background status
  renders as plain string widgets, and completions arrive as model-facing task notifications.
  Pickers skip cleanly when no UI is attached, so non-interactive runs never block on a prompt.

[Package guide](./packages/pi-agent-roster/README.md)

### [`@ohgodtamit/pi-usage`](./packages/pi-usage/README.md)

Usage dashboards and live provider quota reporting for Pi.

- **Eight usage views.** Explore overview, models, delegation, daily, stats, hourly, providers, and Wrapped reports without leaving the TUI.
- **Detailed attribution.** Break down tokens and cost by model, skill, bundle, plugin, tool, and project.
- **Live quota signals.** Combine captured rate-limit headers with supported OpenAI Codex, ZAI, OpenRouter, and OpenAI account APIs.
- **Fast rescans.** Incremental session caching keeps repeat opens responsive while invalidating after new turns.
- **RPC-ready panel.** In RPC mode `/usage` serves an ANSI-free, paginated dashboard driven by
  a `ui.select` action menu. In print/JSON mode the interactive commands fail fast with an
  actionable error instead of hanging.

[Package guide](./packages/pi-usage/README.md)

### [`@ohgodtamit/pi-agent-browser`](./packages/pi-agent-browser/README.md)

Native `agent_browser` and `agent_browser_web_search` tools for Pi, packaged as a lean partial fork.

- **PATH-safe `ps` discovery.** Managed-session locks work on Nix-style systems without hard-coded POSIX binary paths.
- **No brittle runtime exact-version gate.** Valid installed `agent-browser` versions run normally; doctor reports baseline drift as advisory.
- **Lean prompt.** Essential workflow invariants stay always-on while detailed guidance lives in installed docs, reducing recurring context overhead.
- **UI-independent tools.** Both tools return model-facing content plus structured `details`,
  so TUI, RPC, and headless runs see the same data. `agent_browser_web_search` registers only
  when enabled configuration has a potential Exa or Brave credential source.

[Package guide](./packages/pi-agent-browser/README.md)

## TUI first, RPC friendly

The TUI is the primary surface for every package here. Interactive flows use RPC-capable
primitives or an intentional non-TUI path; widgets can degrade to plain string arrays, and
print/JSON runs do not wait on hidden prompts. The per-package bullets above describe each
package's exact behavior.

## Provenance and license

The repository is MIT licensed; third-party attributions are recorded in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
