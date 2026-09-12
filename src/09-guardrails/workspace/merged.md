# Incident retro — NOTIF-482

## What happened

The notifications worker's memory grew steadily over about 20 hours until the
pod was OOM-killed and restarted by Kubernetes. Users didn't get paged
directly, but the on-call dashboard showed a spike in restart counts, which
is what got Marcus's attention Monday evening.

## Root cause

A per-request buffer allocated in the retry path wasn't being released when a
delivery attempt failed and got requeued. Every retry added another buffer
without freeing the old one. Worker instances that saw a lot of retries
(mostly during the Tuesday-morning email provider slowdown) leaked fastest.

## Timeline

- Mon 17:55 — Restart-count alert fires for the notifications worker. Marcus
  acks it, sees nothing obviously wrong in logs, restart resolves it for the
  moment.
- Tue 09:00 — Same alert fires again, faster this time. Priya starts pulling
  heap snapshots.
- Tue 11:15 — Priya finds the leaking retry buffer.
- Tue 18:02 — Fix deployed, soak test started.
- Wed 07:50 — Soak test clean overnight. Ticket closed.

## Key learnings

- This wasn't caught by existing alerts — we only noticed via restart counts,
  which is a lagging signal.
- The fix (release the buffer before requeueing) was small once found, but
  finding it took a few hours of heap snapshots.
- We should add a memory-growth alert, not just a restart-count alert.

## Follow-ups

1. Add a memory-growth alert on the notifications worker (owner: Priya).
2. Document the heap-snapshot procedure somewhere other than Priya's head
   (owner: Marcus).
3. Check whether other workers share the same retry-buffer pattern
   (owner: unassigned — raise at retro).

## Open question for the retro

Should the retry path get a shared object pool instead of allocating a new
buffer per attempt? Feels like it'd prevent this whole class of bug, but it's
a bigger change than we want to rush.
