import {
  createNodeCommand,
  createVolumeCommand,
  deleteNodeCommand,
  deleteVolumeCommand,
  renameNodeCommand,
  reparentNodeCommand,
  setNodeComponentsCommand,
  setNodeMetadataCommand,
  setNodeTransformCommand,
} from "@voxel-maker/commands";
import type { JsonValue } from "@voxel-maker/shared";
import {
  invalidArgument,
  mutationOutputSchema,
  regionSchema,
  transformSchema,
  type ToolContract,
} from "../contract.js";
import type { JsonSchema } from "../schema.js";
import type { Component } from "@voxel-maker/model";
import { requireNode, requireVolume } from "../tools/helpers.js";
import { estimateVoxelDelta } from "./estimate.js";
import type { MutationToolContext, MutationPayload } from "./context.js";
import {
  resolveCommandId,
  requireNodeId,
  requireOptionalComponents,
  requireOptionalIndex,
  requireOptionalMetadata,
  requireOptionalRegion,
  requireOptionalString,
  requireOptionalTransform,
  requirePlacement,
  requireTransform,
  requireVolumeId,
} from "./parse.js";

/**
 * Scene mutation tools (plan S11.5, ticket #32): node hierarchy and volume
 * lifecycle operations that compile only to registered commands. Every
 * handler validates arguments against the current read surface (the
 * staged view when bound to a preview session), then constructs exactly
 * one command with an explicit id; nothing is executed here.
 */

const ID_SCHEMA: JsonSchema = { type: "string", minLength: 1, maxLength: 128 };

/** `createNode` contract: construct a `node.create` command. */
export const CREATE_NODE_CONTRACT: ToolContract = {
  name: "createNode",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered node.create command that inserts a new node under an existing parent. The node id and command id are explicit; the transform defaults to identity.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      nodeId: ID_SCHEMA,
      parentId: ID_SCHEMA,
      name: { type: "string", minLength: 1, maxLength: 128 },
      transform: transformSchema(),
      components: {
        type: "array",
        items: { type: "object" },
        description:
          "Component records; validated by the command at stage time",
      },
      metadata: { type: "object" },
      index: { type: "integer", minimum: 0 },
    },
    required: ["nodeId", "parentId"],
  },
  outputSchema: mutationOutputSchema("createNode"),
};

/** `deleteNode` contract: construct a `node.delete` command. */
export const DELETE_NODE_CONTRACT: ToolContract = {
  name: "deleteNode",
  version: 1,
  capability: "mutate",
  description: "Constructs a registered node.delete command for one node.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      nodeId: ID_SCHEMA,
    },
    required: ["nodeId"],
  },
  outputSchema: mutationOutputSchema("deleteNode"),
};

/** `renameNode` contract: construct a `node.rename` command. */
export const RENAME_NODE_CONTRACT: ToolContract = {
  name: "renameNode",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered node.rename command. An absent name removes the node name.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      nodeId: ID_SCHEMA,
      name: { type: "string", minLength: 1, maxLength: 128 },
    },
    required: ["nodeId"],
  },
  outputSchema: mutationOutputSchema("renameNode"),
};

/** `reparentNode` contract: construct a `node.reparent` command. */
export const REPARENT_NODE_CONTRACT: ToolContract = {
  name: "reparentNode",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered node.reparent command. preserve-world keeps the node's world placement fixed (the constructor resolves the canonical local transform); set-transform requires the explicit transform argument.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      nodeId: ID_SCHEMA,
      newParentId: ID_SCHEMA,
      placement: {
        type: "string",
        enum: ["preserve-local", "preserve-world", "set-transform"],
      },
      transform: transformSchema(),
      index: { type: "integer", minimum: 0 },
    },
    required: ["nodeId", "newParentId", "placement"],
  },
  outputSchema: mutationOutputSchema("reparentNode"),
};

/** `setNodeTransform` contract: construct a `node.setTransform` command. */
export const SET_NODE_TRANSFORM_CONTRACT: ToolContract = {
  name: "setNodeTransform",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered node.setTransform command with the canonical TRS transform.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      nodeId: ID_SCHEMA,
      transform: transformSchema(),
    },
    required: ["nodeId", "transform"],
  },
  outputSchema: mutationOutputSchema("setNodeTransform"),
};

/** `setNodeComponents` contract: construct a `node.setComponents` command. */
export const SET_NODE_COMPONENTS_CONTRACT: ToolContract = {
  name: "setNodeComponents",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered node.setComponents command replacing the node's component list (voxel, pivot, joint, constraint records).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      nodeId: ID_SCHEMA,
      components: {
        type: "array",
        items: { type: "object" },
      },
    },
    required: ["nodeId", "components"],
  },
  outputSchema: mutationOutputSchema("setNodeComponents"),
};

/** `setNodeMetadata` contract: construct a `node.setMetadata` command. */
export const SET_NODE_METADATA_CONTRACT: ToolContract = {
  name: "setNodeMetadata",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered node.setMetadata command. An absent metadata argument removes the node metadata.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      nodeId: ID_SCHEMA,
      metadata: { type: "object" },
    },
    required: ["nodeId"],
  },
  outputSchema: mutationOutputSchema("setNodeMetadata"),
};

/** `createVolume` contract: construct a `volume.create` command. */
export const CREATE_VOLUME_CONTRACT: ToolContract = {
  name: "createVolume",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered volume.create command that creates an empty volume with an explicit id.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      volumeId: ID_SCHEMA,
      name: { type: "string", minLength: 1, maxLength: 128 },
      bounds: regionSchema(),
    },
    required: ["volumeId"],
  },
  outputSchema: mutationOutputSchema("createVolume"),
};

/** `deleteVolume` contract: construct a `volume.delete` command. */
export const DELETE_VOLUME_CONTRACT: ToolContract = {
  name: "deleteVolume",
  version: 1,
  capability: "mutate",
  description: "Constructs a registered volume.delete command for one volume.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      volumeId: ID_SCHEMA,
    },
    required: ["volumeId"],
  },
  outputSchema: mutationOutputSchema("deleteVolume"),
};

export function createNode(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIdValue = requireNodeId(record, "nodeId");
  const parentId = requireNodeId(record, "parentId");
  requireNode(ctx.store.getDocument(), parentId);
  if (ctx.store.getDocument().nodes[nodeIdValue] !== undefined) {
    invalidArgument("nodeId already exists in the document", ["nodeId"]);
  }
  const name = requireOptionalString(record, "name");
  const components = requireOptionalComponents(record, "components");
  const metadata = requireOptionalMetadata(record, "metadata");
  const index = requireOptionalIndex(record, "index");
  const parsedComponents =
    components === undefined
      ? undefined
      : (components as unknown as readonly Component[]);
  return {
    command: createNodeCommand(resolveCommandId(ctx, record), {
      nodeId: nodeIdValue,
      parentId,
      ...(name === undefined ? {} : { name }),
      transform: requireOptionalTransform(record, "transform"),
      ...(parsedComponents === undefined
        ? {}
        : { components: parsedComponents }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(index === undefined ? {} : { index }),
    }),
    voxelEstimate: 0,
  };
}

export function deleteNode(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIdValue = requireNodeId(record, "nodeId");
  requireNode(ctx.store.getDocument(), nodeIdValue);
  const command = deleteNodeCommand(resolveCommandId(ctx, record), {
    nodeId: nodeIdValue,
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

export function renameNode(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIdValue = requireNodeId(record, "nodeId");
  requireNode(ctx.store.getDocument(), nodeIdValue);
  const name = requireOptionalString(record, "name");
  const command = renameNodeCommand(resolveCommandId(ctx, record), {
    nodeId: nodeIdValue,
    ...(name === undefined ? {} : { name }),
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

export function reparentNode(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIdValue = requireNodeId(record, "nodeId");
  const newParentId = requireNodeId(record, "newParentId");
  requireNode(ctx.store.getDocument(), nodeIdValue);
  requireNode(ctx.store.getDocument(), newParentId);
  const placement = requirePlacement(record, "placement");
  const index = requireOptionalIndex(record, "index");
  const hasTransform = record.transform !== undefined;
  const transform = hasTransform
    ? requireTransform(record, "transform")
    : undefined;
  const command = reparentNodeCommand(
    resolveCommandId(ctx, record),
    {
      nodeId: nodeIdValue,
      newParentId,
      placement,
      ...(transform === undefined ? {} : { transform }),
      ...(index === undefined ? {} : { index }),
    },
    ctx.store.getDocument(),
  );
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

export function setNodeTransform(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIdValue = requireNodeId(record, "nodeId");
  requireNode(ctx.store.getDocument(), nodeIdValue);
  const command = setNodeTransformCommand(resolveCommandId(ctx, record), {
    nodeId: nodeIdValue,
    transform: requireTransform(record, "transform"),
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

export function setNodeComponents(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIdValue = requireNodeId(record, "nodeId");
  requireNode(ctx.store.getDocument(), nodeIdValue);
  const components = requireOptionalComponents(record, "components") ?? [];
  const command = setNodeComponentsCommand(resolveCommandId(ctx, record), {
    nodeId: nodeIdValue,
    components: components as unknown as readonly Component[],
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

export function setNodeMetadata(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIdValue = requireNodeId(record, "nodeId");
  requireNode(ctx.store.getDocument(), nodeIdValue);
  const metadata = requireOptionalMetadata(record, "metadata");
  const command = setNodeMetadataCommand(resolveCommandId(ctx, record), {
    nodeId: nodeIdValue,
    ...(metadata === undefined ? {} : { metadata }),
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

export function createVolume(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeIdValue = requireVolumeId(record, "volumeId");
  if (ctx.store.getDocument().volumes[volumeIdValue] !== undefined) {
    invalidArgument("volumeId already exists in the document", ["volumeId"]);
  }
  const name = requireOptionalString(record, "name");
  const bounds = requireOptionalRegion(record, "bounds");
  const command = createVolumeCommand(resolveCommandId(ctx, record), {
    volumeId: volumeIdValue,
    ...(name === undefined ? {} : { name }),
    ...(bounds === undefined ? {} : { bounds }),
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

export function deleteVolume(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeIdValue = requireVolumeId(record, "volumeId");
  requireVolume(ctx.store.getDocument(), volumeIdValue);
  const command = deleteVolumeCommand(resolveCommandId(ctx, record), {
    volumeId: volumeIdValue,
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}
