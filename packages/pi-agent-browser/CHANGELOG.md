# Changelog

## 0.1.2

### Patch Changes

- Correct published docs to match the shipped 0.1.1 compatibility: Pi `>=0.84.0 <0.86.0` in README and the support matrix runtime floor note, exact 0.85.0 validation pins, the 0.84.0 doctor floor, and the release-process row in the docs source of truth.

## 0.1.1

### Patch Changes

- cfe7b32: Resolve Biome lint failures in browser runtime helpers without changing behavior.
- Extend Pi compatibility to `>=0.84.0 <0.86.0`, lowering the minimum from 0.84.3 to 0.84.0 and adding the 0.85.x line. Development/test pins and smoke fixtures use exact Pi 0.85.0; the browser doctor's runtime floor is now 0.84.0.

## 0.1.0

- Forked the production extension, public docs, diagnostics, and behavioral tests from `pi-agent-browser-native` at pinned commit `5460058d7544c6c8b67e039780801539d20440fd`.
- Added PATH-safe, non-shell POSIX `ps` discovery for managed-session policy locks.
- Removed runtime capability-version blocking while retaining binary and malformed-execution validation.
- Reduced always-on model guidance to the native-tool workflow essentials; detailed guidance remains in installed docs.
