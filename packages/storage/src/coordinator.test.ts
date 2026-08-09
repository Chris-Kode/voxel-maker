import { describe, expect, it } from "vitest";
import { canonicalAssetSemanticHash } from "@voxel-maker/document";
import { readVxlProject } from "@voxel-maker/formats";
import {
  createSaveCoordinator,
  type SaveCoordinatorEvent,
} from "./coordinator.js";
import { createVxlProjectEncoder } from "./encoder.js";
import { MemoryProjectStorage } from "./memory-storage.js";
import {
  commitVoxel,
  CountingPort,
  createStore,
  FailingPort,
  GatedPort,
  removeVoxel,
  VOLUME,
} from "./test-helpers.js";

function createCoordinator(
  port: MemoryProjectStorage | GatedPort = new MemoryProjectStorage(),
) {
  const { store, writeCapability } = createStore();
  const coordinator = createSaveCoordinator({
    store,
    port,
    encoder: createVxlProjectEncoder(),
  });
  return { store, writeCapability, coordinator };
}

describe("SaveCoordinator", () => {
  it("starts dirty, saves clean, and reports the durable snapshot", async () => {
    const { store, coordinator } = createCoordinator();
    expect(coordinator.isDirty()).toBe(true);
    expect(coordinator.lastDurableRevision()).toBeUndefined();
    expect(coordinator.lastDurableHash()).toBeUndefined();

    const outcome = await coordinator.save("project.vxl");
    expect(outcome.status).toBe("saved");
    expect(outcome.revision).toBe(0);
    expect(outcome.semanticHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(coordinator.isDirty()).toBe(false);
    expect(coordinator.lastDurableRevision()).toBe(0);
    expect(coordinator.lastDurableHash()).toBe(outcome.semanticHash);
    expect(store.revision).toBe(0);
  });

  it("marks the project dirty after a save when edits proceed, and only the next save clears it", async () => {
    const { store, writeCapability, coordinator } = createCoordinator();
    await coordinator.save("project.vxl");
    expect(coordinator.isDirty()).toBe(false);
    commitVoxel(store, writeCapability, [0, 0, 0], 1);
    expect(coordinator.isDirty()).toBe(true);
    expect(coordinator.lastDurableRevision()).toBe(0);
    // The document revision is part of the ADR-0004 semantic identity, so
    // restoring the saved voxel content still leaves a new revision: the
    // live hash no longer equals the captured H_R and the project stays
    // dirty until the next completed save.
    removeVoxel(store, writeCapability, [0, 0, 0]);
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(0);
    expect(coordinator.isDirty()).toBe(true);
    const next = await coordinator.save("project.vxl");
    expect(next.revision).toBe(2);
    expect(coordinator.isDirty()).toBe(false);
  });

  it("retains the immutable revision snapshot while later edits proceed and never clears dirty state on stale completion", async () => {
    const memory = new MemoryProjectStorage();
    const gated = new GatedPort(memory);
    const { store, writeCapability, coordinator } = createCoordinator(gated);
    const before = coordinator.capture();
    expect(before.revision).toBe(0);

    gated.gate();
    const savePromise = coordinator.save("project.vxl");
    await gated.entered();

    // Later edits proceed while the writer still holds the rev-0 snapshot.
    commitVoxel(store, writeCapability, [0, 0, 0], 1);
    expect(store.revision).toBe(1);
    expect(coordinator.isDirty()).toBe(true);

    // The retained snapshot is unchanged by the edit: its own document and
    // volume views still describe the captured state, and the live store
    // has moved to a different revision and hash.
    expect(before.revision).toBe(0);
    expect(before.document.revision).toBe(0);
    expect(canonicalAssetSemanticHash(before.document, before.volumes)).toBe(
      before.semanticHash,
    );
    expect(coordinator.capture().revision).toBe(1);
    expect(coordinator.capture().semanticHash).not.toBe(before.semanticHash);

    gated.release();
    const outcome = await savePromise;
    expect(outcome.status).toBe("saved");
    expect(outcome.revision).toBe(0);

    // Stale completion recorded rev 0 as durable but could NOT clear dirty.
    expect(coordinator.lastDurableRevision()).toBe(0);
    expect(coordinator.isDirty()).toBe(true);

    // The written bytes are exactly the captured snapshot, not the live state.
    const written = await memory.readProject("project.vxl");
    const loaded = readVxlProject(written);
    expect(loaded.semanticHash).toBe(before.semanticHash);
    expect(loaded.document.revision).toBe(0);
    expect(loaded.volumes.get(VOLUME)?.chunks).toHaveLength(0);
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(1);
  });

  it("keeps the last-known-good durable state when a save fails", async () => {
    const memory = new FailingPort();
    const { store, writeCapability, coordinator } = createCoordinator(memory);
    await coordinator.save("project.vxl");
    expect(coordinator.isDirty()).toBe(false);

    commitVoxel(store, writeCapability, [0, 0, 0], 1);
    expect(coordinator.isDirty()).toBe(true);

    // Storage fails after being healthy: the save rejects, the durable
    // snapshot and the destination stay at the last-known-good state, and
    // the project remains dirty.
    memory.failNextWrite = true;
    await expect(coordinator.save("project.vxl")).rejects.toMatchObject({
      code: "IO_DISK_FULL",
    });
    expect(coordinator.lastDurableRevision()).toBe(0);
    expect(coordinator.isDirty()).toBe(true);
    const loaded = readVxlProject(await memory.readProject("project.vxl"));
    expect(loaded.document.revision).toBe(0);
    expect(loaded.volumes.get(VOLUME)?.chunks).toHaveLength(0);

    // The next save succeeds and clears the dirty state.
    const outcome = await coordinator.save("project.vxl");
    expect(outcome.status).toBe("saved");
    expect(outcome.revision).toBe(1);
    expect(coordinator.isDirty()).toBe(false);
  });

  it("interrupts the in-flight write on cancel and leaves no destination", async () => {
    const memory = new MemoryProjectStorage();
    const gated = new GatedPort(memory);
    const { coordinator } = createCoordinator(gated);
    gated.gate();
    const savePromise = coordinator.save("project.vxl");
    await gated.entered();
    coordinator.cancel();
    gated.release();
    await expect(savePromise).rejects.toMatchObject({
      code: "IO_WRITE_INTERRUPTED",
    });
    expect(coordinator.lastDurableRevision()).toBeUndefined();
    expect(await memory.exists("project.vxl")).toBe(false);
    expect(await memory.exists("project.vxl.bak")).toBe(false);

    // The coordinator remains usable after cancellation.
    const outcome = await coordinator.save("project.vxl");
    expect(outcome.status).toBe("saved");
    expect(coordinator.isDirty()).toBe(false);
  });

  it("never overlaps writes and completes queued saves in order", async () => {
    const memory = new MemoryProjectStorage();
    const counting = new CountingPort(memory);
    const { store, writeCapability, coordinator } = createCoordinator(counting);

    counting.gate();
    const first = coordinator.save("project.vxl");
    await counting.entered();
    commitVoxel(store, writeCapability, [0, 0, 0], 1);
    const second = coordinator.save("project.vxl");
    commitVoxel(store, writeCapability, [0, 0, 0], 2);
    const third = coordinator.save("project.vxl");
    expect(counting.writeCount).toBe(1);

    counting.release();
    const outcomes = await Promise.all([first, second, third]);
    expect(outcomes.map((outcome) => outcome.revision)).toEqual([0, 1, 2]);
    expect(counting.maxActive).toBe(1);
    expect(counting.writeCount).toBe(3);
    expect(coordinator.lastDurableRevision()).toBe(2);
    expect(coordinator.isDirty()).toBe(false);

    const loaded = readVxlProject(await memory.readProject("project.vxl"));
    expect(loaded.document.revision).toBe(2);
    expect(loaded.volumes.get(VOLUME)?.chunks).toHaveLength(1);
  });

  it("skips the write when the requested state is already durable at the same path", async () => {
    const memory = new MemoryProjectStorage();
    const gated = new GatedPort(memory);
    const { coordinator } = createCoordinator(gated);
    const first = await coordinator.save("project.vxl");
    expect(first.status).toBe("saved");
    expect(gated.writeCount).toBe(1);

    const second = await coordinator.save("project.vxl");
    expect(second.status).toBe("unchanged");
    expect(gated.writeCount).toBe(1);

    // A different path is a real write (Save As seam).
    const third = await coordinator.save("other.vxl");
    expect(third.status).toBe("saved");
    expect(gated.writeCount).toBe(2);
    expect(coordinator.lastDurableRevision()).toBe(0);
    expect(await memory.exists("other.vxl")).toBe(true);
  });

  it("emits save and dirty events on state transitions", async () => {
    const { store, writeCapability, coordinator } = createCoordinator();
    const events: SaveCoordinatorEvent[] = [];
    coordinator.subscribe((event) => {
      events.push(event);
    });
    expect(coordinator.isDirty()).toBe(true);
    await coordinator.save("project.vxl");
    commitVoxel(store, writeCapability, [0, 0, 0], 1);
    expect(coordinator.isDirty()).toBe(true);

    const kinds = events.map((event) => event.kind);
    expect(kinds).toEqual([
      "dirty-changed",
      "save-started",
      "save-progress",
      "save-progress",
      "save-progress",
      "save-progress",
      "save-progress",
      "save-completed",
      "dirty-changed",
      "dirty-changed",
    ]);
    expect(events[1]).toMatchObject({ kind: "save-started", revision: 0 });
    // The memory adapter reports every atomic-write phase (plan S7.16).
    expect(events[2]).toMatchObject({
      kind: "save-progress",
      phase: "create-temp",
    });
    expect(events[events.length - 3]).toMatchObject({
      kind: "save-completed",
      stale: false,
    });
    expect(events[events.length - 2]).toMatchObject({
      kind: "dirty-changed",
      dirty: false,
    });
    expect(events[events.length - 1]).toMatchObject({
      kind: "dirty-changed",
      dirty: true,
    });
  });

  it("rejects empty save paths without touching the port", async () => {
    const memory = new MemoryProjectStorage();
    const gated = new GatedPort(memory);
    const { coordinator } = createCoordinator(gated);
    await expect(coordinator.save("")).rejects.toMatchObject({
      code: "IO_WRITE_FAILED",
    });
    expect(gated.writeCount).toBe(0);
  });

  it("dispose cancels the in-flight write, rejects queued requests, and makes the coordinator terminal", async () => {
    const memory = new MemoryProjectStorage();
    const gated = new GatedPort(memory);
    const { store, writeCapability, coordinator } = createCoordinator(gated);
    gated.gate();
    const first = coordinator.save("project.vxl");
    await gated.entered();
    commitVoxel(store, writeCapability, [0, 0, 0], 1);
    const second = coordinator.save("project.vxl");
    coordinator.dispose();
    gated.release();
    await expect(first).rejects.toMatchObject({
      code: "IO_WRITE_INTERRUPTED",
    });
    await expect(second).rejects.toMatchObject({
      code: "IO_WRITE_INTERRUPTED",
    });
    await expect(coordinator.save("project.vxl")).rejects.toMatchObject({
      code: "IO_WRITE_FAILED",
    });
    expect(await memory.exists("project.vxl")).toBe(false);
  });

  it("markDurable seeds a clean state for an opened project and makes same-path saves unchanged", async () => {
    const { coordinator } = createCoordinator();
    const snapshot = coordinator.capture();
    coordinator.markDurable(
      snapshot.revision,
      snapshot.semanticHash,
      "project.vxl",
    );
    expect(coordinator.isDirty()).toBe(false);
    expect(coordinator.lastDurableRevision()).toBe(snapshot.revision);

    const outcome = await coordinator.save("project.vxl");
    expect(outcome.status).toBe("unchanged");
    expect(outcome.revision).toBe(snapshot.revision);

    // Saving to a different path is a real write, and it moves the anchor.
    const saved = await coordinator.save("other.vxl");
    expect(saved.status).toBe("saved");
    expect(coordinator.lastDurableHash()).toBe(saved.semanticHash);
  });

  it("markDurable does not clear dirty state when live state moved past the anchor", () => {
    const { store, writeCapability, coordinator } = createCoordinator();
    const snapshot = coordinator.capture();
    commitVoxel(store, writeCapability, [0, 0, 0], 1);
    coordinator.markDurable(
      snapshot.revision,
      snapshot.semanticHash,
      "project.vxl",
    );
    expect(coordinator.isDirty()).toBe(true);
  });

  it("isolates listener exceptions", async () => {
    const { coordinator } = createCoordinator();
    coordinator.subscribe(() => {
      throw new Error("listener boom");
    });
    await expect(coordinator.save("project.vxl")).resolves.toMatchObject({
      status: "saved",
    });
  });
});
