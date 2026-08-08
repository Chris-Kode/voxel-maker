export {
  canonicalDocumentHash,
  canonicalDocumentJson,
  canonicalSemanticBytes,
} from "./canonical.js";
export { canonicalColor, isCanonicalColor, type Color } from "./color.js";
export { sha256Hex } from "./sha256.js";
export {
  cloneDocument,
  createDocument,
  type CreateDocumentInput,
} from "./create.js";
export {
  createMigrationChain,
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  DOCUMENT_MIGRATION_CHAIN,
  type AppliedMigrationStep,
  type DocumentMigrationChain,
  type DocumentMigrationStep,
  type MigrationResult,
} from "./migration.js";
export { DEFAULT_DOCUMENT_LIMITS, type DocumentLimits } from "./limits.js";
export { parseDocument } from "./parse.js";
export type * from "./types.js";
export {
  validateDocument,
  validateDocumentStructure,
  validateReferences,
  type DocumentIssue,
} from "./validate.js";
