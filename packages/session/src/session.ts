import {
  WorkspaceError,
  createListenerSet,
  type DocumentId,
  type JsonValue,
  type VolumeId,
} from "@voxel-maker/shared";
import { type DocumentStoreRead } from "@voxel-maker/document";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import {
  CommandBus,
  CommandRegistry,
  type CommandBusHooks,
} from "@voxel-maker/commands";
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
 * write surface. Every installed record is `Object.freeze`d before it is
 * returned or exposed as `current`, so lifecycle identity cannot be
 * rewritten by consumers (issue #56).
 */
export interface DocumentSessionState {
  readonly documentId: DocumentId;
  /**
   * Live store revision (issue #55): always equals `store.revision`,
   * including after commit, undo, and redo transactions, so sequential
   * commands can use it as the next expected base.
   */
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
 * just ended. Every published event is `Object.freeze`d before listeners
 * run (issue #56), so a buggy subscriber cannot rewrite the event for later
 * subscribers; listeners must treat events as read-only and never throw.
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
  /**
   * Optional post-commit hooks applied to every fresh bus (plan S5.9). The
   * composition root uses this seam to wire the ordered recovery journal:
   * each installed document owns one journal writer, and the hooks fire
   * exactly once per committed transaction with the exact record the
   * journal needs. Hook exceptions are isolated by the bus.
   */
  readonly busHooks?: CommandBusHooks;
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
  readonly #busHooks: CommandBusHooks;
  readonly #listeners = createListenerSet<DocumentLifecycleEvent>();
  #current: DocumentSessionState | undefined;

  constructor(options: CreateDocumentSessionOptions) {
    this.#registerCommands = options.registerCommands;
    this.#busHooks = options.busHooks ?? {};
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
    const state = this.#buildState(input);
    this.#current = state;
    this.#emit({
      kind: "document-opened",
      documentId: state.documentId,
      revision: state.revision,
      store: state.store,
      bus: state.bus,
      source: state.source,
    });
    return state;
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
    // Build the replacement fully before revoking anything: a failed
    // validation must leave the current document and its bus untouched
    // (ticket #54). Only after the new aggregate is constructed is the
    // previous bus revoked, so retained stale buses reject every call and
    // their shared onCommitted hook can never leak into the new document's
    // recovery journal.
    const state = this.#buildState(input);
    previous.bus.revoke();
    this.#current = state;
    this.#emit({
      kind: "document-replaced",
      previousDocumentId: previous.documentId,
      documentId: state.documentId,
      revision: state.revision,
      store: state.store,
      bus: state.bus,
      source: state.source,
    });
    return state;
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
    // Revoke before dropping the binding: code retaining the bus must fail
    // immediately, and no hook can forward a stale record anywhere.
    current.bus.revoke();
    this.#current = undefined;
    this.#emit({
      kind: "document-closed",
      documentId: current.documentId,
      revision: current.revision,
      source: current.source,
    });
  }

  subscribe(listener: (event: DocumentLifecycleEvent) => void): () => void {
    return this.#listeners.add(listener);
  }

  dispose(): void {
    this.#current?.bus.revoke();
    this.#listeners.clear();
    this.#current = undefined;
  }

  /** Constructs a fully validated state without touching the current binding. */
  #buildState(input: SessionInstallInput): DocumentSessionState {
    // createDocumentStore fully validates the aggregate and installs copied
    // chunk seeds under every hard limit, so an invalid load can never
    // produce a partial session (plan S5.3/S5.15).
    const { store, writeCapability } = createDocumentStoreHandle({
      document: input.document,
      ...(input.volumes === undefined ? {} : { volumes: input.volumes }),
    });
    const registry = new CommandRegistry();
    for (const register of this.#registerCommands) register(registry);
    // Defense in depth (ticket #54): every install receives the shared
    // composition hooks wrapped in an epoch guard, so even a bus that
    // somehow bypassed revocation can never forward a record while another
    // (or no) document is current. The closure reads `state` only after
    // it is initialized below, and hooks can only fire after installation.
    const bus = new CommandBus(store, registry, writeCapability, undefined, {
      onCommitted: (record) => {
        if (this.#current !== state) return;
        this.#busHooks.onCommitted?.(record);
      },
    });
    const source = input.source ?? "system";
    const state: DocumentSessionState = Object.freeze({
      documentId: store.getDocument().documentId,
      // Live view over the installed store: a copied number would freeze the
      // install revision forever while commits advance the store (issue #55).
      get revision(): number {
        return store.revision;
      },
      store,
      bus,
      registry,
      source,
    });
    return state;
  }

  #emit(event: DocumentLifecycleEvent): void {
    // Every lifecycle event is frozen before publishing so one subscriber
    // can never rewrite what later subscribers observe (issue #56).
    this.#listeners.emit(Object.freeze(event));
  }
}

function sessionError(
  family: "conflict" | "validation",
  code: string,
  message: string,
  context?: Readonly<Record<string, JsonValue>>,
): WorkspaceError {
  return new WorkspaceError({
    family,
    code,
    message,
    ...(context === undefined ? {} : { context }),
  });
}

/** Creates the lifecycle coordinator with feature registrars injected. */
export function createDocumentSession(
  options: CreateDocumentSessionOptions,
): DocumentSession {
  return new DocumentSessionImpl(options);
}
