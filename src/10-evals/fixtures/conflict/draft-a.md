# Draft: Incident retro — PAY-119 (Sana's notes)

Notes from the payments-webhook side.

## What happened

The payments-webhook service started timing out under normal load starting
around Thursday midday. Latency climbed steadily rather than spiking, which
is why it took a while to notice.

## Root cause

I dug into this with a profiler attached to a canary pod. The webhook
handler holds a database connection for the full duration of each outbound
retry chain instead of releasing it between attempts, so under any sustained
retry pressure the connection pool empties out and everything queues behind
it. This is a connection-pool exhaustion bug in the retry path.

## What we want to say in the retro

- The fix is to release the connection before scheduling a retry, not hold
  it across the whole chain.
- We should add a pool-utilization alert; we only had a raw latency alert
  before.
