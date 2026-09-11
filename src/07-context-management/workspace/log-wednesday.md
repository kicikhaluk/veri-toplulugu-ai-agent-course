# Ops Log — Wednesday

- 07:50 — NOTIF-482 confirmed resolved: worker pool memory stayed flat overnight. Ticket closed.
- 09:30 — `payments` read replica pool utilization steady in the 30-45% range across the morning. Monday's pool widening (20 → 40) looks like the right long-term size; no fourth replica needed for now.
- 12:10 — New alert threshold added for `checkout-api` 5xx rate (was unmonitored above 1% for under 2 minutes — a gap Monday's incident exposed). Now pages on-call at 1% sustained for 90 seconds.
- 14:25 — Routine `billing-service` config change (feature flag rollout for `checkout-api` — invoice line-item grouping) deployed to 10% of traffic. No anomalies after 90 minutes; ramping to 50% tomorrow.
- 16:40 — On-call handoff from Marcus back to Priya. No open incidents, one active gradual rollout (invoice line-item grouping, currently at 10%).

Notes for tomorrow: ramp invoice line-item grouping to 50% and watch checkout-api error rate against the new alert threshold from today.
