# Pi plugins

Focused extensions for [Pi](https://github.com/earendil-works/pi) with installed-package verification, typed public surfaces, and deliberately empty defaults.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./packages/pi-agent-roster/media/terminal-dark.svg">
  <img src="./packages/pi-agent-roster/media/terminal-light.svg" alt="Sanitized Pi terminal showing Agent Roster running two background agents while a third waits in the concurrency queue." width="1200">
</picture>

## Catalog

### [`pi-agent-roster`](./packages/pi-agent-roster/README.md)

Primary-agent profiles and in-process subagent orchestration for Pi.

- **Bring your own roster.** No agent definitions ship in the package; project and global Markdown profiles opt in explicitly.
- **One profile format.** Use an agent as a primary, a subagent, or both, with per-agent tools, prompts, delegation policy, models, thinking, and turn budgets.
- **Switch models quickly.** Named stacks are reusable model/thinking presets that let you switch between authenticated models without editing agent definitions.
- **Observable work.** Foreground progress, a live background tree, completion notifications, expandable tool rows, and a read-only child-session viewer stay inside Pi's TUI.
- **Controlled lifecycle.** FIFO background admission, steering, result collection, transcript-backed resume, bounded child shutdown, retention, and an optional workspace-isolation seam.
- **Extension API.** Other Pi extensions can spawn, inspect, resume, steer, abort, await, and isolate children through a typed service.

[Package guide](./packages/pi-agent-roster/README.md) · [recording source](./packages/pi-agent-roster/media/quick-start.cast) · [deterministic recording fallback](./packages/pi-agent-roster/media/quick-start.svg)

<details>
<summary>Narrow-terminal preview</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./packages/pi-agent-roster/media/terminal-narrow-dark.svg">
  <img src="./packages/pi-agent-roster/media/terminal-narrow-light.svg" alt="A 46-column Pi terminal where Agent Roster wraps stack, model, usage, task, and activity details without clipping." width="520">
</picture>

</details>

## Release status

`pi-agent-roster` is currently an unreleased `0.0.0` package. Its peer range is Pi `>=0.84.3 <0.85.0`, and compatibility is exercised against the exact `0.84.3` npm CLI on Node `>=22.22.2`.

No npm release exists. The release workflow is manually gated and requires the installed-tarball smoke; it must not be bypassed with an unbundled CLI entrypoint or a wider peer range without matching installed-CLI evidence.

## Development

Use Node 24 by default:

```sh
nix develop
npm ci
npm run verify:all
```

The Node 22 compatibility shell uses the same locked Nixpkgs revision:

```sh
nix develop .#ci
npm ci
npm run verify:all
```

The shells provide Node, the fixed-output npm 12.0.2 wrapper, and Git. Entering a shell does not install dependencies or mutate package-manager state.

## Provenance and license

The repository is MIT licensed. `pi-agent-roster` adapts MIT-licensed subagent work with a pinned, path-level attribution inventory in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md). All media in this repository is original, deterministic, sanitized, and contains no copied upstream artwork.
