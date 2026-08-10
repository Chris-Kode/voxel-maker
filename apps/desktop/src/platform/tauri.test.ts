import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { KEYCHAIN_SERVICE, secret } from "@voxel-maker/agent";
import { TauriCredentialStore } from "./tauri.js";

const invokeMock = vi.mocked(invoke);

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
