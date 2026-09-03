# Release guide

This guide covers stable npm releases of `@ohgodtamit/pi-agent-browser` from this fork.
Run every command from the repository root and keep the release scoped to this workspace.

## Validate the package

Use the focused package checks; the `unit` script is intentionally curated rather than an all-files,
one-process run.

```sh
npm run format:check -- packages/pi-agent-browser
npm run lint -- packages/pi-agent-browser
npm run typecheck --workspace @ohgodtamit/pi-agent-browser
npm run unit --workspace @ohgodtamit/pi-agent-browser
npm run declarations --workspace @ohgodtamit/pi-agent-browser
npm run pack:inspect --workspace @ohgodtamit/pi-agent-browser
npm run smoke:installed --workspace @ohgodtamit/pi-agent-browser
```

Inspect the dry-run file list and metadata reported by `pack:inspect`. It must include the root
extension export, public bins, canonical docs, license, and notices, without tests or TypeScript
sources.

## Registry preflight

Use the public npm registry explicitly so local registry configuration cannot redirect the check.
For the initial release, the exact-version lookup should return `E404`; any published result means
that version is already occupied and must not be overwritten.

```sh
npm config get registry
npm whoami --registry=https://registry.npmjs.org/
npm view @ohgodtamit/pi-agent-browser@0.1.0 name version dist-tags --registry=https://registry.npmjs.org/
```

Confirm the working tree and package version are the intended release inputs before continuing.

## Publish the current stable release

The repository's root changeset state is in `pi-usage` alpha prerelease mode. Do **not** use root
changeset publish or any `release:*` command for this stable package release. After the checks and
registry preflight pass, the currently approved targeted command is:

```sh
npm publish --workspace @ohgodtamit/pi-agent-browser --access public --tag latest
```

Do not run it from automation or as part of validation; publishing requires explicit maintainer
authorization.

## Verify after publishing

Check the exact version and stable tag against the public registry:

```sh
npm view @ohgodtamit/pi-agent-browser@0.1.0 name version dist.tarball --registry=https://registry.npmjs.org/
npm view @ohgodtamit/pi-agent-browser dist-tags --registry=https://registry.npmjs.org/
```

Verify that the exact version is `0.1.0` and `latest` points to `0.1.0` before announcing the
release.
