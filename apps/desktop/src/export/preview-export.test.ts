import { describe, expect, it } from "vitest";
import {
  MemoryImageStorage,
  captureRevisionSnapshot,
  type AtomicWriteResult,
  type ImageStoragePort,
} from "@voxel-maker/storage";
import { MemoryProjectStorage } from "@voxel-maker/storage";
import {
  createDesktopComposition,
  type FilePicker,
  type PickedPath,
} from "../composition.js";
import { createScriptedPrompts } from "../test-prompts.js";
import { createMemoryRecentProjects } from "../recent-projects.js";
import { previewImagePaths, suggestedPreviewName } from "./preview-export.js";

/**
 * Standard preview export workflow (plan S8.5/S15.2, ticket #25): export
 * through the real composition seam (session, prompt service, scoped
 * image storage, picker). Tests cover the four standard-view files,
 * overwrite confirmation, safe cancellation between views, structured
 * errors, and the guarantee that exporting never mutates document
 * semantics, the canonical hash, or dirty state.
 */

const PNG_SIGNATURE = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
);

function makePicker(
  savePath?: string | ((suggested: string) => string | undefined),
): FilePicker & { readonly imagePickCalls: number } {
  let imagePickCalls = 0;
  // A cancel (undefined) propagates; a pick maps to { token, path } where
  // the token IS the plain path (test shells have no native handle layer).
  const pickSave = (suggested: string): PickedPath | undefined => {
    const picked =
      typeof savePath === "function"
        ? savePath(suggested)
        : (savePath ?? suggested);
    return picked === undefined ? undefined : { token: picked, path: picked };
  };
  const base = {
    pickOpenPath: () => Promise.resolve(undefined),
    pickSavePath: (suggested: string) => Promise.resolve(pickSave(suggested)),
    pickSaveImagePaths: (suggested: string) => {
      imagePickCalls += 1;
      const picked = pickSave(suggested);
      return Promise.resolve(
        picked === undefined
          ? undefined
          : previewImagePaths(picked.path).map((path) => ({
              token: path,
              path,
            })),
      );
    },
  };
  return {
    ...base,
    get imagePickCalls() {
      return imagePickCalls;
    },
  };
}

/** Image storage whose writes can be gated (deterministic cancellation). */
class GatedImageStorage implements ImageStoragePort {
  readonly #inner = new MemoryImageStorage();
  #gate: Promise<void> | undefined;
  #release: (() => void) | undefined;
  #writeStarted: ((path: string) => void) | undefined;

  gateNextWrite(): void {
    this.#gate = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  releaseGate(): void {
    this.#release?.();
    this.#release = undefined;
    this.#gate = undefined;
  }

  onWriteStarted(listener: (path: string) => void): void {
    this.#writeStarted = listener;
  }

  async writeImageAtomic(
    path: string,
    bytes: Uint8Array,
  ): Promise<AtomicWriteResult> {
    this.#writeStarted?.(path);
    await this.#gate;
    return this.#inner.writeImageAtomic(path, bytes);
  }

  async exists(path: string): Promise<boolean> {
    return this.#inner.exists(path);
  }

  files(): ReadonlyMap<string, Uint8Array> {
    return this.#inner.files();
  }
}

function createComposition(options: {
  readonly imageStorage?: ImageStoragePort;
  readonly savePath?: string | ((suggested: string) => string | undefined);
  readonly prompts?: boolean | readonly boolean[];
}) {
  return createDesktopComposition({
    storage: new MemoryProjectStorage(),
    imageStorage: options.imageStorage ?? new MemoryImageStorage(),
    picker: makePicker(options.savePath),
    prompts: createScriptedPrompts(options.prompts ?? true),
    recent: createMemoryRecentProjects(),
  });
}

describe("previewImagePaths and suggestedPreviewName", () => {
  it("derives the four standard-view names from a base path", () => {
    expect(previewImagePaths("/tmp/out.png")).toEqual([
      "/tmp/out-perspective.png",
      "/tmp/out-front.png",
      "/tmp/out-side.png",
      "/tmp/out-top.png",
    ]);
    // A base without a .png extension is kept as-is.
    expect(previewImagePaths("/tmp/out")).toEqual([
      "/tmp/out-perspective.png",
      "/tmp/out-front.png",
      "/tmp/out-side.png",
      "/tmp/out-top.png",
    ]);
  });

  it("suggests a safe destination name from the document title", () => {
    expect(suggestedPreviewName("My Asset")).toBe("My-Asset.png");
    expect(suggestedPreviewName("a/b:c")).toBe("a-b-c.png");
    expect(suggestedPreviewName(undefined)).toBe("untitled.png");
  });
});

describe("createPreviewExportService (through the composition)", () => {
  it("rejects an export when no document is open", async () => {
    const composition = createComposition({});
    const result = await composition.previewExport.exportPreviews();
    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBe("SESSION_NOT_OPEN");
    expect(result?.paths).toEqual([]);
  });

  it("exports four standard preview images with valid PNG bytes", async () => {
    const storage = new MemoryImageStorage();
    const composition = createComposition({
      imageStorage: storage,
      savePath: "/tmp/out.png",
    });
    await composition.fileService.newProject();
    const result = await composition.previewExport.exportPreviews({ size: 32 });
    expect(result?.ok).toBe(true);
    expect(result?.cancelled).toBe(false);
    expect(result?.paths).toEqual([
      "/tmp/out-perspective.png",
      "/tmp/out-front.png",
      "/tmp/out-side.png",
      "/tmp/out-top.png",
    ]);
    const files = storage.files();
    expect(files.size).toBe(4);
    for (const path of result?.paths ?? []) {
      const bytes = files.get(path);
      expect(bytes).toBeDefined();
      expect([...(bytes as Uint8Array).subarray(0, 8)]).toEqual([
        ...PNG_SIGNATURE,
      ]);
    }
    expect(composition.previewExport.status.state).toBe("completed");
  });

  it("aborts the whole run when the user declines an overwrite", async () => {
    const storage = new MemoryImageStorage();
    await storage.writeImageAtomic(
      "/tmp/out-front.png",
      Uint8Array.of(1, 2, 3),
    );
    const composition = createComposition({
      imageStorage: storage,
      savePath: "/tmp/out.png",
      prompts: false,
    });
    await composition.fileService.newProject();
    const result = await composition.previewExport.exportPreviews({ size: 32 });
    expect(result).toBeUndefined();
    expect(storage.files().size).toBe(1);
    expect(composition.previewExport.status.state).toBe("idle");
  });

  it("proceeds when the user accepts the overwrite", async () => {
    const storage = new MemoryImageStorage();
    await storage.writeImageAtomic(
      "/tmp/out-front.png",
      Uint8Array.of(1, 2, 3),
    );
    const composition = createComposition({
      imageStorage: storage,
      savePath: "/tmp/out.png",
      prompts: true,
    });
    await composition.fileService.newProject();
    const result = await composition.previewExport.exportPreviews({ size: 32 });
    expect(result?.ok).toBe(true);
    expect(storage.files().size).toBe(4);
  });

  it("cancels safely between views, keeping the completed images", async () => {
    const storage = new GatedImageStorage();
    const composition = createComposition({
      imageStorage: storage,
      savePath: "/tmp/out.png",
    });
    await composition.fileService.newProject();
    const started: string[] = [];
    storage.onWriteStarted((path) => {
      started.push(path);
    });
    storage.gateNextWrite();
    const run = composition.previewExport.exportPreviews({ size: 32 });
    // Wait until the first write is in flight, then cancel and release.
    while (started.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    composition.previewExport.cancel();
    storage.releaseGate();
    const result = await run;
    expect(result?.ok).toBe(true);
    expect(result?.cancelled).toBe(true);
    expect(result?.paths).toEqual(["/tmp/out-perspective.png"]);
    expect(composition.previewExport.status.state).toBe("cancelled");
  });

  it("never mutates revision, canonical hash, or dirty state", async () => {
    const composition = createComposition({ savePath: "/tmp/out.png" });
    await composition.fileService.newProject();
    const store = composition.session.current?.store;
    expect(store).toBeDefined();
    const before = captureRevisionSnapshot(store as never);
    await composition.previewExport.exportPreviews({ size: 32 });
    const after = captureRevisionSnapshot(store as never);
    expect(after.revision).toBe(before.revision);
    expect(after.semanticHash).toBe(before.semanticHash);
    expect(composition.fileService.status.dirty).toBe(false);
  });

  it("rejects an invalid requested size before any dialog or write", async () => {
    let picked = false;
    const composition = createComposition({
      savePath: (suggested) => {
        picked = true;
        return suggested;
      },
    });
    await composition.fileService.newProject();
    const result = await composition.previewExport.exportPreviews({
      size: 5000,
    });
    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBe("PREVIEW_DIMENSION_LIMIT");
    expect(picked).toBe(false);
    expect(composition.previewExport.status.state).toBe("idle");
  });

  it("returns undefined when the user cancels the save picker", async () => {
    const composition = createComposition({ savePath: () => undefined });
    await composition.fileService.newProject();
    const result = await composition.previewExport.exportPreviews({ size: 32 });
    expect(result).toBeUndefined();
  });

  it("uses the PNG-filtered save picker for preview exports", async () => {
    const picker = makePicker("/tmp/out.png");
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      imageStorage: new MemoryImageStorage(),
      picker,
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    await composition.fileService.newProject();
    const result = await composition.previewExport.exportPreviews({ size: 32 });
    expect(result?.ok).toBe(true);
    expect(picker.imagePickCalls).toBe(1);
  });

  it("surfaces a structured error when the overwrite preflight fails", async () => {
    const failing = {
      exists() {
        return Promise.reject(new Error("disk unavailable"));
      },
      writeImageAtomic() {
        return Promise.resolve({
          tempPath: "",
          backupCreated: false,
          directorySyncSucceeded: true,
        } as AtomicWriteResult);
      },
    } satisfies ImageStoragePort;
    const composition = createComposition({
      imageStorage: failing,
      savePath: "/tmp/out.png",
    });
    await composition.fileService.newProject();
    const result = await composition.previewExport.exportPreviews({ size: 32 });
    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBe("PREVIEW_IO_FAILED");
    expect(result?.paths).toEqual([]);
  });
});
