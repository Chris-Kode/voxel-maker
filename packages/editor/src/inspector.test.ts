import { describe, expect, it } from "vitest";
import {
  WorkspaceError,
  commandId,
  componentId,
  nodeId,
  type CommandId,
  type NodeId,
} from "@voxel-maker/shared";
import { eulerXYZToQuaternion, type Transform } from "@voxel-maker/math";
import {
  buildAddConstraintCommand,
  buildAddJointCommand,
  buildRemoveConstraintCommand,
  buildRemoveJointCommand,
  buildRemovePivotCommand,
  buildReorderConstraintCommand,
  buildSetComponentsCommand,
  buildSetConstraintCommand,
  buildSetMetadataCommand,
  buildSetPivotCommand,
  buildSetTransformFieldCommands,
  constraintRuntimeRotationDegrees,
  formatLimitsDegrees,
  formatMetadata,
  formatNumber,
  formatRotationDegrees,
  formatVec3,
  parseLimitsDegreesInput,
  parseMetadataInput,
  parseRotationDegreesInput,
  parseScaleInput,
  parseVec3Input,
  transformFieldValue,
  transformRotationValue,
} from "./inspector.js";

const identity: Transform = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

const A = nodeId("node:inspector:a");
const B = nodeId("node:inspector:b");

describe("inspector text parsing (plan S7.12)", () => {
  it("parses comma and whitespace separated vectors", () => {
    expect(parseVec3Input("1, 2, 3", "translation")).toEqual([1, 2, 3]);
    expect(parseVec3Input("1 2 3", "translation")).toEqual([1, 2, 3]);
    expect(parseVec3Input("-0, 0.5, -1e3", "translation")).toEqual([
      0, 0.5, -1000,
    ]);
  });

  it("rejects malformed vectors with a structured error", () => {
    expect(() => parseVec3Input("1, 2", "translation")).toThrow(/three/u);
    expect(() => parseVec3Input("a, b, c", "translation")).toThrow(/finite/u);
    expect(() => parseVec3Input("1, NaN, 3", "translation")).toThrow(/finite/u);
    expect(() => parseVec3Input("1, Infinity, 3", "translation")).toThrow(
      /finite/u,
    );
  });

  it("parses Euler XYZ degrees into a canonical quaternion", () => {
    const rotation = parseRotationDegreesInput("0, 0, 90");
    expect(rotation[0]).toBeCloseTo(0, 9);
    expect(rotation[1]).toBeCloseTo(0, 9);
    expect(rotation[2]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(rotation[3]).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it("round-trips formatted rotation degrees", () => {
    const rotation = eulerXYZToQuaternion([0.3, -0.7, 1.2]);
    const text = formatRotationDegrees(rotation);
    const back = parseRotationDegreesInput(text);
    for (let index = 0; index < 4; index += 1) {
      expect(
        Math.abs((back[index] as number) - (rotation[index] as number)),
      ).toBeLessThan(0.01);
    }
  });

  it("rejects non-positive scale components", () => {
    expect(() => parseScaleInput("0, 1, 1")).toThrow(/positive/u);
    expect(() => parseScaleInput("-2, 1, 1")).toThrow(/positive/u);
    expect(parseScaleInput("1, 2, 3")).toEqual([1, 2, 3]);
  });

  it("formats numbers without trailing noise", () => {
    expect(formatNumber(1.5)).toBe("1.5");
    expect(formatNumber(-0)).toBe("0");
    expect(formatVec3([1, 2.25, -3])).toBe("1, 2.25, -3");
  });
});

describe("mixed multi-selection resolution (plan S7.12)", () => {
  it("shows the shared value when every node matches", () => {
    const field = transformFieldValue(
      [
        { ...identity, translation: [1, 2, 3] },
        { ...identity, translation: [1, 2, 3] },
      ],
      "translation",
    );
    expect(field).toEqual({ kind: "value", value: [1, 2, 3] });
  });

  it("reports mixed when the values differ", () => {
    const field = transformFieldValue(
      [
        { ...identity, translation: [1, 2, 3] },
        { ...identity, translation: [4, 2, 3] },
      ],
      "translation",
    );
    expect(field).toEqual({ kind: "mixed" });
  });

  it("reports mixed for an empty selection", () => {
    expect(transformFieldValue([], "scale")).toEqual({ kind: "mixed" });
  });

  it("resolves the rotation field as the shared canonical quaternion", () => {
    const q = eulerXYZToQuaternion([0, 0, 0.5]);
    const field = transformRotationValue([
      { ...identity, rotation: q },
      { ...identity, rotation: q },
    ]);
    expect(field).toEqual({ kind: "value", value: q });
    const mixed = transformRotationValue([
      { ...identity, rotation: q },
      { ...identity, rotation: [0, 0, 0, 1] },
    ]);
    expect(mixed).toEqual({ kind: "mixed" });
  });
});

describe("transform edit command construction (plan S7.12)", () => {
  it("replaces only the edited field on every selected node", () => {
    let sequence = 0;
    const nextCommandId = (): CommandId => {
      sequence += 1;
      return commandId(`command:inspector:${String(sequence)}`);
    };
    const commands = buildSetTransformFieldCommands(
      nextCommandId,
      [
        { nodeId: A, transform: { ...identity, translation: [1, 2, 3] } },
        {
          nodeId: B,
          transform: { ...identity, translation: [4, 5, 6], scale: [2, 2, 2] },
        },
      ],
      "translation",
      [9, 9, 9],
    );
    expect(commands).toHaveLength(2);
    const first = commands[0]?.payload as {
      nodeId: NodeId;
      transform: Transform;
    };
    const second = commands[1]?.payload as {
      nodeId: NodeId;
      transform: Transform;
    };
    expect(first.nodeId).toBe(A);
    expect(first.transform.translation).toEqual([9, 9, 9]);
    expect(first.transform.scale).toEqual([1, 1, 1]);
    expect(second.nodeId).toBe(B);
    expect(second.transform.translation).toEqual([9, 9, 9]);
    expect(second.transform.scale).toEqual([2, 2, 2]);
  });

  it("skips nodes whose field already matches the value", () => {
    let sequence = 0;
    const commands = buildSetTransformFieldCommands(
      () => {
        sequence += 1;
        return commandId(`command:inspector:${String(sequence)}`);
      },
      [{ nodeId: A, transform: { ...identity, translation: [1, 2, 3] } }],
      "translation",
      [1, 2, 3],
    );
    expect(commands).toHaveLength(0);
  });

  it("builds component and metadata commands", () => {
    const components = buildSetComponentsCommand(
      commandId("command:inspector:components"),
      A,
      [{ kind: "joint", schemaVersion: 1 }],
    );
    const componentsPayload = components.payload as {
      components: readonly { kind: string }[];
    };
    expect(componentsPayload.components).toEqual([
      { kind: "joint", schemaVersion: 1 },
    ]);

    const metadata = buildSetMetadataCommand(
      commandId("command:inspector:metadata"),
      A,
      '{"tags": ["a", 1]}',
    );
    const metadataPayload = metadata.payload as { metadata: unknown };
    expect(metadataPayload.metadata).toEqual({ tags: ["a", 1] });

    const removed = buildSetMetadataCommand(
      commandId("command:inspector:metadata-remove"),
      A,
      "   ",
    );
    const removedPayload = removed.payload as { metadata: unknown };
    expect(removedPayload.metadata).toBeUndefined();
  });

  it("validates metadata input and formats it back", () => {
    expect(formatMetadata(parseMetadataInput('{"a": {"b": [1, 2]}}'))).toBe(
      '{\n  "a": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}',
    );
    expect(() => parseMetadataInput("[1, 2]")).toThrow(/object/u);
    expect(() => parseMetadataInput("not json")).toThrow(/JSON/u);
    // NaN is not valid JSON; engines reject it at parse time (the helper
    // additionally rejects non-finite numbers defensively).
    expect(() => parseMetadataInput('{"a": NaN}')).toThrow(/JSON|finite/u);
  });
});

describe("articulation component command construction (plan S9.3, ticket #26)", () => {
  it("builds a node.setPivot command with the canonical pivot", () => {
    const command = buildSetPivotCommand(
      commandId("command:inspector:set-pivot"),
      A,
      [1, -0, 2],
    );
    expect(command.type).toBe("node.setPivot");
    expect(command.schemaVersion).toBe(1);
    expect(command.payload).toEqual({ nodeId: A, pivot: [1, 0, 2] });
  });

  it("builds node.removePivot, node.addJoint, and node.removeJoint commands", () => {
    expect(
      buildRemovePivotCommand(commandId("command:inspector:remove-pivot"), A)
        .type,
    ).toBe("node.removePivot");
    expect(
      buildAddJointCommand(commandId("command:inspector:add-joint"), B).type,
    ).toBe("node.addJoint");
    expect(
      buildRemoveJointCommand(commandId("command:inspector:remove-joint"), B)
        .type,
    ).toBe("node.removeJoint");
  });

  it("carries the branded node id in every payload", () => {
    const commands = [
      buildSetPivotCommand(
        commandId("command:inspector:set-pivot"),
        A,
        [0, 0, 0],
      ),
      buildRemovePivotCommand(commandId("command:inspector:remove-pivot"), A),
      buildAddJointCommand(commandId("command:inspector:add-joint"), A),
      buildRemoveJointCommand(commandId("command:inspector:remove-joint"), A),
    ] as const;
    for (const command of commands) {
      expect((command.payload as { nodeId: NodeId }).nodeId).toBe(A);
    }
  });
});

describe("constraint inspector helpers (plan S9.4/S9.5, ticket #27)", () => {
  it("parses six degree values into canonical radian limits", () => {
    const limits = parseLimitsDegreesInput(
      "-45, -10, -180, 45, 10, 180",
      "constraint",
    );
    expect(limits.min[0]).toBeCloseTo(-Math.PI / 4, 12);
    expect(limits.min[1]).toBeCloseTo(-Math.PI / 18, 12);
    expect(limits.min[2]).toBeCloseTo(-Math.PI, 12);
    expect(limits.max[0]).toBeCloseTo(Math.PI / 4, 12);
    expect(limits.max[1]).toBeCloseTo(Math.PI / 18, 12);
    expect(limits.max[2]).toBeCloseTo(Math.PI, 12);
  });

  it("accepts whitespace separated degree values", () => {
    const limits = parseLimitsDegreesInput(
      "-90 -90 -90 90 90 90",
      "constraint",
    );
    expect(limits.min).toEqual([-Math.PI / 2, -Math.PI / 2, -Math.PI / 2]);
    expect(limits.max).toEqual([Math.PI / 2, Math.PI / 2, Math.PI / 2]);
  });

  it("rejects wrong value counts and non-finite input", () => {
    expect(() =>
      parseLimitsDegreesInput("-1, -1, -1, 1, 1", "constraint"),
    ).toThrow(/six numbers/u);
    expect(() =>
      parseLimitsDegreesInput("-1, -1, -1, 1, 1, nope", "constraint"),
    ).toThrow(/Expected a finite number/u);
  });

  it("rejects min greater than max per axis with the axis in the message", () => {
    let error: unknown;
    try {
      parseLimitsDegreesInput("-1, -1, -1, -2, 1, 1", "constraint");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkspaceError);
    if (error instanceof WorkspaceError) {
      expect(error.code).toBe("INVALID_INSPECTOR_INPUT");
      expect(error.message).toContain("axis 0");
    }
  });

  it("formats radian limits as six degree values", () => {
    const limits = {
      min: [-Math.PI / 2, 0, -Math.PI] as [number, number, number],
      max: [Math.PI / 2, 0, Math.PI] as [number, number, number],
    };
    expect(formatLimitsDegrees(limits)).toBe("-90, 0, -180, 90, 0, 180");
  });

  it("round-trips through parse and format", () => {
    const limits = parseLimitsDegreesInput(
      "0, 5, 10, 20, 25, 30",
      "constraint",
    );
    const formatted = formatLimitsDegrees(limits);
    const reparsed = parseLimitsDegreesInput(formatted, "constraint");
    expect(reparsed).toEqual(limits);
  });

  it("builds the four constraint lifecycle commands", () => {
    const idA = componentId("component:inspector:a");
    const idB = componentId("component:inspector:b");
    const limits = {
      min: [-1, -1, -1] as [number, number, number],
      max: [1, 1, 1] as [number, number, number],
    };
    expect(
      buildAddConstraintCommand(
        commandId("command:inspector:add-constraint"),
        A,
        idA,
        limits,
      ).type,
    ).toBe("node.addConstraint");
    expect(
      buildAddConstraintCommand(
        commandId("command:inspector:add-constraint-before"),
        A,
        idB,
        limits,
        idA,
      ).payload,
    ).toEqual({ nodeId: A, componentId: idB, limits, before: idA });
    expect(
      buildSetConstraintCommand(
        commandId("command:inspector:set-constraint"),
        A,
        idA,
        limits,
      ).payload,
    ).toEqual({ nodeId: A, componentId: idA, limits });
    expect(
      buildReorderConstraintCommand(
        commandId("command:inspector:reorder-constraint"),
        A,
        idA,
        null,
      ).payload,
    ).toEqual({ nodeId: A, componentId: idA, before: null });
    expect(
      buildRemoveConstraintCommand(
        commandId("command:inspector:remove-constraint"),
        A,
        idA,
      ).payload,
    ).toEqual({ nodeId: A, componentId: idA });
  });

  it("reports the constrained runtime rotation of a node", () => {
    const document = {
      documentId: "document:inspector:constraint",
      documentSchemaVersion: 1,
      revision: 0,
      metadata: {},
      rootNodeId: A,
      nodes: {
        [A as never]: {
          nodeId: A,
          name: "Constrained",
          parentId: null,
          children: [],
          transform: {
            translation: [0, 0, 0],
            pivot: [0, 0, 0],
            rotation: eulerXYZToQuaternion([(60 * Math.PI) / 180, 0, 0]),
            scale: [1, 1, 1],
          },
          components: [
            {
              kind: "constraint",
              schemaVersion: 1,
              constraints: [
                {
                  componentId: componentId("component:inspector:limit"),
                  type: "rotation-limits",
                  limits: {
                    min: [(-30 * Math.PI) / 180, 0, 0],
                    max: [(30 * Math.PI) / 180, 0, 0],
                  },
                },
              ],
            },
          ],
        },
      },
      materials: {},
      volumes: {},
      animations: {},
    };
    const degrees = constraintRuntimeRotationDegrees(document as never, A);
    expect(degrees?.[0]).toBeCloseTo(30, 8);
    expect(degrees?.[1]).toBeCloseTo(0, 8);
    expect(degrees?.[2]).toBeCloseTo(0, 8);
  });

  it("returns undefined for a missing node", () => {
    const document = {
      documentId: "document:inspector:constraint",
      documentSchemaVersion: 1,
      revision: 0,
      metadata: {},
      rootNodeId: A,
      nodes: {},
      materials: {},
      volumes: {},
      animations: {},
    };
    expect(
      constraintRuntimeRotationDegrees(document as never, A),
    ).toBeUndefined();
  });
});
