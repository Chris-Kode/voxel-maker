/**
 * Non-public integration surface (issue #91): the authoritative store's
 * mutation authority. The command bus, the lifecycle coordinator, the
 * headless and desktop composition roots, and monorepo fixture
 * infrastructure import this subpath to stage and commit validated
 * transactions; ordinary consumers receive only the read surface from the
 * public `@voxel-maker/document` entrypoint. The root entrypoint never
 * exports this surface; ESLint and the package/app boundary check keep it
 * off the public contract.
 */
export {
  createDocumentStoreHandle,
  type DocumentStore,
  type DocumentStoreHandle,
  type StagedState,
} from "./store.js";
