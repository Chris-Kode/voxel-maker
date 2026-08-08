# Command conformance suite

Every registered persistent command must run through the shared conformance
suite (plan S4.16 / S4.17) before it is considered shippable. The suite is a
single battery of tests that exercises the command bus machinery around a
command, so each command gets uniform coverage of the guarantees ticket #7
requires.

## How to add a command

1. Register the handler in `CommandRegistry` (via a `register*Commands`
   function).
2. Add a `CommandConformanceSpec` for the command in
   `packages/commands/src/conformance.test.ts` (or a sibling test file).
3. Call `runCommandConformanceSuite(spec, { describe, it, expect })`.
4. Add the `type@schemaVersion` key to `CONFORMANCE_TESTED_COMMANDS`; the
   coverage test fails until every registered command is listed.

## Spec contract

| Member | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Suite name, conventionally `type@schemaVersion`. |
| `type` / `schemaVersion` | yes | The registered command identity. |
| `inversePolicy` | yes | Inverse policy declaration (plan S4.17); v1 is `"exact-restore"`. |
| `createDocument()` | yes | Fresh document fixture per test. |
| `register(registry)` | yes | Registers the handlers under test. |
| `seed(bus, store)` | no | Deterministic preparation through the bus (for example, populating a voxel a `voxel.remove` deletes). |
| `buildValid(id)` | yes | A valid command with a fresh id. |
| `buildInvalid(id)` | yes | A command that fails parse or validation. |
| `buildExecuteInvalid(id)` | no | A command that passes parse/validate but fails at execution; omit when execution cannot fail after validation. |
| `assertApplied(store)` | yes | Semantic state after one valid execution. |
| `assertUndone(store)` | yes | Exact semantic state before the valid command (right after `seed`); also the state after undo. |
| `assertRedone(store)` | no | State after redo; defaults to `assertApplied`. |
| `buildSecondValid(id)` | no | A second valid command touching different state. |
| `assertSecondApplied(store)` | no | State after both valid commands; defaults to `assertApplied`. |

## Coverage

The battery covers, per command:

- **codec** — canonical envelope serialization is deterministic and round-trips;
- **validity** — a valid command commits with one revision increment and one
  frozen event; an invalid command changes nothing and emits nothing;
  subscriber exceptions are isolated;
- **inverse / undo / redo** — the declared inverse policy is asserted, undo
  restores the exact pre-command state, redo reapplies it, multi-command
  transactions undo/redo as one unit, a new commit clears redo, and the ends
  report `NOTHING_TO_UNDO` / `NOTHING_TO_REDO`;
- **determinism** — identical commands on fresh stores produce identical
  document hashes and event bytes;
- **conflict** — stale `expectedRevision` fails with `REVISION_CONFLICT` for
  execute, undo, and redo, leaving document hash and history unchanged;
- **limits** — `TOO_MANY_COMMANDS`, `COMMAND_PAYLOAD_TOO_LARGE`, and
  `TRANSACTION_TOO_LARGE` are enforced before any mutation, leaving document
  hash and history unchanged;
- **rollback** — a batch whose later command fails validation or execution
  leaves revision, document hash, history, events, and semantic state
  unchanged and reports the failing `commandIndex`;
- **idempotency** — identical replay returns the recorded result, identifier
  reuse with different canonical bytes fails with
  `DUPLICATE_TRANSACTION_ID`, and the revision check runs before replay;
- **history** — exactly one history entry per commit (asserted directly via
  `CommandBus.historySnapshot()`), bounded by `maxHistoryEntries` with the
  oldest dropped first;
- **audit metadata** — `source`, `correlationId`, and `label` ride on events
  and on history entries (plan S4.9).
