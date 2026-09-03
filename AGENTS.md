# Repository rules

## Extension UX

- Treat the TUI as the primary product surface. New extension features must be complete, readable, keyboard-operable, and visually consistent with Pi in the TUI; RPC support is required, not a substitute for the TUI experience.
- Keep behavior and presentation separate. Tool results must always contain useful model-facing `content` and structured `details`; `renderCall` and `renderResult` only enhance their TUI presentation.
- Use `ctx.hasUI` for `select`, `confirm`, `input`, `editor`, notifications, statuses, string widgets, titles, and editor text because these work in both TUI and RPC modes. Use `ctx.mode === "tui"` for terminal-only APIs such as `custom()`, component factories, direct terminal input, and custom editor/header/footer components.
- Every TUI-only interaction must have an intentional RPC path. Prefer the RPC-capable `ctx.ui` primitives; otherwise provide a clear protocol-visible text interaction or result instead of silently returning, hanging, or relying on `custom()`.
- JSON and print modes cannot prompt. They must still produce useful non-interactive output or an actionable error.
- TUI components must use the supplied theme and keybindings, handle cancel/escape where applicable, invalidate through the TUI rather than polling, and keep every rendered line within the supplied width. Test narrow and wide layouts, input handling, and cleanup of statuses/widgets.
- RPC tests must cover the interaction/result path, not only process startup. RPC widgets use string arrays; do not depend on component widgets or other APIs documented as no-ops/defaults in RPC mode.

## Code conventions

- Use TypeScript, ESM, and the strict settings in `tsconfig.base.json`. Preserve explicit file extensions in imports and follow each package's existing source-versus-built import convention.
- Use two spaces, 100-column lines, double quotes, semicolons, and the recommended lint rules repository-wide, except for configured generated/build artifacts.
- Add focused tests for changed behavior. Use Vitest where the package already uses Vitest and `node:test` where the package already uses `node:test`; do not introduce a second test style into a package.
- Do not hand-edit generated documentation regions. Update their source and regenerate them. For browser contract changes, update the canonical document named in `packages/pi-agent-browser/docs/SOURCE_OF_TRUTH.md` and its tests.

## Package conventions

- Packages live under `packages/*` and are ESM npm packages. Keep package metadata complete: repository directory, homepage, bugs URL, MIT license, Node engine, `pi-package` keyword, public `exports`, and the `pi.extensions` entry.
- Publish only intentional files. Include the relevant source or build output, declarations, README, changelog, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and required runtime assets. Verify the packed artifact rather than assuming workspace resolution matches an installed package.
- Pi runtime packages belong in `peerDependencies` with the supported compatibility range and in `devDependencies` at the exact version used for development. Keep dependency saves exact and commit `package-lock.json`; use the repository's pinned npm version.
- Each package must expose the applicable `typecheck`, `unit`, `test`, `declarations`/build, `prepack`, `pack:inspect`, and `smoke:installed` scripts so root workspace commands remain authoritative.
- Add a Changeset for changes to an already-published package. Do not publish or run release versioning unless explicitly requested.

## Licenses and provenance

- Repository and package code is MIT-licensed. Keep the root license and a `LICENSE` file in every published package.
- Preserve all existing donor copyright, license text, pinned revision, and path-level provenance in `THIRD_PARTY_NOTICES.md` and package notice files.
- When copying or adapting third-party code, verify license compatibility and update the relevant notice with the upstream project, author, license, pinned commit or version, source path, and adapted destination path. Do not describe reference-only code as copied code.
- Keep notice files in package manifests so they are present in published tarballs.

## Validation

- Run the narrow package checks while iterating. Before completing repository-wide changes, run `npm run verify`; run `npm run verify:all` when packaging, exports, extension loading, or installed behavior changes.
