# Draft: Incident retro — NOTIF-482 (Marcus's notes)

My side of the notes, mostly timeline and follow-ups.

## Timeline

- Mon 17:55 — Restart-count alert fires for the notifications worker. I ack
  it, see nothing obviously wrong in logs, restart resolves it for the
  moment.
- Tue 09:00 — Same alert fires again, faster this time. Priya starts pulling
  heap snapshots.
- Tue 11:15 — Priya finds the leaking retry buffer.
- Tue 18:02 — Fix deployed, soak test started.
- Wed 07:50 — Soak test clean overnight. Ticket closed.

## Follow-ups we agreed on

1. Add a memory-growth alert on the notifications worker (owner: Priya).
2. Document the heap-snapshot procedure somewhere other than Priya's head
   (owner: Marcus).
3. Check whether other workers share the same retry-buffer pattern
   (owner: unassigned — raise at retro).

## Open question for the retro

Should the retry path get a shared object pool instead of allocating a new
buffer per attempt? Feels like it'd prevent this whole class of bug, but it's
a bigger change than we want to rush.
