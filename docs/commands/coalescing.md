# Drag gesture coalescing

Plan S4.10, ticket #20. `CommandBus` exposes a coalescing gesture API so a
long pointer drag (gizmo transform, future drag tools) presents as one
user-meaningful history entry while every update remains a normal atomic
transaction (ADR-0003).

## API

```ts
const gesture = bus.beginGesture("drag:translate:a");
gesture.update(commands, options); // normal atomic transaction
gesture.end();                     // seal as one undoable history entry
gesture.cancel(options);           // roll back to the exact pre-gesture state
```

- `beginGesture(key)` rejects a second concurrent gesture with
  `GESTURE_ACTIVE`.
- `update` executes the commands as a standard transaction (parse,
  validate, stage, commit, revision increment, event). When the update is
  compatible with the pending entry — identical command types in order and
  equal declared affected-resource sets — the bus replaces the unsealed
  history entry with a merged one: the forward replay is the first update
  followed by the latest update (both absolute deterministic intents), and
  the inverse is the first update's inverse, which restores the exact
  pre-gesture state. The entry keeps the first update's identity and
  label. An incompatible update seals the pending entry and starts a new
  segment.
- The entry seals (becomes a normal undoable history entry) on `end`, on
  any intervening commit (`execute`/`executeTransaction`), on undo/redo,
  on lifecycle replacement (a fresh bus per install), or on a failed
  update. After sealing, further `update`/`cancel` calls fail with
  `GESTURE_SEALED`.
- `cancel(options)` executes the pending inverse as one transaction that
  leaves no history entry, restoring the pre-gesture semantic content
  (revisions remain monotonic). Cancelling a gesture that never committed
  an update is a no-op success. On cancel failure the entry seals and
  remains undoable.

## Invariants

- Coalescing combines history presentation only: every update is a real
  atomic commit with its own revision, event, and idempotency record.
- The merged entry's inverse is the first update's inverse, so undo of the
  whole drag returns to the pre-gesture state even after many updates.
- Redo replays the first and latest update commands deterministically; the
  latest update is validated against the staged result of the first, so
  replay is exact.
- `#pending` gestures never survive lifecycle replacement: the session
  builds a fresh bus per document install.
