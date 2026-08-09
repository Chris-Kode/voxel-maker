import type {
  PivotComponent,
  SceneNode,
  VoxelDocument,
} from "@voxel-maker/model";

/**
 * Semantic validation for rig annotations (plan S9.1, ticket #26). The
 * node hierarchy is the single authoritative parent graph: a pivot or
 * joint component annotates a node and never carries a second parent
 * relationship (the closed component union has no reference fields). This
 * module re-asserts those invariants at the rig layer with stable,
 * node-scoped findings so fixtures, tools, and AI recipes can rely on
 * them independent of document-level structural checks.
 */

/** A stable, node-scoped rig annotation finding. */
export interface RigAnnotationIssue {
  readonly code:
    | "DUPLICATE_ANNOTATION"
    | "UNREACHABLE_ANNOTATION"
    | "NON_FINITE_PIVOT";
  readonly nodeId: string;
  readonly componentKind: "pivot" | "joint";
  readonly message: string;
}

const FINITE = (value: number): boolean =>
  Number.isFinite(value) && !Object.is(value, -0);

/**
 * Validates every pivot/joint annotation in the document. Findings:
 *
 * - `DUPLICATE_ANNOTATION` — a node carries more than one pivot or joint
 *   component (singletons per node).
 * - `UNREACHABLE_ANNOTATION` — an annotated node is not reachable from
 *   the document root through `parentId` links, meaning the annotation
 *   sits outside the single transform hierarchy.
 * - `NON_FINITE_PIVOT` — a pivot annotation contains a non-finite value.
 *
 * The check is pure and returns findings; it never throws.
 */
export function validateRigAnnotations(
  document: VoxelDocument,
): readonly RigAnnotationIssue[] {
  const issues: RigAnnotationIssue[] = [];
  const reachable = new Set<string>();
  for (const node of Object.values(document.nodes)) {
    let ancestor: SceneNode | undefined = node;
    const seen = new Set<string>();
    while (ancestor !== undefined && !seen.has(ancestor.nodeId)) {
      seen.add(ancestor.nodeId);
      if (ancestor.nodeId === document.rootNodeId) {
        reachable.add(node.nodeId);
        break;
      }
      ancestor =
        ancestor.parentId === null
          ? undefined
          : document.nodes[ancestor.parentId];
    }
  }
  for (const node of Object.values(document.nodes)) {
    let pivotCount = 0;
    let jointCount = 0;
    for (const component of node.components) {
      if (component.kind === "pivot") {
        pivotCount += 1;
        if (
          !FINITE(component.pivot[0]) ||
          !FINITE(component.pivot[1]) ||
          !FINITE(component.pivot[2])
        ) {
          issues.push({
            code: "NON_FINITE_PIVOT",
            nodeId: node.nodeId,
            componentKind: "pivot",
            message: `Pivot annotation on ${node.nodeId} contains non-finite values`,
          });
        }
      }
      if (component.kind === "joint") {
        jointCount += 1;
      }
    }
    if (pivotCount > 1) {
      issues.push({
        code: "DUPLICATE_ANNOTATION",
        nodeId: node.nodeId,
        componentKind: "pivot",
        message: `Node ${node.nodeId} carries more than one pivot component`,
      });
    }
    if (jointCount > 1) {
      issues.push({
        code: "DUPLICATE_ANNOTATION",
        nodeId: node.nodeId,
        componentKind: "joint",
        message: `Node ${node.nodeId} carries more than one joint component`,
      });
    }
    if ((pivotCount > 0 || jointCount > 0) && !reachable.has(node.nodeId)) {
      issues.push({
        code: "UNREACHABLE_ANNOTATION",
        nodeId: node.nodeId,
        componentKind: jointCount > 0 ? "joint" : "pivot",
        message: `Node ${node.nodeId} carries a rig annotation but is not reachable from the document root`,
      });
    }
  }
  return issues;
}

/** True when the node carries a joint annotation (an articulation point). */
export function hasJointAnnotation(node: SceneNode): boolean {
  return node.components.some((component) => component.kind === "joint");
}

/** True when the node carries a pivot annotation. */
export function hasPivotAnnotation(node: SceneNode): boolean {
  return node.components.some((component) => component.kind === "pivot");
}

/** The node's pivot annotation value, when present. */
export function pivotAnnotation(node: SceneNode): PivotComponent | undefined {
  return node.components.find(
    (component): component is PivotComponent => component.kind === "pivot",
  );
}
