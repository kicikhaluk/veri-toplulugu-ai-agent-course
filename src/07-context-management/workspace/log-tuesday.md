# Ops Log — Tuesday

- 08:30 — Morning check: `payments` read replica pool utilization peaked at 51% overnight, below the 70% follow-up threshold from Monday's notes. No action needed yet.
- 11:15 — NOTIF-482 (notifications worker OOM) root-caused: the digest-email batching path was holding references to full recipient objects instead of just IDs, so batch size scaled with payload size instead of recipient count. Fix merged and deployed to staging.
- 12:40 — `search-index` reindex from Monday verified healthy; p99 latency has been stable at ~115ms since.
- 15:05 — Brief spike in `checkout-api` 5xx (0.6% for under a minute) during a routine `payments` replica failover. Self-recovered, no mitigation needed — the widened connection pool from Monday absorbed it cleanly.
- 18:02 — NOTIF-482 fix promoted to production. Worker pool memory usage now flat over a 3-hour soak test, versus the previous sawtooth pattern.

Notes for tomorrow: NOTIF-482 fix looks solid in prod so far — close the ticket if memory stays flat through Wednesday morning. No other open threads.
