# @ohgodtamit/pi-tps

TPS (tokens per second) stats widget with waterfall trace visualization for
[Pi](https://github.com/earendil-works/pi).

Direct fork of [summertime-wu/pi-tps](https://github.com/summertime-wu/pi-tps),
upstream version 1.0.1 at commit `0e1b4e2b274fb2170c980a6e87f9a4baebac4737`.
This fork starts at version 1.0.0 and adapts the extension to current Pi APIs and modes.

![pi-tps upstream preview](https://pic1.imgdb.cn/item/69f9fb66a5f82cd27f48c614.png)

## Features

- Real-time TPS (tokens per second) display
- Token usage tracking (input/output)
- Waterfall trace visualization
- Tool call monitoring
- Thinking token stats
- TTFT (time to first token) tracking
- Color presets (morandi, forest, ocean, retro, ice, dusk, mono, nord)

TPS counts all generated output, including thinking and text, over the same generation
interval, from the first thinking or text delta until generation ends. It is not a text-only
rate with thinking time subtracted. Live output figures use provider-reported usage when the
provider streams it and fall back to character-based estimates (thinking ÷4, text ÷3.5)
otherwise; thinking-token figures are always estimated. Final output totals always use the
provider's reported usage.

## Install

```bash
pi install npm:@ohgodtamit/pi-tps@1.0.0
```

Requires Node.js 22.22.2 or newer and Pi `>=1.0.4 <1.2.0`. Installed smoke coverage targets
Pi 1.0.4 and 1.1.0.

## Usage

The widget appears automatically above the editor in the Pi TUI.

### Commands

- `/pi-tps` - Configure display settings using the keyboard-operated settings picker

RPC clients can invoke `/pi-tps` via `prompt`, respond to the forwarded `select` and `input`
dialogs, and receive configuration notifications and plain string widgets. Terminal-only
presentation is not available over RPC. Print and JSON modes do not prompt or render the
widget; the configuration command reports that an interactive TUI or RPC client is needed.

### Configuration

Config file: `~/.pi/agent/pi-tps.json` (unchanged from upstream).

```json
{
  "showTraces": true,
  "showStats": true,
  "showTtft": false,
  "colorPreset": "mono",
  "maxTraces": 100,
  "maxDetailed": 6
}
```

## Development

```bash
npm run typecheck --workspace @ohgodtamit/pi-tps
npm run unit --workspace @ohgodtamit/pi-tps
npm run pack:inspect --workspace @ohgodtamit/pi-tps
PI_TPS_CLI_VERSION=1.0.4 npm run smoke:installed --workspace @ohgodtamit/pi-tps
PI_TPS_CLI_VERSION=1.1.0 npm run smoke:installed --workspace @ohgodtamit/pi-tps
```

Installed smoke defaults to Pi 1.1.0 and uses a temporary home and an isolated npm install.
No provider credentials are required; it exercises configuration without a model request.

## Release

Releases use the root [Changesets workflow](../../RELEASING.md). For the currently prepared
`1.0.0` release, the version, changelog, and lockfile have already been generated. Commit the
prepared changes, then run `npm run release:plan` (confirm only `@ohgodtamit/pi-tps@1.0.0`
with tag `latest`) and `npm run release:publish` from the repository root.

## License

MIT. [LICENSE](./LICENSE) applies to local changes. Upstream declares MIT in its README
and package metadata but provides no LICENSE file or copyright notice at the pinned revision.
See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for provenance.
