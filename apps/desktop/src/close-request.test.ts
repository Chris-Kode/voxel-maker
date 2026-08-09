import { describe, expect, it, vi } from "vitest";
import { handleCloseRequest } from "./close-request.js";
import type { FileService, FileServiceStatus } from "./file-service.js";

function fakeStatus(dirty: boolean): FileServiceStatus {
  return {
    path: "p.vxl",
    documentId: "document:x" as never,
    revision: 1,
    title: "x",
    nodeCount: 1,
    dirty,
    saving: false,
    autosaving: false,
    lastSaveStale: false,
    degraded: false,
    progress: undefined,
  };
}

function fakeFileService(status: FileServiceStatus): {
  service: FileService;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const service = {
    status,
    closeProject: close,
    newProject: vi.fn(),
    openProject: vi.fn(),
    openLoadedProject: vi.fn(),
    saveProject: vi.fn(),
    saveProjectAs: vi.fn(),
    cancelSave: vi.fn(),
    recentProjects: vi.fn(),
    openRecentProject: vi.fn(),
    forgetRecentProject: vi.fn(),
    subscribe: vi.fn(),
    dispose: vi.fn(),
  } as unknown as FileService;
  return { service, close };
}

describe("window close request", () => {
  it("closes immediately when the project is clean", async () => {
    const { service, close } = fakeFileService(fakeStatus(false));
    const destroy = vi.fn(async () => {});
    const outcome = await handleCloseRequest(service, destroy);
    expect(outcome).toBe("closed");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("prompts a dirty project and destroys the window only on confirmation", async () => {
    const { service, close } = fakeFileService(fakeStatus(true));
    close.mockResolvedValueOnce({
      ok: true,
      documentId: "document:x" as never,
      revision: 1,
    });
    const destroy = vi.fn(async () => {});
    const outcome = await handleCloseRequest(service, destroy);
    expect(outcome).toBe("closed");
    expect(close).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps the window open when the user declines the discard prompt", async () => {
    const { service, close } = fakeFileService(fakeStatus(true));
    close.mockResolvedValueOnce(undefined);
    const destroy = vi.fn(async () => {});
    const outcome = await handleCloseRequest(service, destroy);
    expect(outcome).toBe("cancelled");
    expect(destroy).not.toHaveBeenCalled();
  });
});
