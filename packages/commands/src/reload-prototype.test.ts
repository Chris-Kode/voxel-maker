import { describe, expect, it } from "vitest";
import { commandId, nodeId, transactionId } from "@voxel-maker/shared";
import {
  canonicalDocumentJson,
  createDocument,
  parseDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import { CommandBus } from "./bus.js";
import { CommandRegistry } from "./registry.js";
import { createNodeCommand, registerNodeCommands } from "./node-commands.js";
import type { TransactionOptions } from "./types.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:reload:root");

/** A canonical document reloaded through the public parse seam (issue #103). */
function reloadedDocument(): VoxelDocument {
  const document = createDocument({
    documentId: "document:reload:0001" as never,
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        parentId: null,
        children: [],
        transform: identity,
        components: [],
      },
    ],
  });
  return parseDocument(canonicalDocumentJson(document));
}

const PROTOTYPE_NAMES = ["toString", "constructor", "__proto__"] as const;

describe("node.create after a serialize/parse reload (issue #103)", () => {
  it("accepts absent opaque IDs that collide with prototype member names", () => {
    const document = reloadedDocument();
    const { store, writeCapability } = createDocumentStoreHandle({
      document,
    });
    const registry = new CommandRegistry();
    registerNodeCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const createCommand = (id: string) =>
      createNodeCommand(commandId(`command:reload:${id}`), {
        nodeId: nodeId(id),
        parentId: ROOT,
        transform: identity,
      });
    const transactionOptions = (
      id: string,
      index: number,
    ): TransactionOptions => ({
      transactionId: transactionId(`transaction:reload:${id}`),
      expectedRevision: index,
      source: "ui",
    });
    // One transaction per ID: each reloaded record must treat the absent
    // prototype-named ID as absent instead of inheriting Object.prototype.
    PROTOTYPE_NAMES.forEach((id, index) => {
      expect(Object.prototype.hasOwnProperty.call(document.nodes, id)).toBe(
        false,
      );
      const result = bus.execute(
        createCommand(id),
        transactionOptions(id, index),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.revisionAfter).toBe(index + 1);
      expect(store.getDocument().nodes[nodeId(id)]).toBeDefined();
    });
    // Undo replays the stored node.delete inverses in reverse order,
    // exercising the delete record rebuild on a staged null-prototype map.
    [...PROTOTYPE_NAMES].reverse().forEach((undoneId, index) => {
      const result = bus.undo(
        transactionOptions(`undo:${undoneId}`, PROTOTYPE_NAMES.length + index),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(store.getDocument().nodes[nodeId(undoneId)]).toBeUndefined();
    });
  });

  it("accepts prototype-named IDs in one multi-command transaction", () => {
    const document = reloadedDocument();
    const { store, writeCapability } = createDocumentStoreHandle({
      document,
    });
    const registry = new CommandRegistry();
    registerNodeCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const result = bus.executeTransaction(
      PROTOTYPE_NAMES.map((id) =>
        createNodeCommand(commandId(`command:reload:batch:${id}`), {
          nodeId: nodeId(id),
          parentId: ROOT,
          transform: identity,
        }),
      ),
      {
        transactionId: transactionId("transaction:reload:batch"),
        expectedRevision: 0,
        source: "ui",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const id of PROTOTYPE_NAMES) {
      expect(store.getDocument().nodes[nodeId(id)]).toBeDefined();
    }
  });
});
