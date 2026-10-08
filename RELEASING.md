# Releasing

This repository uses Changesets for local npm releases, including initial releases.

## Normal release

1. Add a changeset for each changed package. For a new package's initial `1.0.0` release, start its version at `0.0.0` and add a major changeset.
2. Run `npm run release:version`, then commit the generated version, changelog, and lockfile changes.
3. Run `npm run release:plan` to preview every unpublished workspace version.
4. Run `npm run release:publish` to verify and publish all eligible workspaces independently.

Historical exception: the initial `@ohgodtamit/pi-agent-browser` `0.1.0` release was published without a changeset because the package was absent from npm. That exception is retired. All subsequent browser releases, like every other release in this repository, use the normal Changesets flow: add a changeset, run `npm run release:version`, and publish with `npm run release:publish`.

Publishing requires npm authentication and publish access. Follow npm's account-specific 2FA and provenance requirements in the environment where publishing runs; this repository provides no GitHub workflow or other publishing automation.

## Release isolation

Stable and prerelease publishing can include every eligible workspace; Changesets prerelease mode also applies its dist-tag to every publishable workspace. Packages that are not approved for the active release must be listed in `.changeset/config.json` under `ignore`. A package-only release requires every other workspace to remain ignored. Remove a package from that list only when preparing its release, and abort unless `npm run release:plan` contains exactly the intended packages and tags.
