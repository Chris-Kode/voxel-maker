import { useEffect, useState } from "react";
import {
  commandId,
  transactionId,
  type CommandId,
  type TransactionId,
} from "@voxel-maker/shared";
import type { Command } from "@voxel-maker/commands";
import type { DocumentStoreRead } from "@voxel-maker/document";
import type { DocumentSession } from "@voxel-maker/session";
import {
  snapshotEditorStore,
  type EditorStore,
  type EditorStoreSnapshot,
} from "@voxel-maker/editor";

/**
 * Panel plumbing (plan S7.11/S7.12, ticket #20): React hooks that
 * subscribe to the session, store, and editor, plus the deterministic id
 * sequence panels use to construct commands. Panels never encode domain
 * invariants; they render state, forward edits to the bus, and surface
 * command errors as notices.
 */

/** Live snapshot of the open document plus its store. */
export interface DocumentSnapshot {
  readonly store: DocumentStoreRead | undefined;
  readonly document: ReturnType<DocumentStoreRead["getDocument"]> | undefined;
  /** Bumped on every committed event (for useMemo-style consumers). */
  readonly revision: number;
}

function readDocument(session: DocumentSession): DocumentSnapshot {
  const store = session.current?.store;
  return {
    store,
    document: store?.getDocument(),
    revision: store?.revision ?? 0,
  };
}

/**
 * Subscribes to lifecycle and commit events of the open document. The
 * session's lifecycle events carry the fresh store, so the hook
 * re-subscribes whenever `session.current` changes.
 */
export function useDocument(session: DocumentSession): DocumentSnapshot {
  const [snapshot, setSnapshot] = useState<DocumentSnapshot>(() =>
    readDocument(session),
  );
  useEffect(() => {
    const refresh = (): void => {
      setSnapshot(readDocument(session));
    };
    let unsubscribeStore: (() => void) | undefined;
    const resubscribe = (): void => {
      unsubscribeStore?.();
      unsubscribeStore = session.current?.store.subscribe(refresh);
    };
    refresh();
    resubscribe();
    const unsubscribeSession = session.subscribe(() => {
      // Resubscribe to the store AFTER the lifecycle event updates
      // `session.current` (events fire synchronously during the
      // transition, so defer the store read to the next tick).
      queueMicrotask(() => {
        resubscribe();
      });
      refresh();
    });
    return () => {
      unsubscribeSession();
      unsubscribeStore?.();
    };
  }, [session]);
  return snapshot;
}

/** Subscribes to the runtime editor store. */
export function useEditorStore(editor: EditorStore): EditorStoreSnapshot {
  const [snapshot, setSnapshot] = useState<EditorStoreSnapshot>(() =>
    snapshotEditorStore(editor),
  );
  useEffect(
    () =>
      editor.subscribe(() => {
        setSnapshot(snapshotEditorStore(editor));
      }),
    [editor],
  );
  return snapshot;
}

/** Fresh deterministic ids for panel commands and transactions. */
export interface PanelIds {
  nextCommandId(): CommandId;
  nextTransactionId(): TransactionId;
}

/** Creates the id sequence for one panel session. */
export function createPanelIds(prefix: string): PanelIds {
  let sequence = 0;
  return {
    nextCommandId: (): CommandId => {
      sequence += 1;
      return commandId(`command:${prefix}:${String(sequence)}`);
    },
    nextTransactionId: (): TransactionId => {
      sequence += 1;
      return transactionId(`transaction:${prefix}:${String(sequence)}`);
    },
  };
}

/** One panel commit outcome. */
export type PanelCommit =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Executes one labeled transaction through the session bus; returns the
 * structured error (or undefined on success) and never partially applies.
 */
export function executeTransaction(
  session: DocumentSession,
  ids: PanelIds,
  commands: readonly Command[],
  label: string,
): PanelCommit {
  const current = session.current;
  if (current === undefined) {
    return { ok: false, message: "No document is open" };
  }
  if (commands.length === 0) return { ok: true };
  const result = current.bus.executeTransaction(commands, {
    transactionId: ids.nextTransactionId(),
    expectedRevision: current.store.revision,
    source: "ui",
    label,
  });
  return result.ok
    ? { ok: true }
    : { ok: false, message: result.error.message };
}
