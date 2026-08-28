# Third-Party Notices

This project adapts the in-process subagent implementation from
`@gotgenes/pi-subagents`. The notices and provenance below apply to the
adapted source and behavioral tests.

## Attribution chain

### Primary adapted donor: `@gotgenes/pi-subagents@19.3.5`

- **Repository and pinned commit:** https://github.com/gotgenes/pi-packages/tree/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents
- **Author:** Chris Lasher
- **License:** MIT
- **Donor license text:** https://github.com/gotgenes/pi-packages/blob/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/LICENSE

This is a friendly fork of the original `@tintinweb/pi-subagents` project.

### Original donor: `@tintinweb/pi-subagents@v0.10.3`

- **Repository and pinned commit:** https://github.com/tintinweb/pi-subagents/tree/0e392601d4a19a34464b0dde00bdaa27f4e63894
- **Author:** tintinweb
- **License:** MIT

### Semantic reference: `pi-open-agents@0.1.17`

- **Repository and pinned commit:** https://github.com/andrea-tomassi/pi-open-agents/tree/cff2e177b9ae48bb3977adc09ba0720a244aa16a
- **Author:** Andrea Tomassi
- **License:** MIT
- **License text:** https://github.com/andrea-tomassi/pi-open-agents/blob/cff2e177b9ae48bb3977adc09ba0720a244aa16a/LICENSE

`pi-open-agents` is a provenance and semantic reference in the current project,
not copied local code. Every adapted local path below has a gotgenes source
mapping, so no adapted local path is attributed to copied `pi-open-agents` code.

The following are the upstreams declared by `pi-open-agents`:

- **`ZGltYQ/agent-mode`** — https://github.com/ZGltYQ/agent-mode/tree/751abef9820e673f5a07d1516ac86c7bfa76a95b; author ZGltYQ; license MIT.
- **`jwu/pi-subagents`** — https://github.com/jwu/pi-subagents/tree/6c568dd1b08ea59dfb924e20a66c40eab2f18235b; author jwu; license MIT; `Copyright (c) 2026 jwu` (license: https://github.com/jwu/pi-subagents/blob/6c568dd1b08ea59dfb924e20a66c40eab2f18235b/LICENSE).
- **`anomalyco/opencode`** — https://github.com/anomalyco/opencode/tree/cfddb2407cb6343aaa221a6aa72222b8fdd325d7; author anomalyco; license MIT; `Copyright (c) 2025 opencode` (license: https://github.com/anomalyco/opencode/blob/cfddb2407cb6343aaa221a6aa72222b8fdd325d7/LICENSE).

## Path-level derivation inventory

Paths are relative to each repository's package root. A `**` glob covers the
same relative files in both the destination and source paths. All source URLs
are pinned to the donor commit shown above. The adapted source author is Chris
Lasher and the license is MIT for every row.

| Destination path | Adapted source path | Pinned source URL | Author | License |
| --- | --- | --- | --- | --- |
| `packages/pi-agent-roster/src/config/{agent-types.ts,custom-agents.ts,invocation-config.ts}` | `packages/pi-subagents/src/config/{agent-types.ts,custom-agents.ts,invocation-config.ts}` | https://github.com/gotgenes/pi-packages/tree/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/config | Chris Lasher | MIT |
| `packages/pi-agent-roster/src/handlers/**` | `packages/pi-subagents/src/handlers/**` | https://github.com/gotgenes/pi-packages/tree/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/handlers | Chris Lasher | MIT |
| `packages/pi-agent-roster/src/lifecycle/**` | `packages/pi-subagents/src/lifecycle/**` | https://github.com/gotgenes/pi-packages/tree/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/lifecycle | Chris Lasher | MIT |
| `packages/pi-agent-roster/src/session/**` | `packages/pi-subagents/src/session/**` | https://github.com/gotgenes/pi-packages/tree/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/session | Chris Lasher | MIT |
| `packages/pi-agent-roster/src/observation/**` | `packages/pi-subagents/src/observation/**` | https://github.com/gotgenes/pi-packages/tree/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/observation | Chris Lasher | MIT |
| `packages/pi-agent-roster/src/service/**` | `packages/pi-subagents/src/service/**` | https://github.com/gotgenes/pi-packages/tree/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/service | Chris Lasher | MIT |
| `packages/pi-agent-roster/src/tools/**` | `packages/pi-subagents/src/tools/**` | https://github.com/gotgenes/pi-packages/tree/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/tools | Chris Lasher | MIT |
| `packages/pi-agent-roster/src/ui/**` | `packages/pi-subagents/src/ui/**` | https://github.com/gotgenes/pi-packages/tree/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/ui | Chris Lasher | MIT |
| `packages/pi-agent-roster/src/layered-settings.ts` | `packages/pi-subagents/src/layered-settings.ts` | https://github.com/gotgenes/pi-packages/blob/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/layered-settings.ts | Chris Lasher | MIT |
| `packages/pi-agent-roster/src/settings.ts` | `packages/pi-subagents/src/settings.ts` | https://github.com/gotgenes/pi-packages/blob/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/settings.ts | Chris Lasher | MIT |
| `packages/pi-agent-roster/src/runtime.ts` | `packages/pi-subagents/src/runtime.ts` | https://github.com/gotgenes/pi-packages/blob/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/runtime.ts | Chris Lasher | MIT |
| `packages/pi-agent-roster/src/types.ts` | `packages/pi-subagents/src/types.ts` | https://github.com/gotgenes/pi-packages/blob/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/types.ts | Chris Lasher | MIT |
| `packages/pi-agent-roster/src/debug.ts` | `packages/pi-subagents/src/debug.ts` | https://github.com/gotgenes/pi-packages/blob/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/debug.ts | Chris Lasher | MIT |
| `packages/pi-agent-roster/src/index.ts` (merged) | `packages/pi-subagents/src/index.ts` | https://github.com/gotgenes/pi-packages/blob/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/index.ts | Chris Lasher | MIT |
| `packages/pi-agent-roster/test/agent-conversation.test.ts` | `packages/pi-subagents/test/agent-conversation.test.ts` | https://github.com/gotgenes/pi-packages/blob/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/test/agent-conversation.test.ts | Chris Lasher | MIT |
| `packages/pi-agent-roster/test/helpers/test-agents.ts` | `packages/pi-subagents/src/config/default-agents.ts` | https://github.com/gotgenes/pi-packages/blob/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/src/config/default-agents.ts | Chris Lasher | MIT |
| `packages/pi-agent-roster/test/{config/**,handlers/**,helpers/**,lifecycle/**,observation/**,service/**,session/**,tools/**,ui/**}` | `packages/pi-subagents/test/{config/**,handlers/**,helpers/**,lifecycle/**,observation/**,service/**,session/**,tools/**,ui/**}` | https://github.com/gotgenes/pi-packages/tree/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/test | Chris Lasher | MIT |
| `packages/pi-agent-roster/test/{debug.test.ts,display.test.ts,layered-settings.test.ts,print-mode.test.ts,runtime.test.ts,settings.test.ts,widget-renderer.test.ts}` | `packages/pi-subagents/test/{debug.test.ts,display.test.ts,layered-settings.test.ts,print-mode.test.ts,runtime.test.ts,settings.test.ts,widget-renderer.test.ts}` | https://github.com/gotgenes/pi-packages/tree/81e19880618d8bbb79e7f088e6b7122a3a0b29ef/packages/pi-subagents/test | Chris Lasher | MIT |

The package scaffold's `src/public.ts`, `test/extension.test.ts`, and
`test/installed/**` are local package/publication scaffolding and are not
claimed as adapted paths in this inventory.

No upstream media were copied or adapted.

## Retained upstream license texts

The following license blocks are reproduced verbatim from the pinned donor
files linked above.

MIT License

Copyright (c) 2026 tintinweb

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

MIT License

Copyright (c) 2026 Andrea Tomassi

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
