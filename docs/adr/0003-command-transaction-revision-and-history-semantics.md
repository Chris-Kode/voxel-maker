---
status: accepted
---

# Command, transaction, revision, and history semantics

Human, import, recovery, and AI edits need one atomic concurrency and history contract. We adopt complete deterministic Commands executed in revision-checked Transactions, with all-or-nothing publication, durable idempotency, and inverse-based history.

## Decision

A Command contains caller-supplied identity, type, schema version, and complete serializable deterministic intent. A Transaction parses, checks budgets and expected base Revision, and executes Commands sequentially against a copy-on-write staged view. Any failure publishes no semantic state, Revision, history, dirty-state, journal request, or event change; success installs once, increments Revision once, records one labeled history entry, and emits one immutable post-commit event. Identical transaction replay is idempotent, while identifier reuse with different canonical bytes fails. A committed Command id is the unique identity of one committed transaction: the bus retains the Command ids that ran in its transaction stream for the open session and every retained recovery frame, and a new normal commit that reuses one fails atomically with `DUPLICATE_COMMAND_ID` before staging (issue #115). Undo, redo, and gesture-cancel rollback replay stored Commands and derived inverses and are exempt from the reuse check; recovery replays recorded frames on a fresh bus. Every version 1 persistent edit Command is undoable; lifecycle replacement is not a Command and resets history. Undo applies stored inverses in reverse order as one transaction, redo replays original intent, and a new normal commit clears redo. Idempotency records live for the open session and every retained recovery frame; checkpoint compaction may drop an identifier only when no replayable retained input can mention it. History coalescing requires an explicit deterministic key and compatible affected resources on the unsealed latest entry; it never merges semantic commits or Revisions, and the entry seals on gesture end, an incompatible or intervening commit, undo/redo, lifecycle replacement, or failure. Pointer tools normally avoid coalescing by previewing at runtime and committing once at gesture end.

Semantic commit intentionally precedes recovery journaling: journal failure leaves the edit valid and dirty, reports degraded durability, and never claims unconfirmed recovery coverage.
## Considered options

- Independent command commits inside a batch were rejected because later failure would expose partial intent.
- Handler-generated IDs, clocks, randomness, or platform-sensitive intent were rejected because replay would not be deterministic.
- Incrementing Revision per Command was rejected because one user intent and one optimistic concurrency boundary is the Transaction.
- Rolling back a valid semantic commit when journaling fails was rejected because filesystem durability is an external asynchronous effect; instead durability status is explicit.
- Snapshot-only undo was rejected because it scales poorly and obscures command conformance and conflict behavior.
- Indefinite process-global idempotency retention was rejected as unbounded; retention follows the open session and replayable recovery horizon. Command-id records follow the same retention horizon as idempotency records.

## Consequences

Every registered Command needs parsing, semantic validation, bounded execution, affected-resource reporting, and an explicit inverse. Subscriber failures are isolated. Gesture coalescing may replace only a pending history entry and must preserve deterministic command intent.

## Gates

This decision gates voxel mutation and shared command conformance (#6–#10), native save and recovery (#11–#14), editor gestures and lifecycle workflows (#17–#22), and AI staging/apply semantics (#32–#40).
