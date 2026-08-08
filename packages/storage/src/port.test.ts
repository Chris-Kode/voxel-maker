import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  backupPathFor,
  defaultPhaseError,
  IO_ERROR_CODES,
  storageIoError,
  tempPathFor,
} from "./port.js";
import { MemoryProjectStorage } from "./memory-storage.js";
import { journalPathFor } from "./port.js";
import {
  recoveryJournalPortConformanceCases,
  storagePortConformanceCases,
} from "./conformance.js";

describe("storage port helpers", () => {
  it("derives adjacent backup and same-directory temporary paths", () => {
    expect(backupPathFor("dir/project.vxl")).toBe("dir/project.vxl.bak");
    expect(tempPathFor("dir/project.vxl", "abc")).toBe(
      "dir/.project.vxl.abc.tmp",
    );
    expect(tempPathFor("project.vxl", "abc")).toBe(".project.vxl.abc.tmp");
    expect(tempPathFor("a\\b\\c.vxl", "7")).toBe("a\\b\\.c.vxl.7.tmp");
  });

  it("produces canonical io errors with stable codes and phases", () => {
    const error = defaultPhaseError("replace", "project.vxl");
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.family).toBe("io");
    expect(error.code).toBe(IO_ERROR_CODES.renameFailed);
    expect(error.context).toEqual({ path: "project.vxl", phase: "replace" });
    expect(error.toJSON().cause).toBeUndefined();
  });

  it("redacts native causes while keeping the stable code", () => {
    const error = storageIoError(
      IO_ERROR_CODES.diskFull,
      "disk full",
      { path: "p.vxl" },
      Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }),
    );
    expect(error.toJSON().cause).toEqual({ type: "Error" });
    expect(error.context).toEqual({ path: "p.vxl" });
  });
});

describe("MemoryProjectStorage conformance", () => {
  for (const testCase of storagePortConformanceCases((options) => {
    const storage = new MemoryProjectStorage(options?.faults);
    return {
      port: storage,
      projectPath: "project.vxl",
      tempPaths: () => Promise.resolve(storage.temporaryPaths()),
    };
  })) {
    it(testCase.name, async () => {
      await testCase.run();
    });
  }
});

describe("MemoryProjectStorage recovery journal conformance", () => {
  for (const testCase of recoveryJournalPortConformanceCases((options) => {
    const storage = new MemoryProjectStorage(options?.faults);
    return {
      port: storage,
      projectPath: "project.vxl",
      tempPaths: () => Promise.resolve(storage.temporaryPaths()),
    };
  })) {
    it(testCase.name, async () => {
      await testCase.run();
    });
  }
});

describe("MemoryProjectStorage journal specifics", () => {
  it("stores the journal beside the project path", async () => {
    const storage = new MemoryProjectStorage();
    await storage.appendJournal("dir/project.vxl", new Uint8Array([1, 2]));
    const bytes = storage.files().get(journalPathFor("dir/project.vxl"));
    expect(bytes).toEqual(new Uint8Array([1, 2]));
  });
});

describe("MemoryProjectStorage specifics", () => {
  it("keeps per-call fault plans separate from adapter defaults", async () => {
    const storage = new MemoryProjectStorage();
    await storage.writeProjectAtomic("p.vxl", new TextEncoder().encode("v1"));
    await expect(
      storage.writeProjectAtomic("p.vxl", new TextEncoder().encode("v2"), {
        faults: { failAt: { replace: true } },
      }),
    ).rejects.toMatchObject({ code: IO_ERROR_CODES.renameFailed });
    expect(new TextDecoder().decode(await storage.readProject("p.vxl"))).toBe(
      "v1",
    );
    // The adapter default stays clean for the next write.
    await storage.writeProjectAtomic("p.vxl", new TextEncoder().encode("v2"));
    expect(new TextDecoder().decode(await storage.readProject("p.vxl"))).toBe(
      "v2",
    );
  });

  it("copies bytes on write so caller buffers stay isolated", async () => {
    const storage = new MemoryProjectStorage();
    const bytes = new TextEncoder().encode("v1");
    await storage.writeProjectAtomic("p.vxl", bytes);
    bytes[0] = 88;
    const stored = await storage.readProject("p.vxl");
    expect(stored[0]).toBe(118);
  });
});
