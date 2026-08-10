import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  type JsonValue,
} from "@voxel-maker/shared";
import { WorkspaceError } from "@voxel-maker/shared";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import {
  CommandBus,
  CommandRegistry,
  DEFAULT_COMMAND_LIMITS,
  JOURNAL_COMMAND_ENVELOPE_VERSION,
  journalTransactionToJson,
  parseJournalTransaction,
  registerVoxelCommands,
  setVoxelCommand,
  type Command,
  type CommittedTransactionRecord,
} from "./index.js";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";

const VOLUME_ID = volumeId("volume:codec:0001");

function createCodecDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:codec:0001"),
    metadata: { title: "codec", tags: [] },
    rootNodeId: nodeId("node:codec:root"),
    nodes: [
      {
        nodeId: nodeId("node:codec:root"),
        name: "Root",
        parentId: null,
        children: [],
        transform: {
          translation: [0, 0, 0],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME_ID }],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "demo",
        color: "#ff8800",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      { volumeId: VOLUME_ID, bounds: { min: [0, 0, 0], max: [2, 2, 2] } },
    ],
  });
}

function record(
  overrides: Partial<CommittedTransactionRecord> = {},
): CommittedTransactionRecord {
  const command: Command = setVoxelCommand(commandId("command:codec:0001"), {
    volumeId: VOLUME_ID,
    coordinate: [0, 0, 0],
    material: materialId(1),
  });
  return {
    transactionId: transactionId("transaction:codec:0001"),
    expectedRevision: 0,
    source: "ui",
    revisionBefore: 0,
    revisionAfter: 1,
    commands: [command],
    ...overrides,
  };
}

describe("journal-safe command codec (plan S4.14)", () => {
  it("encodes a committed transaction canonically and deterministically", () => {
    const first = journalTransactionToJson(record());
    const second = journalTransactionToJson(record());
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(canonicalJson(JSON.parse(canonicalJson(first)) as JsonValue)).toBe(
      canonicalJson(first),
    );
    const parsed = parseJournalTransaction(first, DEFAULT_COMMAND_LIMITS);
    expect(parsed.transactionId).toBe("transaction:codec:0001");
    expect(parsed.revisionBefore).toBe(0);
    expect(parsed.revisionAfter).toBe(1);
    expect(parsed.commands).toHaveLength(1);
    expect(parsed.commands[0]?.id).toBe("command:codec:0001");
    expect(parsed.commands[0]?.type).toBe("voxel.set");
    expect(parsed.commands[0]?.schemaVersion).toBe(1);
  });

  it("replays a decoded transaction through the bus with identical semantics", () => {
    const encoded = journalTransactionToJson(record());
    const decoded = parseJournalTransaction(encoded, DEFAULT_COMMAND_LIMITS);
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createCodecDocument(),
    });
    const registry = new CommandRegistry();
    registerVoxelCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const result = bus.executeTransaction(decoded.commands, {
      transactionId: decoded.transactionId,
      expectedRevision: decoded.expectedRevision,
      source: decoded.source,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.revisionAfter).toBe(1);
      expect(store.getVoxel(VOLUME_ID, [0, 0, 0])).toBe(1);
    }
  });

  it("carries audit metadata through the codec", () => {
    const encoded = journalTransactionToJson(
      record({
        source: "ai",
        correlationId: "correlation:codec:0001",
        label: "apply proposal",
      }),
    );
    const decoded = parseJournalTransaction(encoded, DEFAULT_COMMAND_LIMITS);
    expect(decoded.source).toBe("ai");
    expect(decoded.correlationId).toBe("correlation:codec:0001");
    expect(decoded.label).toBe("apply proposal");
  });

  it("rejects unknown fields instead of guessing at them", () => {
    const encoded = journalTransactionToJson(record());
    const withUnknown = { ...(encoded as Record<string, unknown>), bogus: 1 };
    expect(() =>
      parseJournalTransaction(withUnknown, DEFAULT_COMMAND_LIMITS),
    ).toThrowError(WorkspaceError);
  });

  it("rejects inconsistent revision transitions", () => {
    const encoded = journalTransactionToJson(record());
    const bad = {
      ...(encoded as Record<string, unknown>),
      revisionAfter: 5,
    };
    expect(() =>
      parseJournalTransaction(bad, DEFAULT_COMMAND_LIMITS),
    ).toThrowError(/advance the revision by exactly one/u);
  });

  it("rejects unsupported sources and malformed commands", () => {
    const encoded = journalTransactionToJson(record());
    const badSource = {
      ...(encoded as Record<string, unknown>),
      source: "rogue",
    };
    expect(() =>
      parseJournalTransaction(badSource, DEFAULT_COMMAND_LIMITS),
    ).toThrowError(/source is not supported/u);
    const badCommand = {
      ...(encoded as Record<string, unknown>),
      commands: [{ id: "command:x", type: "voxel.set", payload: {} }],
    };
    expect(() =>
      parseJournalTransaction(badCommand, DEFAULT_COMMAND_LIMITS),
    ).toThrowError(WorkspaceError);
  });

  it("enforces the transaction budgets", () => {
    const many = record();
    const encoded = {
      ...(journalTransactionToJson(many) as Record<string, unknown>),
      commands: Array.from({ length: 10 }, (_, index) => ({
        id: `command:codec:many:${String(index)}`,
        type: "voxel.set",
        schemaVersion: 1,
        payload: {
          volumeId: VOLUME_ID,
          coordinate: [0, 0, 0],
          material: materialId(1),
        },
      })),
    };
    expect(() =>
      parseJournalTransaction(encoded, {
        ...DEFAULT_COMMAND_LIMITS,
        maxCommandsPerTransaction: 5,
      }),
    ).toThrowError(/exceeds the limit of 5 commands/u);
  });

  it("exposes the command envelope schema version for journal frames", () => {
    expect(JOURNAL_COMMAND_ENVELOPE_VERSION).toBe(1);
  });
});
