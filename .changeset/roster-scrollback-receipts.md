---
"pi-agent-roster": patch
---

Stop offscreen subagent tool rows from erasing terminal scrollback. Settled native rows are now immutable receipts: background launches render a frozen "Background request accepted" receipt with a hint to `get_subagent_result` / `/subagents:sessions`, and completed foreground rows freeze their final output and transcript. Settled rows no longer read the live child record or clock and release their child subscriptions, so later activity, completion, resume, or theme renders cannot change them.