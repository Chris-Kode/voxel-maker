import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  IO_ERROR_CODES,
  storageIoError,
  type AtomicWriteResult,
} from "@voxel-maker/storage";
import { INPUT_FILE_LIMIT_EXCEEDED } from "@voxel-maker/shared";
import { KEYCHAIN_SERVICE, secret } from "@voxel-maker/agent";
import { TauriCredentialStore, TauriProjectStorage } from "./tauri.js";

const invokeMock = vi.mocked(invoke);

const V0 = new TextEncoder().encode("version-zero");

/**
 * Issue #95: keychain IPC must never carry a service argument — the Rust
 * side pins `voxel-maker:provider` and allowlists provider accounts, so a
 * forged service can never be addressed from the webview. These tests pin
 * the wire contract of the desktop adapter.
 */
describe("TauriCredentialStore keychain IPC scope (issue #95)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("pins the documented keychain service in both layers", () => {
    // The Rust side pins the same literal; this assertion keeps the
    // TypeScript constant from drifting away from the documented value.
    expect(KEYCHAIN_SERVICE).toBe("voxel-maker:provider");
  });

  it.each(["save", "get", "delete"] as const)(
    "refuses a forged service before invoking (%s)",
    async (operation) => {
      const store = new TauriCredentialStore();
      const forged = "com.apple.Safari";

      if (operation === "save") {
        await expect(
          store.save(forged, "openai", secret("sk-test")),
        ).rejects.toThrow(/pinned to voxel-maker:provider/);
      } else if (operation === "get") {
        await expect(store.get(forged, "openai")).rejects.toThrow(
          /pinned to voxel-maker:provider/,
        );
      } else {
        await expect(store.delete(forged, "openai")).rejects.toThrow(
          /pinned to voxel-maker:provider/,
        );
      }
      expect(invokeMock).not.toHaveBeenCalled();
    },
  );

  it("save sends only the allowlisted account and value", async () => {
    const store = new TauriCredentialStore();
    await store.save(KEYCHAIN_SERVICE, "openai", secret("sk-test"));

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("credential_save", {
      account: "openai",
      value: "sk-test",
    });
    expect(invokeMock.mock.calls[0]?.[1]).not.toHaveProperty("service");
  });

  it("get sends only the allowlisted account", async () => {
    invokeMock.mockResolvedValueOnce("sk-test");
    const store = new TauriCredentialStore();

    const value = await store.get(KEYCHAIN_SERVICE, "openai");

    expect(value?.reveal()).toBe("sk-test");
    expect(invokeMock).toHaveBeenCalledWith("credential_get", {
      account: "openai",
    });
    expect(invokeMock.mock.calls[0]?.[1]).not.toHaveProperty("service");
  });

  it("delete sends only the allowlisted account", async () => {
    const store = new TauriCredentialStore();

    await store.delete(KEYCHAIN_SERVICE, "openai");

    expect(invokeMock).toHaveBeenCalledWith("credential_delete", {
      account: "openai",
    });
    expect(invokeMock.mock.calls[0]?.[1]).not.toHaveProperty("service");
  });
});

describe("TauriProjectStorage atomic-save IPC (issue #120)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("sends the bytes and no cancel token when no signal is given", async () => {
    const storage = new TauriProjectStorage();
    invokeMock.mockResolvedValueOnce({
      tempPath: ".project.vxl.abc123.tmp",
      backupCreated: true,
      backupPath: "project.vxl.bak",
      directorySyncSucceeded: true,
    });

    const result = await storage.writeProjectAtomic("tok", V0);

    expect(result.backupCreated).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, payload] = invokeMock.mock.calls[0] ?? [];
    expect(command).toBe("write_project_bytes_atomic");
    expect(payload).toMatchObject({ handle: "tok", bytes: V0 });
    expect(payload).not.toHaveProperty("cancelToken");
    expect(payload).not.toHaveProperty("faults");
  });

  it("an already-aborted signal rejects IO_WRITE_INTERRUPTED before invoking", async () => {
    const storage = new TauriProjectStorage();
    const controller = new AbortController();
    controller.abort();

    await expect(
      storage.writeProjectAtomic("tok", V0, { signal: controller.signal }),
    ).rejects.toMatchObject({
      family: "io",
      code: IO_ERROR_CODES.writeInterrupted,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("an abort during flight invokes cancel_project_write with the write token", async () => {
    const storage = new TauriProjectStorage();
    let resolveWrite: ((value: AtomicWriteResult) => void) | undefined;
    invokeMock.mockImplementationOnce((command: string) => {
      if (command === "write_project_bytes_atomic") {
        return new Promise<AtomicWriteResult>((resolve) => {
          resolveWrite = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    const controller = new AbortController();

    const pending = storage.writeProjectAtomic("tok", V0, {
      signal: controller.signal,
    });
    controller.abort();

    await vi.waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command]) => command === "cancel_project_write",
        ),
      ).toBe(true);
    });
    const cancelCall = invokeMock.mock.calls.find(
      ([command]) => command === "cancel_project_write",
    );
    const writeCall = invokeMock.mock.calls.find(
      ([command]) => command === "write_project_bytes_atomic",
    );
    const cancelPayload = cancelCall?.[1] as
      | Record<string, unknown>
      | undefined;
    const writePayload = writeCall?.[1] as Record<string, unknown> | undefined;
    expect(typeof cancelPayload?.token).toBe("string");
    expect(cancelPayload?.token).toBe(writePayload?.cancelToken);

    // The native write committed before the abort landed: the save
    // completes normally (an abort that races the replace never undoes a
    // durable write).
    const committed: AtomicWriteResult = {
      tempPath: ".project.vxl.abc123.tmp",
      backupCreated: true,
      backupPath: "project.vxl.bak",
      directorySyncSucceeded: true,
    };
    resolveWrite?.(committed);
    await expect(pending).resolves.toEqual(committed);
  });

  it("forwards canonical true phase faults and drops custom errors", async () => {
    const storage = new TauriProjectStorage();
    invokeMock.mockResolvedValueOnce({
      tempPath: ".p.tmp",
      backupCreated: false,
      directorySyncSucceeded: true,
    });

    await storage.writeProjectAtomic("tok", V0, {
      faults: {
        failAt: {
          "create-temp": true,
          "write-temp": true,
          backup: storageIoError("IO_DISK_FULL", "custom", {}),
        },
      },
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "write_project_bytes_atomic",
      expect.objectContaining({
        handle: "tok",
        faults: { failAt: ["create-temp", "write-temp"] },
      }),
    );
  });

  it("maps native CODE: message rejections to the shared error contract", async () => {
    const storage = new TauriProjectStorage();
    invokeMock.mockRejectedValueOnce(
      "IO_DISK_FULL: Cannot write the temporary project file (phase write-temp): No space left on device (os error 28)",
    );

    await expect(storage.writeProjectAtomic("tok", V0)).rejects.toMatchObject({
      family: "io",
      code: IO_ERROR_CODES.diskFull,
      context: { path: "tok" },
    });

    invokeMock.mockRejectedValueOnce(
      "IO_NOT_FOUND: Cannot read the file: No such file or directory (os error 2)",
    );
    await expect(storage.readProject("tok")).rejects.toMatchObject({
      family: "io",
      code: IO_ERROR_CODES.notFound,
    });

    invokeMock.mockRejectedValueOnce(
      "INPUT_FILE_LIMIT_EXCEEDED: input file exceeds the 512 MiB hard limit (536870913 bytes): /some/path.vxl",
    );
    await expect(storage.readProject("tok")).rejects.toMatchObject({
      family: "limit",
      code: INPUT_FILE_LIMIT_EXCEEDED,
    });

    invokeMock.mockRejectedValueOnce("unrecognized handle token");
    await expect(storage.readProject("tok")).rejects.toThrow(
      "unrecognized handle token",
    );
  });

  it("maps readBackup and readJournal null results to undefined", async () => {
    const storage = new TauriProjectStorage();
    invokeMock.mockResolvedValueOnce(null);
    invokeMock.mockResolvedValueOnce(null);

    await expect(storage.readBackup("tok")).resolves.toBeUndefined();
    await expect(storage.readJournal("tok")).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("read_backup_bytes", {
      handle: "tok",
    });
    expect(invokeMock).toHaveBeenCalledWith("read_journal_bytes", {
      handle: "tok",
    });
  });
});
