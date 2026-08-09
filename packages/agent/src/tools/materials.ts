import type { JsonValue } from "@voxel-maker/shared";
import { outputSchema, type ToolContract } from "../contract.js";
import {
  clampName,
  paginated,
  resolvePage,
  resolvePageSize,
} from "./helpers.js";
import type { ToolContext } from "./context.js";

/**
 * Material inspection (plan S11.3): paginated material records with the
 * exact caller-supplied material ids and canonical colors.
 */

/** `inspectMaterials` contract. */
export const INSPECT_MATERIALS_CONTRACT: ToolContract = {
  name: "inspectMaterials",
  version: 1,
  capability: "inspect",
  description:
    "Paginated list of material records: id, name, canonical color, opacity, roughness, metallic, emissive. Id 0 is reserved for empty voxels and never appears.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      page: {
        type: "integer",
        minimum: 1,
        description: "1-based page (default 1)",
      },
      pageSize: {
        type: "integer",
        minimum: 1,
        description: "Items per page (default 50, max 500)",
      },
    },
  },
  outputSchema: outputSchema(
    "inspectMaterials",
    {
      total: { type: "integer", minimum: 0 },
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1 },
      hasMore: { type: "boolean" },
      materials: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            materialId: { type: "integer", minimum: 1 },
            name: { type: "string" },
            color: { type: "string" },
            opacity: { type: "number" },
            roughness: { type: "number" },
            metallic: { type: "number" },
            emissive: { type: "number" },
          },
          required: [
            "materialId",
            "name",
            "color",
            "opacity",
            "roughness",
            "metallic",
            "emissive",
          ],
        },
      },
    },
    ["total", "page", "pageSize", "hasMore", "materials"],
  ),
};

export function inspectMaterials(
  ctx: ToolContext,
  args: JsonValue,
): Readonly<Record<string, JsonValue>> {
  const { store, limits, budget } = ctx;
  const record = args as Readonly<Record<string, JsonValue>>;
  const pageSize = resolvePageSize(record, limits);
  const page = resolvePage(record);
  const materials = Object.values(store.getDocument().materials).sort(
    (a, b) => a.materialId - b.materialId,
  );
  return paginated(
    budget,
    materials,
    page,
    pageSize,
    (material) => ({
      materialId: material.materialId,
      name: clampName(material.name, limits),
      color: material.color,
      opacity: material.opacity,
      roughness: material.roughness,
      metallic: material.metallic,
      emissive: material.emissive,
    }),
    "materials",
  );
}
