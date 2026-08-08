import {
  WorkspaceError,
  type DocumentId,
  type VolumeId,
} from "@voxel-maker/shared";
import {
  createDocumentStore,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import { CommandBus, CommandRegistry } from "@voxel-maker/commands";
import type { VoxelDocument } from "@voxel-maker/model";
import type { VoxelChunkSeed } from "@voxel-maker/voxel";

/**
 * Lifecycle coordinator for the authoritative open document (plan S5.15,
 * ADR-0002, ticket #15). `DocumentSession` is the only owner that may
 * replace the complete validated aggregate: `open`, `replace`, and `close`
 * install a fresh document store plus a fresh bounded command bus, so
 * history, redo, and every projection rebind through the emitted lifecycle
 * events instead of masquerading as ordinary commits.
 *
 * The session never parses or reads files; callers hand it a fully
 * validated document and chunk seeds (the composition root loads bytes and
 * runs format codecs before calling in). Arbitrary UI or file code never
 * receives the session's write capability: the private capability minted
 * per store is held only by the command bus the session constructs.
 */

/** Who requested a lifecycle transition (plan S5.15 sources). */
export type SessionSource = "system" | "import" | "recovery";

/** A feature registrar applied to every fresh command registry. */
export type CommandRegistryRegistrar = (registry: CommandRegistry) => void;

/** A fully validated install request (document + optional chunk seeds). */
export interface SessionInstallInput {
  readonly document: VoxelDocument;
  /** Validated load path (plan S5.3/S5.15): seeds are copied and checked. */
  readonly volumes?: ReadonlyMap<VolumeId, readonly VoxelChunkSeed[]>;
  readonly source?: SessionSource;
}

/**
 * One installed session: the authoritative read surface plus the fresh
 * command bus that owns the private write capability. The bus starts with
 * empty undo/redo history (ADR-0003); projections never receive the store's
 * write surface.
 */
export interface DocumentSessionState {
  readonly documentId: DocumentId;
  readonly revision: number;
  readonly store: DocumentStoreRead;
  readonly bus: CommandBus;
  readonly registry: CommandRegistry;
  readonly source: SessionSource;
}

/**
 * Frozen lifecycle events. `document-opened` and `document-replaced` carry
 * the new authoritative state so projections (renderer, editor, file
 * service) can dispose and rebind; `document-closed` carries the state that
 * just ended. Listeners must treat events as read-only and never throw.
 */
export type DocumentLifecycleEvent =
  | {
      readonly kind: "document-opened";
      readonly documentId: DocumentId;
      readonly revision: number;
      readonly store: DocumentStoreRead;
      readonly bus: CommandBus;
      readonly source: SessionSource;
    }
  | {
      readonly kind: "document-replaced";
      readonly previousDocumentId: DocumentId;
      readonly documentId: DocumentId;
      readonly revision: number;
      readonly store: DocumentStoreRead;
      readonly bus: CommandBus;
      readonly source: SessionSource;
    }
  | {
      readonly kind: "document-closed";
      readonly documentId: DocumentId;
      readonly revision: number;
      readonly source: SessionSource;
    };

/** Options for `createDocumentSession`. */
export interface CreateDocumentSessionOptions {
  /**
   * Feature registrars applied to every fresh registry (plan S4.15). The
   * composition root supplies the concrete feature packages; the session
   * stays generic so later feature sets (rigging, animation, agent) plug in
   * without changing the coordinator.
   */
  readonly registerCommands: readonly CommandRegistryRegistrar[];
}

/** The narrow lifecycle surface handed to the composition root. */
export interface DocumentSession {
  /** The installed session state, or undefined when no document is open. */
  readonly current: DocumentSessionState | undefined;
  /**
   * Installs a validated document as the first open document. Rejects with
   * a `SESSION_ALREADY_OPEN` conflict when a document is already open.
   */
  open(input: SessionInstallInput): DocumentSessionState;
  /**
   * Replaces the open document with a fully validated new aggregate,
   * disposing the previous store/bus binding. Rejects with
   * `SESSION_NOT_OPEN` when no document is open.
   */
  replace(input: SessionInstallInput): DocumentSessionState;
  /** Closes the open document; no-op rejection when none is open. */
  close(): void;
  /** Subscribes to lifecycle events; returns an unsubscribe function. */
  subscribe(listener: (event: DocumentLifecycleEvent) => void): () => void;
  /** Unsubscribes all listeners and drops the current binding. */
  dispose(): void;
}

class DocumentSessionImpl implements DocumentSession {
  readonly #registerCommands: readonly CommandRegistryRegistrar[];
  readonly #listeners = new Set<(event: DocumentLifecycleEvent) => void>();
  #current: DocumentSessionState | undefined;

  constructor(options: CreateDocumentSessionOptions) {
    this.#registerCommands = options.registerCommands;
  }

  get current(): DocumentSessionState | undefined {
    return this.#current;
  }

  open(input: SessionInstallInput): DocumentSessionState {
    if (this.#current !== undefined) {
      throw sessionError(
        "conflict",
        "SESSION_ALREADY_OPEN",
        "A document is already open; use replace to install a new aggregate",
        { documentId: this.#current.documentId },
      );
    }
    return this.#install(input, "document-opened", undefined);
  }

  replace(input: SessionInstallInput): DocumentSessionState {
    const previous = this.#current;
    if (previous === undefined) {
      throw sessionError(
        "conflict",
        "SESSION_NOT_OPEN",
        "No document is open; use open to install the first aggregate",
      );
    }
    return this.#install(input, "document-replaced", previous.documentId);
  }

  close(): void {
    const current = this.#current;
    if (current === undefined) {
      throw sessionError(
        "conflict",
        "SESSION_NOT_OPEN",
        "No document is open to close",
      );
    }
    this.#current = undefined;
    this.#emit({
      kind: "document-closed",
      documentId: current.documentId,
      revision: current.revision,
      source: current.source,
    });
  }

  subscribe(listener: (event: DocumentLifecycleEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    this.#listeners.clear();
    this.#current = undefined;
  }

  #install(
    input: SessionInstallInput,
    kind: "document-opened" | "document-replaced",
    previousDocumentId: DocumentId | undefined,
  ): DocumentSessionState {
    // createDocumentStore fully validates the aggregate and installs copied
    // chunk seeds under every hard limit, so an invalid load can never
    // produce a partial session (plan S5.3/S5.15).
    const { store, writeCapability } = createDocumentStore({
      document: input.document,
      ...(input.volumes === undefined ? {} : { volumes: input.volumes }),
    });
    const registry = new CommandRegistry();
    for (const register of this.#registerCommands) register(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const source = input.source ?? "system";
    const state: DocumentSessionState = {
      documentId: store.getDocument().documentId,
      revision: store.revision,
      store,
      bus,
      registry,
      source,
    };
    this.#current = state;
    this.#emit(
      kind === "document-opened"
        ? {
            kind: "document-opened",
            documentId: state.documentId,
            revision: state.revision,
            store,
            bus,
            source,
          }
        : {
            kind: "document-replaced",
            previousDocumentId: previousDocumentId as DocumentId,
            documentId: state.documentId,
            revision: state.revision,
            store,
            bus,
            source,
          },
    );
    return state;
  }

  #emit(event: DocumentLifecycleEvent): void {
    // Best-effort notifications: a throwing listener must never break a
    // lifecycle transition.
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Swallow projection listener failures; the transition already
        // committed.
      }
    }
  }
}

function sessionError(
  family: "conflict" | "validation",
  code: string,
  message: string,
  context?: Readonly<Record<string, unknown>>,
): WorkspaceError {
  return new WorkspaceError({
    family,
    code,
    message,
    ...(context === undefined ? {} : { context: context as never }),
  });
}

/** Creates the lifecycle coordinator with feature registrars injected. */
export function createDocumentSession(
  options: CreateDocumentSessionOptions,
): DocumentSession {
  return new DocumentSessionImpl(options);
}
