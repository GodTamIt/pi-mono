# Release guide

This guide covers stable npm releases of `@ohgodtamit/pi-agent-browser` from this fork.
Run every command from the repository root. Releases use the normal Changesets flow; there
are no initial-release exceptions or prerelease-mode workarounds.

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

## Confirm the release plan

Add a changeset for the release, then run the versioning step and commit the generated version,
changelog, and lockfile changes before continuing:

```sh
npm run release:version
```

Preview the release plan and abort unless it lists exactly the approved packages and tags:

```sh
npm run release:plan
```

A package-only release requires every other workspace to remain listed in `ignore` in
`.changeset/config.json`. Packages outside the ignore list are published by the shared release
commands, so only the approved release's workspace may be absent from that list, and only while
its release is being prepared.

## Registry preflight

Derive the version under release from the workspace manifest instead of hardcoding it, and use
the public npm registry explicitly so local registry configuration cannot redirect the check.
The exact-version lookup should return `E404`; any published result means that version is already
occupied and must not be overwritten.

```sh
VERSION=$(node -p "require('./packages/pi-agent-browser/package.json').version")
npm config get registry
npm whoami --registry=https://registry.npmjs.org/
npm view @ohgodtamit/pi-agent-browser@"$VERSION" name version dist-tags --registry=https://registry.npmjs.org/
```

Confirm the working tree and package version are the intended release inputs before continuing.

## Publish

After the checks, plan confirmation, and registry preflight pass, publish through the root release
command, which verifies all workspaces and publishes the eligible ones:

```sh
npm run release:publish
```

Publishing requires npm authentication and publish access. Follow npm's account-specific 2FA and
provenance requirements in the environment where publishing runs; this repository provides no
GitHub workflow or other publishing automation. Do not run publishing from automation or as part
of validation.

## Verify after publishing

Check the exact version and stable tag against the public registry:

```sh
VERSION=$(node -p "require('./packages/pi-agent-browser/package.json').version")
npm view @ohgodtamit/pi-agent-browser@"$VERSION" name version dist.tarball --registry=https://registry.npmjs.org/
npm view @ohgodtamit/pi-agent-browser dist-tags --registry=https://registry.npmjs.org/
```

Verify that `latest` points to the published `$VERSION` before announcing the release.
