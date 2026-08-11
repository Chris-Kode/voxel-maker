import { describe, expect, it } from "vitest";
import {
  commandId,
  transactionId,
  WorkspaceError,
  type JsonValue,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import { CommandBus } from "./bus.js";
import { CommandRegistry } from "./registry.js";
import {
  DEFAULT_COMMAND_LIMITS,
  type Command,
  type CommandLimits,
} from "./types.js";
import {
  parseJournalTransaction,
  type JournalTransactionLimits,
} from "./codec.js";
import {
  NODE_SET_METADATA_COMMAND,
  registerNodeCommands,
  setNodeMetadataCommand,
} from "./node-commands.js";

/**
 * Adversarial suite for command JSON (issue #44, plan §11.2, §5.4):
 * journaled transactions and command payloads are untrusted input that is
 * parsed before replay, so every count, byte, nesting, and field-shape
 * limit must fail with a stable structured error and leave state
 * untouched. Deeply nested or oversized values are rejected before
 * allocation or mutation.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function createDemoDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:adversarial:0001" as never,
    metadata: { title: "adversarial", tags: [] },
    rootNodeId: "node:adversarial:root" as never,
    nodes: [
      {
        nodeId: "node:adversarial:root" as never,
        name: "Root",
        parentId: null,
        children: [],
        transform: identity,
        components: [],
      },
    ],
    materials: [],
    volumes: [],
    animations: [],
  });
}

function createBus(limits?: CommandLimits): {
  readonly bus: CommandBus;
  readonly store: ReturnType<typeof createDocumentStoreHandle>["store"];
  readonly writeCapability: ReturnType<
    typeof createDocumentStoreHandle
  >["writeCapability"];
} {
  const handle = createDocumentStoreHandle({ document: createDemoDocument() });
  const registry = new CommandRegistry();
  registerNodeCommands(registry);
  const bus = new CommandBus(
    handle.store,
    registry,
    handle.writeCapability,
    limits,
  );
  return { bus, store: handle.store, writeCapability: handle.writeCapability };
}

const codecLimits: JournalTransactionLimits = {
  maxCommandsPerTransaction: DEFAULT_COMMAND_LIMITS.maxCommandsPerTransaction,
  maxCommandPayloadBytes: DEFAULT_COMMAND_LIMITS.maxCommandPayloadBytes,
  maxTransactionEnvelopeBytes:
    DEFAULT_COMMAND_LIMITS.maxTransactionEnvelopeBytes,
};

/** A structurally valid journaled transaction with one no-op-ish command. */
function validTransaction(overrides: Record<string, unknown> = {}): unknown {
  return {
    transactionId: "transaction:adversarial:0001",
    expectedRevision: 0,
    source: "recovery",
    revisionBefore: 0,
    revisionAfter: 1,
    commands: [
      {
        id: "command:adversarial:0001",
        type: "node.setMetadata",
        schemaVersion: 1,
        payload: { nodeId: "node:adversarial:root", metadata: { a: 1 } },
      },
    ],
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as WorkspaceError).code).toBe(code);
    return;
  }
  expect.unreachable(`expected ${code} to be thrown`);
}

// ---------------------------------------------------------------------------
// Journaled-transaction codec adversarial cases
// ---------------------------------------------------------------------------

describe("adversarial journal transaction parsing", () => {
  it("rejects unknown top-level fields, including prototype-like keys", () => {
    for (const field of ["__proto__", "constructor", "toString", "extra"]) {
      expectCode(
        () =>
          parseJournalTransaction(
            validTransaction({ [field]: 1 }),
            codecLimits,
          ),
        "UNKNOWN_JOURNAL_FIELD",
      );
    }
  });

  it("rejects unknown command-envelope fields", () => {
    const value = validTransaction();
    (value as { commands: unknown[] }).commands = [
      {
        ...((value as { commands: unknown[] }).commands[0] as object),
        magic: true,
      },
    ];
    expectCode(
      () => parseJournalTransaction(value, codecLimits),
      "UNKNOWN_JOURNAL_FIELD",
    );
  });

  it("rejects unsupported sources and oversized labels", () => {
    expectCode(
      () =>
        parseJournalTransaction(
          validTransaction({ source: "shell" }),
          codecLimits,
        ),
      "INVALID_JOURNAL_FIELD",
    );
    expectCode(
      () =>
        parseJournalTransaction(
          validTransaction({ label: "x".repeat(4097) }),
          codecLimits,
        ),
      "INVALID_JOURNAL_FIELD",
    );
  });

  it("rejects revision fields that do not advance by exactly one", () => {
    expectCode(
      () =>
        parseJournalTransaction(
          validTransaction({ revisionAfter: 5 }),
          codecLimits,
        ),
      "INVALID_JOURNAL_FIELD",
    );
    expectCode(
      () =>
        parseJournalTransaction(
          validTransaction({ revisionBefore: 1, revisionAfter: 2 }),
          codecLimits,
        ),
      "INVALID_JOURNAL_FIELD",
    );
    expectCode(
      () =>
        parseJournalTransaction(
          validTransaction({ expectedRevision: 3 }),
          codecLimits,
        ),
      "INVALID_JOURNAL_FIELD",
    );
    expectCode(
      () =>
        parseJournalTransaction(
          validTransaction({ revisionBefore: Number.NaN }),
          codecLimits,
        ),
      "INVALID_JOURNAL_FIELD",
    );
  });

  it("rejects malformed command envelopes and payloads", () => {
    const withCommands = (commands: unknown[]): unknown =>
      validTransaction({ commands });
    expectCode(
      () =>
        parseJournalTransaction(
          validTransaction({ commands: "nope" }),
          codecLimits,
        ),
      "INVALID_JOURNAL_FIELD",
    );
    expectCode(
      () =>
        parseJournalTransaction(
          withCommands([
            {
              id: "c:1",
              type: "node.setMetadata",
              schemaVersion: 1,
              payload: null,
            },
          ]),
          codecLimits,
        ),
      "INVALID_JOURNAL_FIELD",
    );
    expectCode(
      () =>
        parseJournalTransaction(
          withCommands([
            {
              id: "c:1",
              type: "node.setMetadata",
              schemaVersion: 1,
              payload: { a: 1 },
              extra: 1,
            },
          ]),
          codecLimits,
        ),
      "UNKNOWN_JOURNAL_FIELD",
    );
    expectCode(
      () =>
        parseJournalTransaction(
          withCommands([
            { id: "c:1", type: "", schemaVersion: 1, payload: { a: 1 } },
          ]),
          codecLimits,
        ),
      "INVALID_JOURNAL_FIELD",
    );
    expectCode(
      () =>
        parseJournalTransaction(
          withCommands([
            {
              id: "c:1",
              type: "node.setMetadata",
              schemaVersion: 1.5,
              payload: { a: 1 },
            },
          ]),
          codecLimits,
        ),
      "INVALID_JOURNAL_FIELD",
    );
    expectCode(
      () =>
        parseJournalTransaction(
          withCommands([
            {
              id: 7,
              type: "node.setMetadata",
              schemaVersion: 1,
              payload: { a: 1 },
            },
          ]),
          codecLimits,
        ),
      "INVALID_JOURNAL_FIELD",
    );
  });

  it("rejects command-count floods", () => {
    const commands = Array.from({ length: 1025 }, (_, i) => ({
      id: `command:adversarial:${String(i)}`,
      type: "node.setMetadata",
      schemaVersion: 1,
      payload: { nodeId: "node:adversarial:root", metadata: { i } },
    }));
    expectCode(
      () =>
        parseJournalTransaction(validTransaction({ commands }), codecLimits),
      "TOO_MANY_COMMANDS",
    );
  });

  it("rejects oversized command payloads and envelopes", () => {
    const bigPayload = {
      nodeId: "node:adversarial:root",
      metadata: { blob: "x".repeat(2 * 1024 * 1024) },
    };
    expectCode(
      () =>
        parseJournalTransaction(
          validTransaction({
            commands: [
              {
                id: "c:1",
                type: "node.setMetadata",
                schemaVersion: 1,
                payload: bigPayload,
              },
            ],
          }),
          codecLimits,
        ),
      "COMMAND_PAYLOAD_TOO_LARGE",
    );
    const many = Array.from({ length: 64 }, (_, i) => ({
      id: `command:adversarial:${String(i)}`,
      type: "node.setMetadata",
      schemaVersion: 1,
      payload: {
        nodeId: "node:adversarial:root",
        metadata: { blob: "y".repeat(300_000) },
      },
    }));
    expectCode(
      () =>
        parseJournalTransaction(
          validTransaction({ commands: many }),
          codecLimits,
        ),
      "TRANSACTION_TOO_LARGE",
    );
  });

  it("rejects nesting bombs with a structured limit error, never a crash", () => {
    // A pathologically nested payload must fail with a WorkspaceError
    // (canonicalJson enforces a hard depth cap) instead of overflowing the
    // stack with a RangeError.
    let nested: unknown = { leaf: true };
    for (let i = 0; i < 600; i += 1) nested = { next: nested };
    const error = (() => {
      try {
        parseJournalTransaction(
          validTransaction({
            commands: [
              {
                id: "c:1",
                type: "node.setMetadata",
                schemaVersion: 1,
                payload: {
                  nodeId: "node:adversarial:root",
                  metadata: { nested },
                },
              },
            ],
          }),
          codecLimits,
        );
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).family).toBe("limit");
    expect((error as WorkspaceError).code).toBe("LIMIT_EXCEEDED");
    // Depth within the cap still parses at the codec (semantic depth is
    // enforced later by the handler: two-stage validation, plan §11.2).
    let shallow: unknown = { leaf: true };
    for (let i = 0; i < 100; i += 1) shallow = { next: shallow };
    const parsed = parseJournalTransaction(
      validTransaction({
        commands: [
          {
            id: "c:2",
            type: "node.setMetadata",
            schemaVersion: 1,
            payload: { nodeId: "node:adversarial:root", metadata: { shallow } },
          },
        ],
      }),
      codecLimits,
    );
    expect(parsed.commands).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Bus-level adversarial cases: limits fail closed, state unchanged
// ---------------------------------------------------------------------------

describe("adversarial command execution", () => {
  it("rejects command-count floods and keeps the revision unchanged", () => {
    const { bus, store } = createBus();
    const before = store.revision;
    const commands = Array.from({ length: 1025 }, (_, i) => ({
      id: commandId(`command:adversarial:${String(i)}`),
      type: NODE_SET_METADATA_COMMAND,
      schemaVersion: 1,
      payload: { nodeId: "node:adversarial:root", metadata: { i } },
    }));
    const result = bus.executeTransaction(commands, {
      transactionId: transactionId("transaction:adversarial:0001"),
      expectedRevision: before,
      source: "recovery",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOO_MANY_COMMANDS");
    expect(store.revision).toBe(before);
  });

  it("rejects duplicate command ids without mutating state", () => {
    const { bus, store } = createBus();
    const before = store.revision;
    const duplicate = {
      id: commandId("command:adversarial:dup"),
      type: NODE_SET_METADATA_COMMAND,
      schemaVersion: 1,
      payload: { nodeId: "node:adversarial:root", metadata: { a: 1 } },
    };
    const result = bus.executeTransaction([duplicate, duplicate], {
      transactionId: transactionId("transaction:adversarial:0001"),
      expectedRevision: before,
      source: "recovery",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DUPLICATE_COMMAND_ID");
    expect(store.revision).toBe(before);
  });

  it("rejects metadata nesting beyond the depth limit and leaves state unchanged", () => {
    const { bus, store } = createBus();
    const before = store.revision;
    // 20 levels: under the command-construction copy cap (64), over the
    // document metadata depth limit (16), so the handler must reject it.
    let nested: unknown = { leaf: true };
    for (let i = 0; i < 20; i += 1) nested = { next: nested };
    const command = setNodeMetadataCommand(
      commandId("command:adversarial:md"),
      {
        nodeId: "node:adversarial:root" as never,
        metadata: { nested: nested as JsonValue },
      },
    );
    const result = bus.execute(command, {
      transactionId: transactionId("transaction:adversarial:0001"),
      expectedRevision: before,
      source: "ai",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("LIMIT_EXCEEDED");
    expect(store.revision).toBe(before);
    expect(store.getDocument().nodes).toBeDefined();
  });

  it("rejects metadata member floods and string floods", () => {
    const { bus, store } = createBus();
    const before = store.revision;
    const members: Record<string, number> = {};
    for (let i = 0; i < 10_001; i += 1) members[`k${String(i)}`] = i;
    const membersCommand = setNodeMetadataCommand(
      commandId("command:adversarial:members"),
      { nodeId: "node:adversarial:root" as never, metadata: members },
    );
    const result = bus.execute(membersCommand, {
      transactionId: transactionId("transaction:adversarial:0001"),
      expectedRevision: before,
      source: "ai",
    });
    expect(result.ok).toBe(false);
    expect(store.revision).toBe(before);

    const stringCommand = setNodeMetadataCommand(
      commandId("command:adversarial:str"),
      {
        nodeId: "node:adversarial:root" as never,
        metadata: { blob: "x".repeat(70_000) },
      },
    );
    const result2 = bus.execute(stringCommand, {
      transactionId: transactionId("transaction:adversarial:0002"),
      expectedRevision: before,
      source: "ai",
    });
    expect(result2.ok).toBe(false);
    expect(store.revision).toBe(before);
  });

  it("returns a failed result for a cyclic payload instead of throwing (issue #114)", () => {
    const { bus, store } = createBus();
    const before = store.revision;
    // A self-referencing payload is untrusted input that canonicalJson
    // rejects; it must surface as a structured failed TransactionResult,
    // never as a synchronous throw through the public API.
    const cyclic: Record<string, unknown> = {
      nodeId: "node:adversarial:root",
      metadata: { a: 1 },
    };
    cyclic.self = cyclic;
    const command: Command = {
      id: commandId("command:adversarial:cyclic"),
      type: NODE_SET_METADATA_COMMAND,
      schemaVersion: 1,
      payload: cyclic,
    };
    const result = bus.execute(command, {
      transactionId: transactionId("transaction:adversarial:cyclic"),
      expectedRevision: before,
      source: "ai",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CYCLIC_VALUE");
    expect(store.revision).toBe(before);
    expect(bus.historySnapshot().past).toHaveLength(0);
  });

  it("returns a failed result for a noncanonical number payload instead of throwing (issue #114)", () => {
    const { bus, store } = createBus();
    const before = store.revision;
    const result = bus.executeTransaction(
      [
        {
          id: commandId("command:adversarial:nan"),
          type: NODE_SET_METADATA_COMMAND,
          schemaVersion: 1,
          payload: {
            nodeId: "node:adversarial:root",
            metadata: { v: Number.NaN },
          },
        },
      ],
      {
        transactionId: transactionId("transaction:adversarial:nan"),
        expectedRevision: before,
        source: "ai",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_CANONICAL_NUMBER");
    expect(store.revision).toBe(before);
    expect(bus.historySnapshot().past).toHaveLength(0);
  });

  it("returns a failed result for a depth-bomb payload instead of throwing (issue #114)", () => {
    const { bus, store } = createBus();
    const before = store.revision;
    let nested: unknown = { leaf: true };
    for (let i = 0; i < 600; i += 1) nested = { next: nested };
    const result = bus.execute(
      {
        id: commandId("command:adversarial:depth"),
        type: NODE_SET_METADATA_COMMAND,
        schemaVersion: 1,
        payload: {
          nodeId: "node:adversarial:root",
          metadata: { nested },
        },
      },
      {
        transactionId: transactionId("transaction:adversarial:depth"),
        expectedRevision: before,
        source: "ai",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("LIMIT_EXCEEDED");
    expect(store.revision).toBe(before);
    expect(bus.historySnapshot().past).toHaveLength(0);
  });

  it("returns a failed result when the idempotency envelope pushes payload nesting over the depth cap (issue #114)", () => {
    const { bus, store } = createBus();
    const before = store.revision;
    // A chain of 508 nested objects sits exactly between the two
    // canonicalization wrappers: the envelope budget canonicalization
    // (one array wrap; deepest value at depth 512) passes, while the
    // idempotency-envelope canonicalization (array + envelope object;
    // deepest value at depth 513) exceeds the cap. The depth cap must
    // fail closed instead of throwing through the TransactionResult API.
    let nested: unknown = { leaf: true };
    for (let i = 0; i < 508; i += 1) nested = { next: nested };
    const result = bus.execute(
      {
        id: commandId("command:adversarial:envelope-depth"),
        type: NODE_SET_METADATA_COMMAND,
        schemaVersion: 1,
        payload: {
          nodeId: "node:adversarial:root",
          metadata: { nested },
        },
      },
      {
        transactionId: transactionId("transaction:adversarial:envelope-depth"),
        expectedRevision: before,
        source: "ai",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("LIMIT_EXCEEDED");
    expect(store.revision).toBe(before);
    expect(bus.historySnapshot().past).toHaveLength(0);
  });
});
