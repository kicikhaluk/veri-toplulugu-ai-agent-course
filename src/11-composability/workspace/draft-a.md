# Draft: Incident retro — NOTIF-482 (Priya's notes)

Rough notes ahead of the retro meeting.

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

## What we want to say in the retro

- This wasn't caught by existing alerts — we only noticed via restart counts,
  which is a lagging signal.
- The fix (release the buffer before requeueing) was small once found, but
  finding it took a few hours of heap snapshots.
- We should add a memory-growth alert, not just a restart-count alert.
