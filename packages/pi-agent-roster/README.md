# pi-agent-roster

A Pi extension for primary-agent profiles and subagent orchestration. Version 0.0.0 is
the Phase 1 compatibility gate: it registers `--roster-name`, `/roster-status`, and the
TypeBox-backed `roster_noop` tool without changing user state.

## Compatibility

The package peers with Pi 0.84.x and is developed against exactly 0.84.3. Extension code
imports only public package roots, including `@earendil-works/pi-coding-agent`; it does
not rely on internal or deep Pi paths.

[Pi issue #8620](https://github.com/earendil-works/pi/issues/8620) remains open for
installed CLI resolution of internal/deep paths. The installed-package smoke test passes
on the exact 0.84.3 npm CLI with public-root imports. Do not work around a future failure
by switching the test to an unbundled Pi entrypoint: it blocks publishing until the peer
floor and compatibility evidence are updated together.

## Verification

```sh
npm run smoke:installed
```

The fixture packs this package, installs the tarball and exact peers into a fresh
filesystem tree, launches the npm CLI in RPC mode with a new Pi home, then verifies the
extension-owned flag and command and its registered no-op tool.
