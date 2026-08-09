/**
 * Public entry point for the editor package: runtime-only editor workflows
 * that construct commands. Ticket #15 ships the runtime interaction store;
 * ticket #17 adds the tool contract and the pencil/erase stroke tools;
 * ticket #18 adds node/voxel/region selection, the select tool, the
 * paint/eyedropper tools, and the box/sphere/cylinder shape tools.
 */
export {
  createEditorStore,
  firstMaterialId,
  snapshotEditorStore,
  type EditorNotice,
  type EditorStore,
  type EditorStoreSnapshot,
} from "./runtime.js";
export {
  createStrokeTool,
  type StrokeTool,
  type StrokeToolOptions,
} from "./stroke-tool.js";
export {
  createSelectTool,
  type SelectTool,
  type SelectToolOptions,
} from "./select-tool.js";
export {
  createEyedropperTool,
  type EyedropperTool,
  type EyedropperToolOptions,
} from "./eyedropper-tool.js";
export {
  createShapeTool,
  type ShapeParams,
  type ShapeTool,
  type ShapeToolKind,
  type ShapeToolOptions,
} from "./shape-tool.js";
export {
  buildCreateChildCommand,
  buildDeleteCommand,
  buildRenameCommand,
  buildReparentCommand,
  defaultChildName,
  deleteFeedback,
  isAncestor,
  reparentFeedback,
  type DeleteFeedback,
  type ReparentFeedback,
  type ReparentRejectReason,
} from "./hierarchy.js";
export {
  DEFAULT_ROTATE_SNAP,
  DEFAULT_SCALE_SNAP,
  DEFAULT_TRANSLATE_SNAP,
  createTransformTool,
  transformTargets,
  type CameraRay,
  type GestureHost,
  type GizmoAxis,
  type GizmoHandle,
  type TransformTargets,
  type TransformTool,
  type TransformToolHost,
  type TransformToolMode,
  type TransformSpace,
} from "./transform-tool.js";
export {
  addSelectionEntry,
  applySelectionIntent,
  pruneSelection,
  selectionContains,
  selectionKey,
  selectionWorldBounds,
  spanRegion,
  toggleSelectionEntry,
  volumeLocalWorldBounds,
  type SelectionWorldBounds,
} from "./selection.js";
export {
  type EditorToolId,
  type RegionDraft,
  type SelectionEntry,
  type SelectionMode,
  type Tool,
  type ToolActionResult,
  type ToolDraft,
  type ToolHost,
  type ToolModifiers,
  type ToolPick,
} from "./types.js";
