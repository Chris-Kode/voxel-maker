import { describe, expect, it } from "vitest";
import {
  commandId,
  nodeId,
  type CommandId,
  type NodeId,
} from "@voxel-maker/shared";
import {
  eulerXYZToQuaternion,
  quaternionToEulerXYZ,
  type Transform,
} from "@voxel-maker/math";
import {
  buildSetComponentsCommand,
  buildSetMetadataCommand,
  buildSetTransformFieldCommands,
  formatMetadata,
  formatNumber,
  formatRotationDegrees,
  formatVec3,
  parseMetadataInput,
  parseRotationDegreesInput,
  parseScaleInput,
  parseVec3Input,
  transformFieldValue,
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

  it("compares rotation through the canonical Euler branch", () => {
    const q = eulerXYZToQuaternion([0, 0, 0.5]);
    const field = transformFieldValue(
      [
        { ...identity, rotation: q },
        { ...identity, rotation: q },
      ],
      "rotation",
    );
    expect(field).toEqual({ kind: "value", value: quaternionToEulerXYZ(q) });
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
