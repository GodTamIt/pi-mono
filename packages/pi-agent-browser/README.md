# @godtamit/pi-agent-browser

A lean native [agent-browser](https://agent-browser.dev/) integration for Pi. This package is a partial fork of [`pi-agent-browser-native`](https://github.com/fitchmultz/pi-agent-browser-native) and retains the public tools `agent_browser` and `agent_browser_web_search`, plus the `pi-agent-browser-doctor` and `pi-agent-browser-config` bins.

## Benefits

- **PATH-safe process discovery.** Managed-session lock ownership resolves POSIX `ps` without assuming `/bin/ps` or `/usr/bin/ps`, including Nix-style systems.
- **No brittle runtime exact-version gate.** Different valid `agent-browser` versions can run; doctor reports baseline drift as an advisory recommendation. Missing binaries and malformed executions still fail clearly.
- **Lean prompt overhead.** Only essential workflow invariants are injected on every turn; the detailed command and result contract stays in installed docs.

## Install

```sh
pi install npm:@godtamit/pi-agent-browser
npm install -g agent-browser
pi-agent-browser-doctor
```

The package does not bundle the upstream `agent-browser` binary.

## Essential workflow

Use one input mode per call. The common flow is `open` → `snapshot -i` → interact with current `@refs` → re-snapshot after page changes. Use `sessionMode: "fresh"` for new launch-scoped flags. Preserve exact requested artifact paths, verify `details.artifactVerification`, and follow exact `details.nextActions` payloads when present.

Configuration is stored under `.pi/config/pi-agent-browser/config.json` or `~/.pi/config/pi-agent-browser/config.json`. Run `pi-agent-browser-config --help` for setup commands.

## Reference

- [Command reference](docs/COMMAND_REFERENCE.md)
- [Tool contract](docs/TOOL_CONTRACT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Electron workflows](docs/ELECTRON.md)
- [Requirements and support](docs/REQUIREMENTS.md), [support matrix](docs/SUPPORT_MATRIX.md)

## Development

```sh
npm run typecheck --workspace @godtamit/pi-agent-browser
npm run unit --workspace @godtamit/pi-agent-browser
npm run pack:inspect --workspace @godtamit/pi-agent-browser
npm run smoke:installed --workspace @godtamit/pi-agent-browser
```

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for pinned donor provenance and retained MIT attribution.
