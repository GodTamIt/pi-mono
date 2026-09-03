# Third-Party Notices

## `@zaganjade/pi-usage@1.9.2`

`@ohgodtamit/pi-usage` is a fork of `@zaganjade/pi-usage` 1.9.2 by ZaganJade, licensed under the MIT License.

- Pinned commit: `2de5ac6bd6a802338d78e9daba1f29a4a74e29d3`
- Pinned source: https://github.com/ZaganJade/pi-extension/tree/2de5ac6bd6a802338d78e9daba1f29a4a74e29d3/usage
- Author: ZaganJade
- License: MIT

## Path-level derivation inventory

Paths are relative to the package root. Every listed donor path is pinned to the commit above and is authored by ZaganJade under the MIT License.

| Destination path | Donor path | Derivation |
| --- | --- | --- |
| `src/{config.ts,format.ts,freshness.ts,prices.ts,zai.ts}` | `usage/src/{config.ts,format.ts,freshness.ts,prices.ts,zai.ts}` | Copied; formatting-only changes may be applied by this repository. |
| `src/aggregate.ts` | `usage/src/aggregate.ts` | Adapted on top of the donor scanner: recursive delegated child discovery, optional `subagents:record` enrichment, direct/delegated partitions, token-composition totals, and concurrency statistics. Core attribution (model/project/skill/bundle/plugin/tool) is retained donor code. |
| `src/cache.ts` | `usage/src/cache.ts` | Adapted for cache v6: raw per-session child summaries, per-file delegation records, exclusion fingerprints, and the reworked entry shape. Donor structure and load/save behavior retained. |
| `src/view.ts` | `usage/src/view.ts` | Adapted to add the Delegation view and a final line-width clamp, rename the Agents view to Providers, and render token composition and concurrency stats. Donor view layout, quota bars, and other views are retained. |
| `src/mascot.ts` | `usage/src/mascot.ts` | Adapted to add the Delegation view tab and rename the Agents tab to Providers. Donor poses, glyphs, and captions are retained. |
| `src/index.ts` | `usage/src/index.ts` | Adapted to pass the extension context's model registry into provider credential resolution and to register the new `/usage-delegation` and `/usage-providers` commands (with `/usage-agents` kept as an alias). Commands, widget behavior, and UI behavior are otherwise retained. |
| `src/provider.ts` | `usage/src/provider.ts` | Adapted to replace unavailable `AuthStorage` methods with public model-registry credential APIs and derive the Codex account ID from the refreshed access token. |
| `test/{freshness.test.ts,provider.test.ts}` | `usage/src/{freshness.test.ts,provider.test.ts}` | Copied upstream behavioral tests (kept out of the published tarball); test-runner imports adapted to the repository's Vitest workspace. |
| `test/provider-credentials.test.ts` | `usage/src/provider.ts` | Local regression tests for the adapted credential and Codex quota behavior. |

`test/aggregate.test.ts` and `test/discovery.test.ts` are new local work and are not adapted from donor code.

Pinned source URLs for each row are formed by appending the donor path to https://github.com/ZaganJade/pi-extension/blob/2de5ac6bd6a802338d78e9daba1f29a4a74e29d3/ (use `/tree/` for grouped paths).

## Retained donor license text

MIT License

Copyright (c) 2026 ZaganJade

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
