# Changelog

## Unreleased

- Discover nested generic child-session transcripts and account delegated turns without a roster dependency or parent-summary double counting.
- Add Delegation analytics with direct/delegated composition, optional `subagents:record` metadata, child and parent groupings, and inferred/recorded concurrency intervals.
- Add token and component-cost composition, including cache writes, reasoning-as-output, and cache-input reuse ratio.
- Rename Agents to Providers (`/usage-providers`), retaining `/usage-agents` as an alias; add `/usage-delegation` and eight-view navigation.
- Bump the incremental cache to v6, include project exclusions in validity, and retain raw delegation metadata for cached post-assembly enrichment.

## 0.1.0

- Publish as `@ohgodtamit/pi-usage`, forked from `@zaganjade/pi-usage` 1.9.2 with its full usage dashboards, attribution views, widget, and provider quota integrations.
- Resolve extension credentials through Pi's public model registry API, including refreshed Codex OAuth tokens and account IDs.
