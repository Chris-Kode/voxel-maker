import {
  WorkspaceError,
  documentId,
  nodeId,
  type DocumentId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { DocumentSession } from "@voxel-maker/session";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import type { VoxelChunkSeed, VoxelVolumeReadView } from "@voxel-maker/voxel";
import { readVxlProject, writeVxlProject } from "@voxel-maker/formats";
import type { ProjectStoragePort } from "@voxel-maker/storage";
import type { FilePicker } from "./composition.js";

/**
 * File service of the desktop shell (plan S6.2): open/replace/close/save
 * through the lifecycle coordinator and the injected storage port. The
 * service never mutates semantic state directly — new/open install fully
 * validated aggregates through `DocumentSession` (ADR-0002), and edits
 * flow through the session's command bus. Autosave, journals, and dirty
 * tracking arrive with the project-lifecycle ticket (#22).
 */

export interface FileServiceResult {
  readonly ok: boolean;
  readonly path?: string;
  readonly documentId?: DocumentId;
  readonly revision?: number;
  readonly error?: WorkspaceError;
}

export interface FileServiceStatus {
  readonly path: string | undefined;
  readonly documentId: DocumentId | undefined;
  readonly revision: number | undefined;
  readonly title: string | undefined;
  readonly nodeCount: number | undefined;
}

export interface FileService {
  readonly status: FileServiceStatus;
  /** Installs a fresh blank document through the lifecycle coordinator. */
  newProject(): FileServiceResult;
  /** Picks a project file and opens (or replaces) it. Cancelled -> undefined. */
  openProject(): Promise<FileServiceResult | undefined>;
  /** Opens bytes already read by the caller (tests, drag-drop, recovery). */
  openLoadedProject(name: string, bytes: Uint8Array): FileServiceResult;
  /** Picks a destination and writes the current project. Cancelled -> undefined. */
  saveProject(): Promise<FileServiceResult | undefined>;
  /** Closes the current document through the lifecycle coordinator. */
  closeProject(): FileServiceResult;
  /** Subscribes to status changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export interface FileServiceOptions {
  readonly session: DocumentSession;
  readonly storage: ProjectStoragePort;
  readonly picker: FilePicker;
}

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

export function createFileService(options: FileServiceOptions): FileService {
  const { session, storage, picker } = options;
  let path: string | undefined;
  let newCounter = 1;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Best-effort notifications never break file operations.
      }
    }
  };

  const install = (name: string, bytes: Uint8Array): FileServiceResult => {
    try {
      const loaded = readVxlProject(bytes);
      const seeds = new Map<VolumeId, readonly VoxelChunkSeed[]>();
      for (const volume of loaded.volumes.values()) {
        seeds.set(volume.volumeId, volume.chunks);
      }
      const state =
        session.current === undefined
          ? session.open({
              document: loaded.document,
              volumes: seeds,
              source: "import",
            })
          : session.replace({
              document: loaded.document,
              volumes: seeds,
              source: "import",
            });
      path = name;
      notify();
      return {
        ok: true,
        path: name,
        documentId: state.documentId,
        revision: state.revision,
      };
    } catch (error) {
      return {
        ok: false,
        path: name,
        error: toWorkspaceError(error),
      };
    }
  };

  const status: FileServiceStatus = {
    get path() {
      return path;
    },
    get documentId() {
      return session.current?.documentId;
    },
    get revision() {
      return session.current?.revision;
    },
    get title() {
      return session.current?.store.getDocument().metadata.title as
        | string
        | undefined;
    },
    get nodeCount() {
      return session.current === undefined
        ? undefined
        : Object.keys(session.current.store.getDocument().nodes).length;
    },
  };

  return {
    get status() {
      return status;
    },
    newProject() {
      const document = createDocument({
        documentId: documentId(
          `document:new:${String(newCounter).padStart(4, "0")}`,
        ),
        metadata: { title: "Untitled" },
        rootNodeId: nodeId("node:root"),
        nodes: [
          {
            nodeId: nodeId("node:root"),
            name: "Root",
            parentId: null,
            children: [],
            transform: IDENTITY,
            components: [],
          },
        ],
        materials: [],
        volumes: [],
      });
      newCounter += 1;
      const state =
        session.current === undefined
          ? session.open({ document })
          : session.replace({ document });
      path = undefined;
      notify();
      return {
        ok: true,
        documentId: state.documentId,
        revision: state.revision,
      };
    },
    async openProject() {
      const picked = await picker.pickOpenPath();
      if (picked === undefined) return undefined;
      try {
        const bytes = await storage.readProject(picked);
        return install(picked, bytes);
      } catch (error) {
        return { ok: false, path: picked, error: toWorkspaceError(error) };
      }
    },
    openLoadedProject(name, bytes) {
      return install(name, bytes);
    },
    async saveProject() {
      const current = session.current;
      if (current === undefined) {
        return {
          ok: false,
          error: new WorkspaceError({
            family: "conflict",
            code: "SESSION_NOT_OPEN",
            message: "No document is open to save",
          }),
        };
      }
      const suggested = suggestedProjectName(current.store.getDocument());
      const picked = await picker.pickSavePath(suggested);
      if (picked === undefined) return undefined;
      try {
        const volumes = new Map<VolumeId, VoxelVolumeReadView>();
        for (const volumeIdText of Object.keys(
          current.store.getDocument().volumes,
        )) {
          const volumeId = volumeIdText as VolumeId;
          const readView = current.store.getVolume(volumeId);
          if (readView !== undefined) volumes.set(volumeId, readView);
        }
        const bytes = writeVxlProject({
          document: current.store.getDocument(),
          volumes,
        });
        await storage.writeProjectAtomic(picked, bytes);
        path = picked;
        notify();
        return {
          ok: true,
          path: picked,
          documentId: current.documentId,
          revision: current.revision,
        };
      } catch (error) {
        return { ok: false, path: picked, error: toWorkspaceError(error) };
      }
    },
    closeProject() {
      if (session.current === undefined) {
        return {
          ok: false,
          error: new WorkspaceError({
            family: "conflict",
            code: "SESSION_NOT_OPEN",
            message: "No document is open to close",
          }),
        };
      }
      session.close();
      path = undefined;
      notify();
      return { ok: true };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function suggestedProjectName(document: VoxelDocument): string {
  const title = document.metadata.title;
  const base =
    typeof title === "string" && title.length > 0
      ? title.replace(/[^A-Za-z0-9._-]+/gu, "-")
      : "untitled";
  return `${base}.vxl`;
}

function toWorkspaceError(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  return new WorkspaceError({
    family: "io",
    code: "FILE_OPERATION_FAILED",
    message: error instanceof Error ? error.message : "File operation failed",
  });
}
