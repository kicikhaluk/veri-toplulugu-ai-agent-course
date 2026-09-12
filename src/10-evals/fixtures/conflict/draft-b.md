# Draft: Incident retro — PAY-119 (Devrim's notes)

Notes from the on-call side, mostly timeline.

## Timeline

- Thu 12:10 — p99 latency alert on payments-webhook, low severity, ack'd.
- Thu 14:40 — Latency alert re-fires at higher severity. I start pulling
  request traces.
- Thu 16:05 — Traces show most of the added latency sitting in downstream
  HTTP calls to the notification provider, which had a partial outage
  starting around 13:30. I file this as the root cause: our retry policy
  has no backoff cap, so we hammered a degraded upstream harder the worse
  it got, which is what actually starved request handling.
- Thu 17:20 — Added an exponential backoff cap as a stopgap. Latency
  recovers within 20 minutes.
- Fri 09:00 — Confirmed stable overnight. Ticket closed.

## Follow-ups we agreed on

1. Make the backoff cap a permanent config, not a stopgap (owner: Devrim).
2. Get visibility into the notification provider's status page in our
   on-call dashboard (owner: unassigned).
