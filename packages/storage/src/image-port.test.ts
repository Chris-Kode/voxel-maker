import { describe, expect, it } from "vitest";
import { MemoryImageStorage } from "./image-port.js";

/**
 * Image storage port tests (plan S8.5/S15.2, ticket #25): the memory
 * adapter is the browser/test seam behind preview-image exports. It
 * stores byte copies, reports existence for overwrite confirmation, and
 * never creates backups (images are reproducible from the document).
 */

describe("MemoryImageStorage", () => {
  it("stores byte copies and reports existence", async () => {
    const storage = new MemoryImageStorage();
    expect(await storage.exists("out/perspective.png")).toBe(false);
    const bytes = Uint8Array.of(1, 2, 3);
    const result = await storage.writeImageAtomic("out/perspective.png", bytes);
    expect(result.backupCreated).toBe(false);
    expect(result.directorySyncSucceeded).toBe(true);
    expect(await storage.exists("out/perspective.png")).toBe(true);
    const stored = storage.files().get("out/perspective.png");
    expect(stored).toBeDefined();
    expect([...(stored as Uint8Array)]).toEqual([1, 2, 3]);
    // Mutating the caller's buffer never affects the stored copy.
    bytes[0] = 99;
    expect([
      ...(storage.files().get("out/perspective.png") as Uint8Array),
    ]).toEqual([1, 2, 3]);
  });

  it("overwrites atomically without backups", async () => {
    const storage = new MemoryImageStorage();
    await storage.writeImageAtomic("a.png", Uint8Array.of(1));
    await storage.writeImageAtomic("a.png", Uint8Array.of(2));
    expect([...(storage.files().get("a.png") as Uint8Array)]).toEqual([2]);
    expect(storage.files().size).toBe(1);
  });
});
