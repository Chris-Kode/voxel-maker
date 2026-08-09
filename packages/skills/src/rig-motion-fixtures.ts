import {
  animationId,
  commandId,
  componentId,
  documentId,
  keyframeId,
  materialId,
  nodeId,
  trackId,
  volumeId,
  type ComponentId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import {
  addConstraintCommand,
  addJointCommand,
  addTrackCommand,
  createAnimationCommand,
  setKeyframeCommand,
  setPivotCommand,
  type Command,
} from "@voxel-maker/commands";
import {
  createDocument,
  type AnimationDescriptor,
  type Component,
  type SceneNode,
  type VoxelDocument,
} from "@voxel-maker/model";

/** Local transform shape (mirrors the generic transform record). */
interface Transform {
  readonly translation: readonly [number, number, number];
  readonly pivot: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

/**
 * Fixed rig/motion evaluation fixtures (plan S14.7/S14.8/S14.10, ticket
 * #39): deterministic unrigged documents (the fixed starting points of
 * the rigging scenarios), rigged documents (the golden end states the
 * rigging skills' checks must pass on), and rigged-plus-clip documents
 * (the golden end states of the motion scenarios). Every fixture is
 * built only from generic core symbols — nodes, transforms, voxel
 * volumes, pivots, joints, constraints, clips, tracks, keyframes — and
 * carries no category-specific core type (plan S14.9). Fixture ids are
 * referenced by the skill evaluation metadata (`evaluation.fixtureId`),
 * so each rigging/motion skill is evaluated against a fixed, resolvable
 * fixture; the documents never contain the string "skill" (the catalog
 * removal boundary proves saved assets stay catalog-free).
 */

/** Stable ids of the fixed rig/motion evaluation fixtures. */
export const RIG_MOTION_FIXTURE_IDS = {
  bipedRig: "rig-biped",
  quadrupedRig: "rig-quadruped",
  wingsRig: "rig-wings",
  linkageRig: "rig-linkage",
  walk: "motion-walk",
  run: "motion-run",
  jump: "motion-jump",
  idle: "motion-idle",
  fly: "motion-fly",
  mechanical: "motion-mechanical",
} as const;

export type RigMotionFixtureId =
  (typeof RIG_MOTION_FIXTURE_IDS)[keyof typeof RIG_MOTION_FIXTURE_IDS];

/** One fixed rig/motion evaluation fixture (start + golden end state). */
export interface RigMotionFixture {
  /** Stable fixture id referenced by skill evaluation metadata. */
  readonly id: string;
  /** Knowledge kind of the fixture scenario. */
  readonly kind: "rigging" | "motion";
  /** The deterministic starting document of the fixed scenario. */
  readonly start: VoxelDocument;
  /** The deterministic golden end state of the fixed scenario. */
  readonly end: VoxelDocument;
}

const identity: Transform = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

const pivot = (value: readonly [number, number, number]): Component => ({
  kind: "pivot",
  schemaVersion: 1,
  pivot: [...value],
});

const joint: Component = { kind: "joint", schemaVersion: 1 };

/** A rotation-limits constraint component with one descriptor. */
const constraint = (
  id: ComponentId,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): Component => ({
  kind: "constraint",
  schemaVersion: 1,
  constraints: [
    {
      componentId: id,
      type: "rotation-limits",
      limits: { min: [...min], max: [...max] },
    },
  ],
});

const voxel = (id: VolumeId): Component => ({
  kind: "voxel",
  schemaVersion: 1,
  volumeId: id,
});

/** Fixed rotation-limit ranges of the joint constraints (per-axis min/max). */
const LIMIT = {
  free: [-Math.PI, Math.PI] as const,
  elbow: [-1.2, 0.2] as const,
  knee: [0, 1.4] as const,
  flap: [-0.6, 0.6] as const,
  pivot: [-0.9, 0.9] as const,
} as const;

/** A per-axis limit range; the other axes stay free. */
function limitOn(
  axis: 0 | 1 | 2,
  range: readonly [number, number],
): {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
} {
  const min: [number, number, number] = [-Math.PI, -Math.PI, -Math.PI];
  const max: [number, number, number] = [Math.PI, Math.PI, Math.PI];
  min[axis] = range[0];
  max[axis] = range[1];
  return { min, max };
}

interface Part {
  readonly nodeId: NodeId;
  readonly name: string;
  /** `null` means the fixture root. */
  readonly parentId: NodeId | null;
  readonly components: readonly Component[];
  readonly volume: {
    readonly volumeId: VolumeId;
    readonly bounds: readonly [
      readonly [number, number, number],
      readonly [number, number, number],
    ];
  };
}

/**
 * Assembles a fixture document from parts and optional clips. An end
 * state shares the start document's id and carries the revision the
 * state has after one skill apply (revision 1), so the golden end state
 * is byte-identical in semantic identity to a store that applied the
 * recorded golden trace (document id and revision are part of the
 * canonical identity).
 */
function buildFixture(
  title: string,
  documentIdValue: string,
  parts: readonly Part[],
  animations: readonly AnimationDescriptor[] = [],
  revision = 0,
): VoxelDocument {
  const nodes: SceneNode[] = parts.map((part) => {
    const pivotComponent = part.components.find(
      (
        component,
      ): component is Extract<Component, { readonly kind: "pivot" }> =>
        component.kind === "pivot",
    );
    // Write-through mirrors the node.setPivot command semantics: the
    // pivot annotation and transform.pivot stay in sync, so the golden
    // end state matches a state produced by the recorded command trace.
    const transform =
      pivotComponent === undefined
        ? identity
        : { ...identity, pivot: pivotComponent.pivot };
    return {
      nodeId: part.nodeId,
      name: part.name,
      parentId: part.parentId,
      children: parts
        .filter((candidate) => candidate.parentId === part.nodeId)
        .map((candidate) => candidate.nodeId),
      transform,
      components: [...part.components],
    };
  });
  return createDocument({
    documentId: documentId(documentIdValue),
    metadata: { title, kind: "fixture" },
    revision,
    rootNodeId: parts[0]?.nodeId ?? nodeId("node:rig:empty"),
    nodes,
    materials: [
      {
        materialId: materialId(1),
        name: "primary",
        color: "#888888",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: parts.map((part) => ({
      volumeId: part.volume.volumeId,
      name: part.name,
      bounds: {
        min: [...part.volume.bounds[0]],
        max: [...part.volume.bounds[1]],
      },
    })),
    animations: [...animations],
  });
}

/** The unrigged biped: torso, head, two two-segment arms, two two-segment legs. */
function bipedParts(): readonly Part[] {
  return [
    {
      nodeId: nodeId("node:rig:biped:torso"),
      name: "Torso",
      parentId: null,
      components: [voxel(volumeId("volume:rig:biped:torso"))],
      volume: {
        volumeId: volumeId("volume:rig:biped:torso"),
        bounds: [
          [-2, 2, -1],
          [2, 6, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:biped:head"),
      name: "Head",
      parentId: nodeId("node:rig:biped:torso"),
      components: [voxel(volumeId("volume:rig:biped:head"))],
      volume: {
        volumeId: volumeId("volume:rig:biped:head"),
        bounds: [
          [-1, 6, -1],
          [1, 8, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:biped:arm-upper-left"),
      name: "Upper Arm Left",
      parentId: nodeId("node:rig:biped:torso"),
      components: [voxel(volumeId("volume:rig:biped:arm-upper-left"))],
      volume: {
        volumeId: volumeId("volume:rig:biped:arm-upper-left"),
        bounds: [
          [-4, 4, -1],
          [-2, 6, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:biped:arm-fore-left"),
      name: "Forearm Left",
      parentId: nodeId("node:rig:biped:arm-upper-left"),
      components: [voxel(volumeId("volume:rig:biped:arm-fore-left"))],
      volume: {
        volumeId: volumeId("volume:rig:biped:arm-fore-left"),
        bounds: [
          [-4, 2, -1],
          [-2, 4, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:biped:arm-upper-right"),
      name: "Upper Arm Right",
      parentId: nodeId("node:rig:biped:torso"),
      components: [voxel(volumeId("volume:rig:biped:arm-upper-right"))],
      volume: {
        volumeId: volumeId("volume:rig:biped:arm-upper-right"),
        bounds: [
          [2, 4, -1],
          [4, 6, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:biped:arm-fore-right"),
      name: "Forearm Right",
      parentId: nodeId("node:rig:biped:arm-upper-right"),
      components: [voxel(volumeId("volume:rig:biped:arm-fore-right"))],
      volume: {
        volumeId: volumeId("volume:rig:biped:arm-fore-right"),
        bounds: [
          [2, 2, -1],
          [4, 4, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:biped:leg-thigh-left"),
      name: "Thigh Left",
      parentId: nodeId("node:rig:biped:torso"),
      components: [voxel(volumeId("volume:rig:biped:leg-thigh-left"))],
      volume: {
        volumeId: volumeId("volume:rig:biped:leg-thigh-left"),
        bounds: [
          [-2, 2, -1],
          [0, 4, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:biped:leg-shin-left"),
      name: "Shin Left",
      parentId: nodeId("node:rig:biped:leg-thigh-left"),
      components: [voxel(volumeId("volume:rig:biped:leg-shin-left"))],
      volume: {
        volumeId: volumeId("volume:rig:biped:leg-shin-left"),
        bounds: [
          [-2, 0, -1],
          [0, 2, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:biped:leg-thigh-right"),
      name: "Thigh Right",
      parentId: nodeId("node:rig:biped:torso"),
      components: [voxel(volumeId("volume:rig:biped:leg-thigh-right"))],
      volume: {
        volumeId: volumeId("volume:rig:biped:leg-thigh-right"),
        bounds: [
          [0, 2, -1],
          [2, 4, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:biped:leg-shin-right"),
      name: "Shin Right",
      parentId: nodeId("node:rig:biped:leg-thigh-right"),
      components: [voxel(volumeId("volume:rig:biped:leg-shin-right"))],
      volume: {
        volumeId: volumeId("volume:rig:biped:leg-shin-right"),
        bounds: [
          [0, 0, -1],
          [2, 2, 1],
        ],
      },
    },
  ];
}

/**
 * The rigged biped: pivots at the neck, shoulders, elbows, hips, and
 * knees; a joint at each articulation; elbow and knee rotation limits.
 */
function bipedRigParts(): readonly Part[] {
  const parts = bipedParts();
  const rigged: Record<string, Component[]> = {
    "node:rig:biped:head": [pivot([0, 6, 0]), joint],
    "node:rig:biped:arm-upper-left": [pivot([-3, 6, 0]), joint],
    "node:rig:biped:arm-fore-left": [
      pivot([-3, 4, 0]),
      joint,
      constraint(
        componentId("component:rig:biped:elbow-left"),
        limitOn(0, LIMIT.elbow).min,
        limitOn(0, LIMIT.elbow).max,
      ),
    ],
    "node:rig:biped:arm-upper-right": [pivot([3, 6, 0]), joint],
    "node:rig:biped:arm-fore-right": [
      pivot([3, 4, 0]),
      joint,
      constraint(
        componentId("component:rig:biped:elbow-right"),
        limitOn(0, LIMIT.elbow).min,
        limitOn(0, LIMIT.elbow).max,
      ),
    ],
    "node:rig:biped:leg-thigh-left": [pivot([-1, 4, 0]), joint],
    "node:rig:biped:leg-shin-left": [
      pivot([-1, 2, 0]),
      joint,
      constraint(
        componentId("component:rig:biped:knee-left"),
        limitOn(0, LIMIT.knee).min,
        limitOn(0, LIMIT.knee).max,
      ),
    ],
    "node:rig:biped:leg-thigh-right": [pivot([1, 4, 0]), joint],
    "node:rig:biped:leg-shin-right": [
      pivot([1, 2, 0]),
      joint,
      constraint(
        componentId("component:rig:biped:knee-right"),
        limitOn(0, LIMIT.knee).min,
        limitOn(0, LIMIT.knee).max,
      ),
    ],
  };
  return parts.map((part) => ({
    ...part,
    components: [...part.components, ...(rigged[part.nodeId] ?? [])],
  }));
}

/** The unrigged quadruped: body, head, tail, four two-segment legs. */
function quadrupedParts(): readonly Part[] {
  return [
    {
      nodeId: nodeId("node:rig:quad:body"),
      name: "Body",
      parentId: null,
      components: [voxel(volumeId("volume:rig:quad:body"))],
      volume: {
        volumeId: volumeId("volume:rig:quad:body"),
        bounds: [
          [-3, 2, -2],
          [3, 4, 2],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:quad:head"),
      name: "Head",
      parentId: nodeId("node:rig:quad:body"),
      components: [voxel(volumeId("volume:rig:quad:head"))],
      volume: {
        volumeId: volumeId("volume:rig:quad:head"),
        bounds: [
          [-5, 3, -1],
          [-3, 5, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:quad:tail"),
      name: "Tail",
      parentId: nodeId("node:rig:quad:body"),
      components: [voxel(volumeId("volume:rig:quad:tail"))],
      volume: {
        volumeId: volumeId("volume:rig:quad:tail"),
        bounds: [
          [3, 3, 0],
          [5, 4, 1],
        ],
      },
    },
    ...legQuadrupedPart(
      "front-left",
      [-2, 1, -2],
      [-1, 3, -1],
      [-2, 0, -2],
      [-1, 1, -1],
    ),
    ...legQuadrupedPart(
      "front-right",
      [-2, 1, 1],
      [-1, 3, 2],
      [-2, 0, 1],
      [-1, 1, 2],
    ),
    ...legQuadrupedPart(
      "hind-left",
      [1, 1, -2],
      [2, 3, -1],
      [1, 0, -2],
      [2, 1, -1],
    ),
    ...legQuadrupedPart(
      "hind-right",
      [1, 1, 1],
      [2, 3, 2],
      [1, 0, 1],
      [2, 1, 2],
    ),
  ];
}

/** Two segments (thigh + shin) of one quadruped leg. */
function legQuadrupedPart(
  label: string,
  thighMin: readonly [number, number, number],
  thighMax: readonly [number, number, number],
  shinMin: readonly [number, number, number],
  shinMax: readonly [number, number, number],
): readonly Part[] {
  const thighId = nodeId(`node:rig:quad:thigh-${label}`);
  const shinId = nodeId(`node:rig:quad:shin-${label}`);
  return [
    {
      nodeId: thighId,
      name: `Thigh ${label}`,
      parentId: nodeId("node:rig:quad:body"),
      components: [voxel(volumeId(`volume:rig:quad:thigh-${label}`))],
      volume: {
        volumeId: volumeId(`volume:rig:quad:thigh-${label}`),
        bounds: [thighMin, thighMax],
      },
    },
    {
      nodeId: shinId,
      name: `Shin ${label}`,
      parentId: thighId,
      components: [voxel(volumeId(`volume:rig:quad:shin-${label}`))],
      volume: {
        volumeId: volumeId(`volume:rig:quad:shin-${label}`),
        bounds: [shinMin, shinMax],
      },
    },
  ];
}

/** The rigged quadruped: pivots and joints at the neck, tail, hips, and knees. */
function quadrupedRigParts(): readonly Part[] {
  const parts = quadrupedParts();
  const rigged: Record<string, Component[]> = {
    "node:rig:quad:head": [pivot([-4, 4, 0]), joint],
    "node:rig:quad:tail": [pivot([3, 4, 0]), joint],
  };
  for (const label of [
    "front-left",
    "front-right",
    "hind-left",
    "hind-right",
  ]) {
    rigged[`node:rig:quad:thigh-${label}`] = [
      pivot([
        label.startsWith("front") ? -1.5 : 1.5,
        3,
        label.endsWith("left") ? -1 : 1,
      ]),
      joint,
    ];
    rigged[`node:rig:quad:shin-${label}`] = [
      pivot([
        label.startsWith("front") ? -1.5 : 1.5,
        1,
        label.endsWith("left") ? -1 : 1,
      ]),
      joint,
      constraint(
        componentId(`component:rig:quad:knee-${label}`),
        limitOn(0, LIMIT.knee).min,
        limitOn(0, LIMIT.knee).max,
      ),
    ];
  }
  return parts.map((part) => ({
    ...part,
    components: [...part.components, ...(rigged[part.nodeId] ?? [])],
  }));
}

/** The unrigged paired wings: body plus left and right wing. */
function wingsParts(): readonly Part[] {
  return [
    {
      nodeId: nodeId("node:rig:wings:body"),
      name: "Body",
      parentId: null,
      components: [voxel(volumeId("volume:rig:wings:body"))],
      volume: {
        volumeId: volumeId("volume:rig:wings:body"),
        bounds: [
          [-1, 1, -1],
          [1, 3, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:wings:left"),
      name: "Wing Left",
      parentId: nodeId("node:rig:wings:body"),
      components: [voxel(volumeId("volume:rig:wings:left"))],
      volume: {
        volumeId: volumeId("volume:rig:wings:left"),
        bounds: [
          [-4, 2, -1],
          [-1, 3, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:wings:right"),
      name: "Wing Right",
      parentId: nodeId("node:rig:wings:body"),
      components: [voxel(volumeId("volume:rig:wings:right"))],
      volume: {
        volumeId: volumeId("volume:rig:wings:right"),
        bounds: [
          [1, 2, -1],
          [4, 3, 1],
        ],
      },
    },
  ];
}

/** The rigged wings: wing-root pivots, joints, and flap limits. */
function wingsRigParts(): readonly Part[] {
  const parts = wingsParts();
  return parts.map((part) => ({
    ...part,
    components: [
      ...part.components,
      ...(part.nodeId === "node:rig:wings:left"
        ? [
            pivot([-1, 3, 0]),
            joint,
            constraint(
              componentId("component:rig:wings:left-flap"),
              limitOn(2, LIMIT.flap).min,
              limitOn(2, LIMIT.flap).max,
            ),
          ]
        : part.nodeId === "node:rig:wings:right"
          ? [
              pivot([1, 3, 0]),
              joint,
              constraint(
                componentId("component:rig:wings:right-flap"),
                limitOn(2, LIMIT.flap).min,
                limitOn(2, LIMIT.flap).max,
              ),
            ]
          : []),
    ],
  }));
}

/** The unrigged mechanical linkage: base plus three linked segments. */
function linkageParts(): readonly Part[] {
  return [
    {
      nodeId: nodeId("node:rig:link:base"),
      name: "Base",
      parentId: null,
      components: [voxel(volumeId("volume:rig:link:base"))],
      volume: {
        volumeId: volumeId("volume:rig:link:base"),
        bounds: [
          [-1, 0, -1],
          [1, 1, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:link:link1"),
      name: "Link 1",
      parentId: nodeId("node:rig:link:base"),
      components: [voxel(volumeId("volume:rig:link:link1"))],
      volume: {
        volumeId: volumeId("volume:rig:link:link1"),
        bounds: [
          [0, 1, -1],
          [1, 3, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:link:link2"),
      name: "Link 2",
      parentId: nodeId("node:rig:link:link1"),
      components: [voxel(volumeId("volume:rig:link:link2"))],
      volume: {
        volumeId: volumeId("volume:rig:link:link2"),
        bounds: [
          [1, 1, -1],
          [2, 3, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:link:link3"),
      name: "Link 3",
      parentId: nodeId("node:rig:link:link2"),
      components: [voxel(volumeId("volume:rig:link:link3"))],
      volume: {
        volumeId: volumeId("volume:rig:link:link3"),
        bounds: [
          [2, 1, -1],
          [3, 3, 1],
        ],
      },
    },
  ];
}

/** The rigged linkage: pivot and joint at each segment root, joint limits. */
function linkageRigParts(): readonly Part[] {
  const parts = linkageParts();
  return parts.map((part) => ({
    ...part,
    components: [
      ...part.components,
      ...(part.nodeId === "node:rig:link:link1"
        ? [pivot([1, 3, 0]), joint]
        : part.nodeId === "node:rig:link:link2"
          ? [
              pivot([2, 3, 0]),
              joint,
              constraint(
                componentId("component:rig:link:elbow"),
                limitOn(2, LIMIT.pivot).min,
                limitOn(2, LIMIT.pivot).max,
              ),
            ]
          : part.nodeId === "node:rig:link:link3"
            ? [
                pivot([3, 3, 0]),
                joint,
                constraint(
                  componentId("component:rig:link:wrist"),
                  limitOn(2, LIMIT.pivot).min,
                  limitOn(2, LIMIT.pivot).max,
                ),
              ]
            : []),
    ],
  }));
}

/**
 * Rotation keyframe helper: quaternion values are literal constants of
 * the axis-angle convention `[axis * sin(a/2), cos(a/2)]` (ticket #39
 * fixtures stay inside the skills package dependency boundary, so the
 * quaternion factory of @voxel-maker/math is never imported).
 */
function rotationKeyframe(
  label: string,
  time: number,
  quaternion: readonly [number, number, number, number],
): {
  readonly keyframeId: ReturnType<typeof keyframeId>;
  readonly time: number;
  readonly property: {
    readonly channel: "rotation";
    readonly value: readonly [number, number, number, number];
  };
} {
  return {
    keyframeId: keyframeId(`keyframe:rig-motion:${label}:${String(time)}`),
    time,
    property: {
      channel: "rotation",
      value: [...quaternion],
    },
  };
}

/** A track targeting one node of a fixture document. */
function track(
  label: string,
  targetNodeId: NodeId,
  keyframes: readonly ReturnType<typeof rotationKeyframe>[],
): AnimationDescriptor["tracks"][number] {
  return {
    trackId: trackId(`track:rig-motion:${label}`),
    targetNodeId,
    interpolation: "linear",
    keyframes: [...keyframes],
  };
}

/** A clip descriptor over one or more fixture tracks. */
function clip(
  label: string,
  name: string,
  duration: number,
  loop: "once" | "loop",
  tracks: readonly AnimationDescriptor["tracks"][number][],
): AnimationDescriptor {
  return {
    animationId: animationId(`animation:rig-motion:${label}:0001`),
    name,
    duration,
    loop,
    tracks: [...tracks],
  };
}

/** Fixed quaternion literals (axis-angle convention, w = cos(a/2)). */
const Q = {
  identity: [0, 0, 0, 1] as const,
  x0_5: [0.24740395925452294, 0, 0, 0.96891242171064473] as const,
  xNeg0_5: [-0.24740395925452294, 0, 0, 0.96891242171064473] as const,
  x0_3: [0.14943813247359922, 0, 0, 0.98877107793604224] as const,
  xNeg0_3: [-0.14943813247359922, 0, 0, 0.98877107793604224] as const,
  x0_4: [0.19866933079506122, 0, 0, 0.9800665778412416] as const,
  xNeg0_4: [-0.19866933079506122, 0, 0, 0.9800665778412416] as const,
  x0_7: [0.34289780745545134, 0, 0, 0.93937271284737889] as const,
  xNeg0_7: [-0.34289780745545134, 0, 0, 0.93937271284737889] as const,
  x0_8: [0.38941834230865052, 0, 0, 0.9210609940028851] as const,
  z0_6: [0, 0, 0.29552020666133955, 0.95533648912560598] as const,
  zNeg0_6: [0, 0, -0.29552020666133955, 0.95533648912560598] as const,
  y0_05: [0, 0.024997395914712332, 0, 0.99968751627570263] as const,
  yNeg0_05: [0, -0.024997395914712332, 0, 0.99968751627570263] as const,
  z0_8: [0, 0, 0.38941834230865052, 0.9210609940028851] as const,
  zNeg0_4: [0, 0, -0.19866933079506122, 0.98006657784124163] as const,
};

const BIPED = {
  torso: nodeId("node:rig:biped:torso"),
  head: nodeId("node:rig:biped:head"),
  armUpperLeft: nodeId("node:rig:biped:arm-upper-left"),
  armForeLeft: nodeId("node:rig:biped:arm-fore-left"),
  armUpperRight: nodeId("node:rig:biped:arm-upper-right"),
  armForeRight: nodeId("node:rig:biped:arm-fore-right"),
  thighLeft: nodeId("node:rig:biped:leg-thigh-left"),
  shinLeft: nodeId("node:rig:biped:leg-shin-left"),
  thighRight: nodeId("node:rig:biped:leg-thigh-right"),
  shinRight: nodeId("node:rig:biped:leg-shin-right"),
} as const;

/** Walk clip: two-step gait, seamless loop (endpoint equals start). */
function walkClip(): AnimationDescriptor {
  return clip("walk", "Walk", 2, "loop", [
    track("walk-thigh-left", BIPED.thighLeft, [
      rotationKeyframe("walk-thigh-left", 0, Q.identity),
      rotationKeyframe("walk-thigh-left", 1, Q.x0_5),
      rotationKeyframe("walk-thigh-left", 2, Q.identity),
    ]),
    track("walk-thigh-right", BIPED.thighRight, [
      rotationKeyframe("walk-thigh-right", 0, Q.identity),
      rotationKeyframe("walk-thigh-right", 1, Q.xNeg0_5),
      rotationKeyframe("walk-thigh-right", 2, Q.identity),
    ]),
    track("walk-shin-left", BIPED.shinLeft, [
      rotationKeyframe("walk-shin-left", 0, Q.identity),
      rotationKeyframe("walk-shin-left", 1, Q.x0_3),
      rotationKeyframe("walk-shin-left", 2, Q.identity),
    ]),
    track("walk-shin-right", BIPED.shinRight, [
      rotationKeyframe("walk-shin-right", 0, Q.identity),
      rotationKeyframe("walk-shin-right", 1, Q.xNeg0_3),
      rotationKeyframe("walk-shin-right", 2, Q.identity),
    ]),
  ]);
}

/** Run clip: faster stride, seamless loop. */
function runClip(): AnimationDescriptor {
  return clip("run", "Run", 1, "loop", [
    track("run-thigh-left", BIPED.thighLeft, [
      rotationKeyframe("run-thigh-left", 0, Q.identity),
      rotationKeyframe("run-thigh-left", 0.5, Q.x0_7),
      rotationKeyframe("run-thigh-left", 1, Q.identity),
    ]),
    track("run-thigh-right", BIPED.thighRight, [
      rotationKeyframe("run-thigh-right", 0, Q.identity),
      rotationKeyframe("run-thigh-right", 0.5, Q.xNeg0_7),
      rotationKeyframe("run-thigh-right", 1, Q.identity),
    ]),
    track("run-shin-left", BIPED.shinLeft, [
      rotationKeyframe("run-shin-left", 0, Q.identity),
      rotationKeyframe("run-shin-left", 0.5, Q.x0_4),
      rotationKeyframe("run-shin-left", 1, Q.identity),
    ]),
    track("run-shin-right", BIPED.shinRight, [
      rotationKeyframe("run-shin-right", 0, Q.identity),
      rotationKeyframe("run-shin-right", 0.5, Q.xNeg0_4),
      rotationKeyframe("run-shin-right", 1, Q.identity),
    ]),
  ]);
}

/** Jump clip: legs tuck and return once (non-looping). */
function jumpClip(): AnimationDescriptor {
  return clip("jump", "Jump", 1.5, "once", [
    track("jump-thigh-left", BIPED.thighLeft, [
      rotationKeyframe("jump-thigh-left", 0, Q.identity),
      rotationKeyframe("jump-thigh-left", 0.75, Q.x0_8),
      rotationKeyframe("jump-thigh-left", 1.5, Q.identity),
    ]),
    track("jump-thigh-right", BIPED.thighRight, [
      rotationKeyframe("jump-thigh-right", 0, Q.identity),
      rotationKeyframe("jump-thigh-right", 0.75, Q.x0_8),
      rotationKeyframe("jump-thigh-right", 1.5, Q.identity),
    ]),
  ]);
}

/** Idle clip: subtle sway of the torso and head (looping). */
function idleClip(): AnimationDescriptor {
  return clip("idle", "Idle", 4, "loop", [
    track("idle-head", BIPED.head, [
      rotationKeyframe("idle-head", 0, Q.identity),
      rotationKeyframe("idle-head", 2, Q.y0_05),
      rotationKeyframe("idle-head", 4, Q.identity),
    ]),
    track("idle-torso", BIPED.torso, [
      rotationKeyframe("idle-torso", 0, Q.identity),
      rotationKeyframe("idle-torso", 2, Q.yNeg0_05),
      rotationKeyframe("idle-torso", 4, Q.identity),
    ]),
  ]);
}

const WINGS = {
  body: nodeId("node:rig:wings:body"),
  left: nodeId("node:rig:wings:left"),
  right: nodeId("node:rig:wings:right"),
} as const;

/** Fly clip: alternating wing flap, seamless loop. */
function flyClip(): AnimationDescriptor {
  return clip("fly", "Fly", 1, "loop", [
    track("fly-left", WINGS.left, [
      rotationKeyframe("fly-left", 0, Q.identity),
      rotationKeyframe("fly-left", 0.5, Q.z0_6),
      rotationKeyframe("fly-left", 1, Q.identity),
    ]),
    track("fly-right", WINGS.right, [
      rotationKeyframe("fly-right", 0, Q.identity),
      rotationKeyframe("fly-right", 0.5, Q.zNeg0_6),
      rotationKeyframe("fly-right", 1, Q.identity),
    ]),
  ]);
}

const LINKAGE = {
  base: nodeId("node:rig:link:base"),
  link1: nodeId("node:rig:link:link1"),
  link2: nodeId("node:rig:link:link2"),
  link3: nodeId("node:rig:link:link3"),
} as const;

/** Mechanical motion clip: alternating joint sweep, seamless loop. */
function mechanicalClip(): AnimationDescriptor {
  return clip("mechanical", "Mechanical Sweep", 2, "loop", [
    track("mech-link2", LINKAGE.link2, [
      rotationKeyframe("mech-link2", 0, Q.identity),
      rotationKeyframe("mech-link2", 1, Q.z0_8),
      rotationKeyframe("mech-link2", 2, Q.identity),
    ]),
    track("mech-link3", LINKAGE.link3, [
      rotationKeyframe("mech-link3", 0, Q.identity),
      rotationKeyframe("mech-link3", 1, Q.zNeg0_4),
      rotationKeyframe("mech-link3", 2, Q.identity),
    ]),
  ]);
}

/**
 * Golden biped-rig trace (plan S14.10, ticket #39): the exact recorded
 * setPivot/addJoint/addConstraint commands whose committed result is the
 * `rig-biped` end fixture. Ids are stable so the applied state is
 * byte-identical in canonical identity to the golden end state.
 */
export function bipedRigGoldenCommands(): readonly Command[] {
  const pivots: readonly {
    nodeId: string;
    pivot: readonly [number, number, number];
  }[] = [
    { nodeId: "node:rig:biped:head", pivot: [0, 6, 0] },
    { nodeId: "node:rig:biped:arm-upper-left", pivot: [-3, 6, 0] },
    { nodeId: "node:rig:biped:arm-fore-left", pivot: [-3, 4, 0] },
    { nodeId: "node:rig:biped:arm-upper-right", pivot: [3, 6, 0] },
    { nodeId: "node:rig:biped:arm-fore-right", pivot: [3, 4, 0] },
    { nodeId: "node:rig:biped:leg-thigh-left", pivot: [-1, 4, 0] },
    { nodeId: "node:rig:biped:leg-shin-left", pivot: [-1, 2, 0] },
    { nodeId: "node:rig:biped:leg-thigh-right", pivot: [1, 4, 0] },
    { nodeId: "node:rig:biped:leg-shin-right", pivot: [1, 2, 0] },
  ];
  const constraints: readonly {
    nodeId: string;
    componentId: string;
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  }[] = [
    {
      nodeId: "node:rig:biped:arm-fore-left",
      componentId: "component:rig:biped:elbow-left",
      min: [-1.2, -Math.PI, -Math.PI],
      max: [0.2, Math.PI, Math.PI],
    },
    {
      nodeId: "node:rig:biped:arm-fore-right",
      componentId: "component:rig:biped:elbow-right",
      min: [-1.2, -Math.PI, -Math.PI],
      max: [0.2, Math.PI, Math.PI],
    },
    {
      nodeId: "node:rig:biped:leg-shin-left",
      componentId: "component:rig:biped:knee-left",
      min: [0, -Math.PI, -Math.PI],
      max: [1.4, Math.PI, Math.PI],
    },
    {
      nodeId: "node:rig:biped:leg-shin-right",
      componentId: "component:rig:biped:knee-right",
      min: [0, -Math.PI, -Math.PI],
      max: [1.4, Math.PI, Math.PI],
    },
  ];
  const commands: Command[] = [];
  let index = 0;
  for (const entry of pivots) {
    commands.push(
      setPivotCommand(commandId(`command:rig-trace:pivot:${String(index)}`), {
        nodeId: entry.nodeId as NodeId,
        pivot: [...entry.pivot],
      }),
    );
    index += 1;
  }
  for (const entry of pivots) {
    commands.push(
      addJointCommand(commandId(`command:rig-trace:joint:${String(index)}`), {
        nodeId: entry.nodeId as NodeId,
      }),
    );
    index += 1;
  }
  for (const entry of constraints) {
    commands.push(
      addConstraintCommand(
        commandId(`command:rig-trace:constraint:${String(index)}`),
        {
          nodeId: entry.nodeId as NodeId,
          componentId: entry.componentId as ComponentId,
          limits: { min: [...entry.min], max: [...entry.max] },
          before: null,
        },
      ),
    );
    index += 1;
  }
  return commands;
}

/**
 * Golden walk-clip trace (plan S14.10, ticket #39): the exact recorded
 * createAnimation/addTrack/setKeyframe commands whose committed result
 * is the `motion-walk` end fixture. Track and keyframe ids mirror the
 * fixture's walk clip byte-for-byte (ids are part of the canonical
 * identity).
 */
export function walkGoldenCommands(): readonly Command[] {
  const commands: Command[] = [];
  const clipId = animationId("animation:rig-motion:walk:0001");
  commands.push(
    createAnimationCommand(commandId("command:walk-trace:animation"), {
      animationId: clipId,
      name: "Walk",
      duration: 2,
      loop: "loop",
    }),
  );
  const tracks: readonly { target: string; label: string }[] = [
    { target: "node:rig:biped:leg-thigh-left", label: "walk-thigh-left" },
    { target: "node:rig:biped:leg-thigh-right", label: "walk-thigh-right" },
    { target: "node:rig:biped:leg-shin-left", label: "walk-shin-left" },
    { target: "node:rig:biped:leg-shin-right", label: "walk-shin-right" },
  ];
  // Quaternion constants of the axis-angle convention (0.5 rad and
  // 0.3 rad about +X / -X, w = cos(a/2)).
  const identity = [0, 0, 0, 1] as const;
  const x05 = [0.24740395925452294, 0, 0, 0.96891242171064473] as const;
  const xNeg05 = [-0.24740395925452294, 0, 0, 0.96891242171064473] as const;
  const x03 = [0.14943813247359922, 0, 0, 0.98877107793604224] as const;
  const xNeg03 = [-0.14943813247359922, 0, 0, 0.98877107793604224] as const;
  const swings: Readonly<
    Record<string, readonly (readonly [number, number, number, number])[]>
  > = {
    "walk-thigh-left": [identity, x05, identity],
    "walk-thigh-right": [identity, xNeg05, identity],
    "walk-shin-left": [identity, x03, identity],
    "walk-shin-right": [identity, xNeg03, identity],
  };
  let trackIndex = 0;
  for (const { target, label } of tracks) {
    const trackIdValue = trackId(`track:rig-motion:${label}`);
    commands.push(
      addTrackCommand(
        commandId(`command:walk-trace:track:${String(trackIndex)}`),
        {
          animationId: clipId,
          trackId: trackIdValue,
          targetNodeId: target as NodeId,
          interpolation: "linear",
        },
      ),
    );
    const swing = swings[label] ?? [identity];
    for (const [keyframeIndex, quaternion] of swing.entries()) {
      commands.push(
        setKeyframeCommand(
          commandId(
            `command:walk-trace:key:${String(trackIndex)}:${String(keyframeIndex)}`,
          ),
          {
            animationId: clipId,
            trackId: trackIdValue,
            keyframeId: keyframeId(
              `keyframe:rig-motion:${label}:${String(keyframeIndex)}`,
            ),
            time: keyframeIndex,
            property: { channel: "rotation", value: [...quaternion] },
          },
        ),
      );
    }
    trackIndex += 1;
  }
  return commands;
}

/**
 * The fixed rig/motion evaluation fixtures (plan S14.10, ticket #39).
 * Rigging fixtures pair an unrigged start with the golden rigged end
 * state; motion fixtures pair a rigged (clip-free) start with the golden
 * rigged-plus-clip end state. Every end state shares the start's
 * document id at revision 1 (the state after one skill apply). Order is
 * stable and documented.
 */
export const RIG_MOTION_FIXTURES: readonly RigMotionFixture[] = Object.freeze([
  {
    id: RIG_MOTION_FIXTURE_IDS.bipedRig,
    kind: "rigging",
    start: buildFixture(
      "biped rig fixture",
      "document:rig-motion:biped:start",
      bipedParts(),
    ),
    end: buildFixture(
      "biped rig fixture",
      "document:rig-motion:biped:start",
      bipedRigParts(),
      [],
      1,
    ),
  },
  {
    id: RIG_MOTION_FIXTURE_IDS.quadrupedRig,
    kind: "rigging",
    start: buildFixture(
      "quadruped rig fixture",
      "document:rig-motion:quadruped:start",
      quadrupedParts(),
    ),
    end: buildFixture(
      "quadruped rig fixture",
      "document:rig-motion:quadruped:start",
      quadrupedRigParts(),
      [],
      1,
    ),
  },
  {
    id: RIG_MOTION_FIXTURE_IDS.wingsRig,
    kind: "rigging",
    start: buildFixture(
      "wings rig fixture",
      "document:rig-motion:wings:start",
      wingsParts(),
    ),
    end: buildFixture(
      "wings rig fixture",
      "document:rig-motion:wings:start",
      wingsRigParts(),
      [],
      1,
    ),
  },
  {
    id: RIG_MOTION_FIXTURE_IDS.linkageRig,
    kind: "rigging",
    start: buildFixture(
      "linkage rig fixture",
      "document:rig-motion:linkage:start",
      linkageParts(),
    ),
    end: buildFixture(
      "linkage rig fixture",
      "document:rig-motion:linkage:start",
      linkageRigParts(),
      [],
      1,
    ),
  },
  {
    id: RIG_MOTION_FIXTURE_IDS.walk,
    kind: "motion",
    start: buildFixture(
      "biped motion fixture",
      "document:rig-motion:walk:start",
      bipedRigParts(),
    ),
    end: buildFixture(
      "biped motion fixture",
      "document:rig-motion:walk:start",
      bipedRigParts(),
      [walkClip()],
      1,
    ),
  },
  {
    id: RIG_MOTION_FIXTURE_IDS.run,
    kind: "motion",
    start: buildFixture(
      "biped motion fixture",
      "document:rig-motion:run:start",
      bipedRigParts(),
    ),
    end: buildFixture(
      "biped motion fixture",
      "document:rig-motion:run:start",
      bipedRigParts(),
      [runClip()],
      1,
    ),
  },
  {
    id: RIG_MOTION_FIXTURE_IDS.jump,
    kind: "motion",
    start: buildFixture(
      "biped motion fixture",
      "document:rig-motion:jump:start",
      bipedRigParts(),
    ),
    end: buildFixture(
      "biped motion fixture",
      "document:rig-motion:jump:start",
      bipedRigParts(),
      [jumpClip()],
      1,
    ),
  },
  {
    id: RIG_MOTION_FIXTURE_IDS.idle,
    kind: "motion",
    start: buildFixture(
      "biped motion fixture",
      "document:rig-motion:idle:start",
      bipedRigParts(),
    ),
    end: buildFixture(
      "biped motion fixture",
      "document:rig-motion:idle:start",
      bipedRigParts(),
      [idleClip()],
      1,
    ),
  },
  {
    id: RIG_MOTION_FIXTURE_IDS.fly,
    kind: "motion",
    start: buildFixture(
      "wings motion fixture",
      "document:rig-motion:fly:start",
      wingsRigParts(),
    ),
    end: buildFixture(
      "wings motion fixture",
      "document:rig-motion:fly:start",
      wingsRigParts(),
      [flyClip()],
      1,
    ),
  },
  {
    id: RIG_MOTION_FIXTURE_IDS.mechanical,
    kind: "motion",
    start: buildFixture(
      "linkage motion fixture",
      "document:rig-motion:mechanical:start",
      linkageRigParts(),
    ),
    end: buildFixture(
      "linkage motion fixture",
      "document:rig-motion:mechanical:start",
      linkageRigParts(),
      [mechanicalClip()],
      1,
    ),
  },
]);

/** Looks up one fixed rig/motion evaluation fixture by id. */
export function rigMotionFixtureById(id: string): RigMotionFixture | undefined {
  return RIG_MOTION_FIXTURES.find((fixture) => fixture.id === id);
}
