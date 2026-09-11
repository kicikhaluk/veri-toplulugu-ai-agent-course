# Ops Log — Monday

- 09:14 — Deploy of `billing-service` v2.14.0 completed without incident. Rollout took 6 minutes across 3 regions (us-east, us-west, eu-central).
- 10:02 — Elevated 5xx rate on `checkout-api` for ~4 minutes, peaking at 2.1%. Root cause: a connection pool exhaustion against the `payments` read replica during the billing-service rollout. Pool size was bumped from 20 to 40 as a mitigation; no customer-facing tickets were filed.
- 13:47 — Scheduled maintenance window for the `search-index` cluster. Reindexing took 38 minutes. Search latency (p99) was elevated to ~800ms during the window, back to baseline (~120ms) immediately after.
- 16:20 — On-call rotation handed off from Priya to Marcus. No open incidents at handoff.
- 17:55 — A single node in the `notifications` worker pool was replaced after repeated OOM kills; suspected memory leak in the digest-email batching path, ticket NOTIF-482 filed for follow-up.

Notes for tomorrow: keep an eye on the `payments` read replica pool utilization now that it's at 40; if it climbs past 70% sustained, we may need to add a fourth replica instead of just widening the pool.
