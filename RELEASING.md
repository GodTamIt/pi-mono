# Releasing

This repository uses Changesets for local npm releases. Future changes to published packages use a changeset.

## Normal release

1. Add a changeset for each changed package that is already published.
2. Run `npm run release:version`, then commit the generated version, changelog, and lockfile changes.
3. Run `npm run release:plan` to preview every unpublished workspace version.
4. Run `npm run release:publish` to verify and publish all eligible workspaces independently.

The initial `@ohgodtamit/pi-agent-browser` `0.1.0` release is publishable without a changeset because that package is absent from npm. Do not add an initial-release changeset for it.

Publishing requires npm authentication and publish access. Follow npm's account-specific 2FA and provenance requirements in the environment where publishing runs; this repository provides no GitHub workflow or other publishing automation.

## Release isolation

Changesets prerelease mode applies its dist-tag to every publishable workspace. Packages that are not approved for the active release are listed in `.changeset/config.json` under `ignore`. Remove a package from that list only when preparing its release, and abort unless `npm run release:plan` contains exactly the intended packages and tags.
