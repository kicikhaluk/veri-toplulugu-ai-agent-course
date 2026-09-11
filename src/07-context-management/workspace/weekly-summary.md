# Weekly Operations Summary

## NOTIF-482: Notifications Memory Leak — Full Incident Arc

### Opening (Monday 17:55)
A single node in the `notifications` worker pool was replaced after repeated OOM (out-of-memory) kills. The suspected root cause was a memory leak in the digest-email batching path, and ticket NOTIF-482 was filed for follow-up investigation.

### Root Cause Analysis (Tuesday 11:15)
The memory leak was root-caused: the digest-email batching path was holding references to full recipient objects instead of just IDs. This meant batch size scaled with payload size rather than recipient count, causing unbounded memory growth as batches accumulated.

### Resolution (Tuesday 18:02)
The fix was merged, deployed to staging, and then promoted to production. Initial verification showed flat memory usage over a 3-hour soak test, in contrast to the sawtooth pattern observed before.

### Closure (Wednesday 07:50)
NOTIF-482 was confirmed resolved: the worker pool memory stayed flat overnight, demonstrating sustained stable behavior. The ticket was closed.

---

## Checkout-API Incident Pattern

The `checkout-api` service experienced a discernible pattern of incidents related to the `payments` read replica connection pool across the week:

### Monday 10:02 — Initial Incident
An elevated 5xx rate (peaking at 2.1% for ~4 minutes) was triggered during the `billing-service` v2.14.0 rollout. Root cause was identified as connection pool exhaustion against the `payments` read replica. The pool size was widened from 20 to 40 as a mitigation; no customer tickets were filed.

### Tuesday 15:05 — Recurrence During Failover
A brief 5xx spike (0.6% for under a minute) occurred during a routine `payments` replica failover. Critically, the spike was self-recovered quickly, and the widened connection pool from Monday (20 → 40) successfully absorbed the load without requiring further mitigation.

### Wednesday — Pattern Consolidation
- **09:30:** `payments` read replica pool utilization was measured at a steady 30-45%, demonstrating the widened pool (20 → 40) is appropriately sized for current traffic patterns. A fourth replica was deemed unnecessary for now.
- **12:10:** A new alert threshold was added for `checkout-api` 5xx rates (addressing a monitoring gap exposed by Monday's incident). The alert now pages on-call at 1% sustained for 90 seconds, providing earlier visibility into future anomalies.
- **14:25–16:40:** A `billing-service` feature flag rollout (invoice line-item grouping) was deployed to 10% of traffic with no observed anomalies against `checkout-api` error rates. The rollout is scheduled to ramp to 50% Thursday.

### Summary
The checkout-api incidents revealed a resource contention pattern under heavy billing-service activity. The connection pool expansion resolved the underlying bottleneck, and Tuesday's failover demonstrated the fix's robustness. Wednesday's monitoring improvements and steady pool utilization metrics indicate the issue is stabilized.
