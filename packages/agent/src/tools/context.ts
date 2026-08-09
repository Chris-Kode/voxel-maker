import type { DocumentStoreRead } from "@voxel-maker/document";
import type { ResponseBudget } from "../budget.js";
import type { InspectionLimits } from "../limits.js";
import type { EditorContextPort } from "../port.js";

/**
 * Read-only context handed to every inspection tool handler (plan S11.2).
 * Tools receive the authoritative read surface plus the injected editor
 * context port; they never receive a write capability, a command bus, or
 * the renderer, so inspection cannot mutate or project anything.
 */
export interface ToolContext {
  readonly store: DocumentStoreRead;
  readonly limits: InspectionLimits;
  readonly port: EditorContextPort | undefined;
  readonly budget: ResponseBudget;
}
