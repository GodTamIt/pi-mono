# Changelog

## 0.2.0

### Minor Changes

- 8c0c6fb: Add a rolling 30-day Month window to the Overview, Models, and Delegation usage views,
  available from the TUI with `m` and from the RPC action menu.

### Patch Changes

- 0fc067d: Classify OpenAI Codex quota windows by their reported duration so weekly-only Pro quotas are not mislabeled as 5-hour quotas.
- 9e5334c: Fix TUI redraw corruption after visiting the Delegation tab: sanitize session-derived task, parent, agent-type, and status text so rendered lines never contain embedded newlines, tabs, or escape bytes. Previously one logical line could wrap into extra physical terminal rows, desyncing pi-tui's differential renderer and leaving stale rows, a duplicated header, and remnants of adjacent tabs when switching views or closing the panel.

## 0.1.0

### Minor Changes

- 64d2adf: Introduce the @ohgodtamit/pi-usage package with cost and token attribution, live provider quotas, incremental caching, model-registry credential resolution, and complete usage and provenance documentation.
- 64d2adf: Add an eight-view keyboard TUI with RPC-compatible paginated rendering and navigation, delegation analytics, progress and freshness reporting, headless guards, and broad provider compatibility.

## 0.1.0-alpha.0

### Minor Changes

- 615f326: Introduce the @ohgodtamit/pi-usage package with cost and token attribution, live provider quotas, incremental caching, model-registry credential resolution, and complete usage and provenance documentation.
- e01c7c9: Add an eight-view keyboard TUI with RPC-compatible paginated rendering and navigation, delegation analytics, progress and freshness reporting, headless guards, and broad provider compatibility.
