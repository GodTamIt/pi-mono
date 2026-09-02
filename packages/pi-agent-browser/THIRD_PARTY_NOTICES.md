# Third-Party Notices

This package is a partial fork of `pi-agent-browser-native`.

## Donor and pinned revision

- Repository: https://github.com/fitchmultz/pi-agent-browser-native
- Pinned commit: https://github.com/fitchmultz/pi-agent-browser-native/tree/5460058d7544c6c8b67e039780801539d20440fd
- Adopted PATH-safe `ps` change reference: https://github.com/fitchmultz/pi-agent-browser-native/commit/540f3ce8230b952bc4e3b84a15968900ddda4408
- Author: Mitch Fultz
- License: MIT

## Path inventory

| Destination | Donor path |
| --- | --- |
| `extensions/agent-browser/**` | `extensions/agent-browser/**` |
| `scripts/{agent-browser-capability-baseline,agent-browser-target,build,config,doctor}.mjs` | same paths |
| `docs/{ARCHITECTURE,COMMAND_REFERENCE,ELECTRON,REQUIREMENTS,SUPPORT_MATRIX,TOOL_CONTRACT}.md` | same paths |
| `test/**/*.test.ts`, `test/fixtures/**`, `test/helpers/**` | same paths |
| `tsconfig.json`, `tsconfig.build.json` | same paths |

Local package/publication scaffolding, identity changes, lock discovery hardening, runtime version policy, and lean prompt changes are not claimed as unmodified donor code.

## Retained donor license

MIT License

Copyright (c) 2026 Mitch Fultz

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
