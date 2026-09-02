# Releasing

This repository uses Changesets for local npm releases. Future changes to published packages use a changeset.

## Normal release

1. Add a changeset for each changed package that is already published.
2. Run `npm run release:version`, then commit the generated version, changelog, and lockfile changes.
3. Run `npm run release:plan` to preview every unpublished workspace version.
4. Run `npm run release:publish` to verify and publish all eligible workspaces independently.

The initial `@godtamit/pi-agent-browser` `0.1.0` release is publishable without a changeset because that package is absent from npm. Do not add an initial-release changeset for it.

Publishing requires npm authentication and publish access. Follow npm's account-specific 2FA and provenance requirements in the environment where publishing runs; this repository provides no GitHub workflow or other publishing automation.
