import {
  animationId,
  componentId,
  documentId,
  keyframeId,
  materialId,
  nodeId,
  trackId,
  volumeId,
} from "@voxel-maker/shared";
import { createDocument } from "./create.js";
import type { VoxelDocument } from "./types.js";

const HALF = Math.SQRT1_2;
const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

/** Static house hierarchy: root, walls, roof, and door with voxel volumes. */
export function createHouseFixture(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:house:0001"),
    metadata: { title: "house", kind: "fixture" },
    rootNodeId: nodeId("node:house:root"),
    nodes: [
      {
        nodeId: nodeId("node:house:root"),
        name: "House",
        parentId: null,
        children: [
          nodeId("node:house:walls"),
          nodeId("node:house:roof"),
          nodeId("node:house:door"),
        ],
        transform: identity,
        components: [],
      },
      {
        nodeId: nodeId("node:house:walls"),
        name: "Walls",
        parentId: nodeId("node:house:root"),
        children: [],
        transform: identity,
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:house:walls"),
          },
        ],
      },
      {
        nodeId: nodeId("node:house:roof"),
        name: "Roof",
        parentId: nodeId("node:house:root"),
        children: [],
        transform: {
          translation: [0, 8, 0],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:house:roof"),
          },
        ],
      },
      {
        nodeId: nodeId("node:house:door"),
        name: "Door",
        parentId: nodeId("node:house:root"),
        children: [],
        transform: {
          translation: [4, 0, 0],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:house:door"),
          },
        ],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "wall",
        color: "#c8b89a",
        opacity: 1,
        roughness: 0.8,
        metallic: 0,
        emissive: 0,
      },
      {
        materialId: materialId(2),
        name: "roof",
        color: "#8a5a3a",
        opacity: 1,
        roughness: 0.6,
        metallic: 0.1,
        emissive: 0,
      },
      {
        materialId: materialId(3),
        name: "door",
        color: "#5a3a2a",
        opacity: 1,
        roughness: 0.4,
        metallic: 0.2,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: volumeId("volume:house:walls"),
        name: "Walls voxels",
        bounds: { min: [-4, 0, -4], max: [4, 8, 4] },
      },
      {
        volumeId: volumeId("volume:house:roof"),
        name: "Roof voxels",
        bounds: { min: [-4, 8, -4], max: [4, 11, 4] },
      },
      {
        volumeId: volumeId("volume:house:door"),
        name: "Door voxels",
        bounds: { min: [3, 0, 4], max: [5, 6, 5] },
      },
    ],
  });
}

/** Vehicle with pivoted wheels, joints, rotation constraints, and a spin clip. */
export function createVehicleFixture(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:vehicle:0001"),
    rootNodeId: nodeId("node:vehicle:root"),
    nodes: [
      {
        nodeId: nodeId("node:vehicle:root"),
        name: "Vehicle",
        parentId: null,
        children: [
          nodeId("node:vehicle:chassis"),
          nodeId("node:vehicle:wheel-fl"),
          nodeId("node:vehicle:wheel-fr"),
          nodeId("node:vehicle:wheel-rl"),
          nodeId("node:vehicle:wheel-rr"),
        ],
        transform: identity,
        components: [],
      },
      {
        nodeId: nodeId("node:vehicle:chassis"),
        name: "Chassis",
        parentId: nodeId("node:vehicle:root"),
        children: [],
        transform: identity,
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:vehicle:chassis"),
          },
        ],
      },
      {
        nodeId: nodeId("node:vehicle:wheel-fl"),
        name: "Front left wheel",
        parentId: nodeId("node:vehicle:root"),
        children: [],
        transform: {
          translation: [-3, 1, 3],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:vehicle:wheel"),
          },
          { kind: "pivot", schemaVersion: 1, pivot: [0, 1, 0] },
          { kind: "joint", schemaVersion: 1 },
          {
            kind: "constraint",
            schemaVersion: 1,
            constraints: [
              {
                componentId: componentId("component:vehicle:wheel-fl-limit"),
                type: "rotation-limits",
                limits: { min: [-0.5, 0, -Math.PI], max: [0.5, 0, Math.PI] },
              },
            ],
          },
        ],
      },
      {
        nodeId: nodeId("node:vehicle:wheel-fr"),
        name: "Front right wheel",
        parentId: nodeId("node:vehicle:root"),
        children: [],
        transform: {
          translation: [3, 1, 3],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:vehicle:wheel"),
          },
          { kind: "pivot", schemaVersion: 1, pivot: [0, 1, 0] },
          { kind: "joint", schemaVersion: 1 },
          {
            kind: "constraint",
            schemaVersion: 1,
            constraints: [
              {
                componentId: componentId("component:vehicle:wheel-fr-limit"),
                type: "rotation-limits",
                limits: { min: [-0.5, 0, -Math.PI], max: [0.5, 0, Math.PI] },
              },
            ],
          },
        ],
      },
      {
        nodeId: nodeId("node:vehicle:wheel-rl"),
        name: "Rear left wheel",
        parentId: nodeId("node:vehicle:root"),
        children: [],
        transform: {
          translation: [-3, 1, -3],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:vehicle:wheel"),
          },
          { kind: "pivot", schemaVersion: 1, pivot: [0, 1, 0] },
          { kind: "joint", schemaVersion: 1 },
        ],
      },
      {
        nodeId: nodeId("node:vehicle:wheel-rr"),
        name: "Rear right wheel",
        parentId: nodeId("node:vehicle:root"),
        children: [],
        transform: {
          translation: [3, 1, -3],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:vehicle:wheel"),
          },
          { kind: "pivot", schemaVersion: 1, pivot: [0, 1, 0] },
          { kind: "joint", schemaVersion: 1 },
        ],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "body",
        color: "#334455",
        opacity: 1,
        roughness: 0.3,
        metallic: 0.7,
        emissive: 0,
      },
      {
        materialId: materialId(2),
        name: "tire",
        color: "#222222",
        opacity: 1,
        roughness: 0.9,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: volumeId("volume:vehicle:chassis"),
        bounds: { min: [-4, 0, -4], max: [4, 2, 4] },
      },
      {
        volumeId: volumeId("volume:vehicle:wheel"),
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    ],
    animations: [
      {
        animationId: animationId("animation:vehicle:spin"),
        name: "Wheel spin",
        duration: 1,
        loop: "loop",
        tracks: [
          {
            trackId: trackId("track:vehicle:spin-fl"),
            targetNodeId: nodeId("node:vehicle:wheel-fl"),
            interpolation: "linear",
            keyframes: [
              {
                keyframeId: keyframeId("keyframe:vehicle:spin-fl-0"),
                time: 0,
                property: { channel: "rotation", value: [0, 0, 0, 1] },
              },
              {
                keyframeId: keyframeId("keyframe:vehicle:spin-fl-1"),
                time: 1,
                property: { channel: "rotation", value: [HALF, 0, 0, HALF] },
              },
            ],
          },
          {
            trackId: trackId("track:vehicle:spin-fr"),
            targetNodeId: nodeId("node:vehicle:wheel-fr"),
            interpolation: "linear",
            keyframes: [
              {
                keyframeId: keyframeId("keyframe:vehicle:spin-fr-0"),
                time: 0,
                property: { channel: "rotation", value: [0, 0, 0, 1] },
              },
              {
                keyframeId: keyframeId("keyframe:vehicle:spin-fr-1"),
                time: 1,
                property: { channel: "rotation", value: [HALF, 0, 0, HALF] },
              },
            ],
          },
          {
            trackId: trackId("track:vehicle:spin-rl"),
            targetNodeId: nodeId("node:vehicle:wheel-rl"),
            interpolation: "linear",
            keyframes: [
              {
                keyframeId: keyframeId("keyframe:vehicle:spin-rl-0"),
                time: 0,
                property: { channel: "rotation", value: [0, 0, 0, 1] },
              },
              {
                keyframeId: keyframeId("keyframe:vehicle:spin-rl-1"),
                time: 1,
                property: { channel: "rotation", value: [HALF, 0, 0, HALF] },
              },
            ],
          },
          {
            trackId: trackId("track:vehicle:spin-rr"),
            targetNodeId: nodeId("node:vehicle:wheel-rr"),
            interpolation: "linear",
            keyframes: [
              {
                keyframeId: keyframeId("keyframe:vehicle:spin-rr-0"),
                time: 0,
                property: { channel: "rotation", value: [0, 0, 0, 1] },
              },
              {
                keyframeId: keyframeId("keyframe:vehicle:spin-rr-1"),
                time: 1,
                property: { channel: "rotation", value: [HALF, 0, 0, HALF] },
              },
            ],
          },
        ],
      },
    ],
  });
}

/** Abstract multi-level hierarchy with inert metadata and mixed animation. */
export function createAbstractFixture(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:abstract:0001"),
    metadata: {
      title: "abstract",
      tags: ["procedural", "demo"],
      nested: { level: 2, enabled: true, ratio: 0.25 },
    },
    rootNodeId: nodeId("node:abstract:root"),
    nodes: [
      {
        nodeId: nodeId("node:abstract:root"),
        parentId: null,
        children: [nodeId("node:abstract:a"), nodeId("node:abstract:b")],
        transform: identity,
        components: [],
        metadata: { role: "origin" },
      },
      {
        nodeId: nodeId("node:abstract:a"),
        parentId: nodeId("node:abstract:root"),
        children: [nodeId("node:abstract:a1")],
        transform: {
          translation: [-2, 0, 0],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:abstract:left"),
          },
        ],
      },
      {
        nodeId: nodeId("node:abstract:a1"),
        parentId: nodeId("node:abstract:a"),
        children: [],
        transform: {
          translation: [0, 3, 0],
          pivot: [0, 0, 0],
          rotation: [HALF, 0, 0, HALF],
          scale: [2, 1, 1],
        },
        components: [{ kind: "pivot", schemaVersion: 1, pivot: [0, -1, 0] }],
      },
      {
        nodeId: nodeId("node:abstract:b"),
        parentId: nodeId("node:abstract:root"),
        children: [],
        transform: {
          translation: [2, 0, 0],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [{ kind: "joint", schemaVersion: 1 }],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "primary",
        color: "#ff8800",
        opacity: 0.75,
        roughness: 0.5,
        metallic: 0,
        emissive: 0.1,
      },
      {
        materialId: materialId(2),
        name: "secondary",
        color: "#0088ff",
        opacity: 1,
        roughness: 0.2,
        metallic: 0.8,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: volumeId("volume:abstract:left"),
        name: "Left volume",
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
      {
        volumeId: volumeId("volume:abstract:right"),
        bounds: { min: [-2, 0, -2], max: [0, 4, 0] },
      },
    ],
    animations: [
      {
        animationId: animationId("animation:abstract:motion"),
        duration: 2,
        loop: "once",
        tracks: [
          {
            trackId: trackId("track:abstract:rise"),
            targetNodeId: nodeId("node:abstract:a1"),
            interpolation: "smoothstep",
            keyframes: [
              {
                keyframeId: keyframeId("keyframe:abstract:rise-0"),
                time: 0,
                property: { channel: "translation", value: [0, 3, 0] },
              },
              {
                keyframeId: keyframeId("keyframe:abstract:rise-1"),
                time: 2,
                property: { channel: "translation", value: [0, 5, 0] },
              },
            ],
          },
          {
            trackId: trackId("track:abstract:grow"),
            targetNodeId: nodeId("node:abstract:b"),
            interpolation: "step",
            keyframes: [
              {
                keyframeId: keyframeId("keyframe:abstract:grow-0"),
                time: 0,
                property: { channel: "scale", value: [1, 1, 1] },
              },
              {
                keyframeId: keyframeId("keyframe:abstract:grow-1"),
                time: 1.5,
                property: { channel: "scale", value: [1.5, 2, 1] },
              },
            ],
          },
        ],
      },
    ],
  });
}
