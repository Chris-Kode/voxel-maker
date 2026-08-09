import { describe, expect, it } from "vitest";
import { WorkspaceError, type JsonValue } from "@voxel-maker/shared";
import {
  KEYCHAIN_SERVICE,
  MemoryCredentialStore,
  Secret,
  secret,
} from "./credentials.js";
import {
  DEFAULT_CONSENT_DURATION_MS,
  DISCLOSURE_CATEGORIES,
  MemoryConsentStore,
  consentCovers,
  consentExpired,
  consentRequiredError,
  createConsent,
} from "./consent.js";
import {
  REDACTION_MARKER,
  isRedacted,
  redactDiagnostics,
  redactJson,
  redactProviderPayload,
  redactSecrets,
} from "./redact.js";

/**
 * Credential, consent, and redaction tests (plan S12.4, ticket #33 AC):
 * secrets never serialize outside explicit reveal, provider use is gated
 * by explicit consent covering the disclosure categories, and logs and
 * diagnostics redact secrets and protected content deterministically.
 */

describe("Secret values (AC: credentials in the keychain)", () => {
  it("redacts itself in every string and JSON serialization", () => {
    const value = secret("sk-super-secret-123456");
    expect(value.reveal()).toBe("sk-super-secret-123456");
    expect(value.toString()).toBe(REDACTION_MARKER);
    expect(JSON.stringify(value)).toBe(`"${REDACTION_MARKER}"`);
    expect(String(value)).toBe(REDACTION_MARKER);
  });

  it("never leaks the value through object inspection", () => {
    const value = new Secret("sk-hidden");
    const seen: string[] = [];
    for (const key of Object.keys(value)) seen.push(key);
    expect(seen).toEqual([]);
    expect(JSON.stringify({ key: value })).not.toContain("sk-hidden");
  });
});

describe("credential store (AC: keychain seam)", () => {
  it("saves, reads, lists, and deletes credentials by service+account", async () => {
    const store = new MemoryCredentialStore();
    await store.save(KEYCHAIN_SERVICE, "openai", secret("sk-live-1"));
    const read = await store.get(KEYCHAIN_SERVICE, "openai");
    expect(read?.reveal()).toBe("sk-live-1");
    expect(await store.get(KEYCHAIN_SERVICE, "missing")).toBeUndefined();
    expect(await store.list()).toEqual([
      { service: KEYCHAIN_SERVICE, account: "openai", present: true },
    ]);
    expect(await store.delete(KEYCHAIN_SERVICE, "openai")).toBe(true);
    expect(await store.delete(KEYCHAIN_SERVICE, "openai")).toBe(false);
    expect(await store.get(KEYCHAIN_SERVICE, "openai")).toBeUndefined();
  });

  it("keeps separate accounts isolated", async () => {
    const store = new MemoryCredentialStore();
    await store.save(KEYCHAIN_SERVICE, "a", secret("sk-a"));
    await store.save(KEYCHAIN_SERVICE, "b", secret("sk-b"));
    expect((await store.get(KEYCHAIN_SERVICE, "a"))?.reveal()).toBe("sk-a");
    expect((await store.get(KEYCHAIN_SERVICE, "b"))?.reveal()).toBe("sk-b");
  });
});

describe("explicit consent (AC: provider use is consented)", () => {
  const now = 1_000_000;

  it("creates a consent record covering the full disclosure set", () => {
    const consent = createConsent({
      providerId: "openai",
      model: "gpt-4o-mini",
      categories: DISCLOSURE_CATEGORIES,
      consentedAt: now,
      clock: { now: () => now },
    });
    expect(consent.providerId).toBe("openai");
    expect(consent.model).toBe("gpt-4o-mini");
    expect(consent.consentedAt).toBe(now);
    expect(consent.expiresAt).toBe(now + DEFAULT_CONSENT_DURATION_MS);
    expect(consent.consentVersion).toBe(1);
    expect(
      consentCovers(
        consent,
        { providerId: "openai", model: "gpt-4o-mini" },
        now,
      ),
    ).toBe(true);
  });

  it("rejects unknown disclosure categories and invalid expiry", () => {
    expect(() =>
      createConsent({
        providerId: "openai",
        model: "gpt-4o-mini",
        categories: [
          "user-prompt-and-run-messages",
          "full-document-upload" as never,
        ],
        consentedAt: now,
      }),
    ).toThrow(WorkspaceError);
    expect(() =>
      createConsent({
        providerId: "openai",
        model: "gpt-4o-mini",
        categories: DISCLOSURE_CATEGORIES,
        consentedAt: now,
        expiresAt: now - 1,
      }),
    ).toThrow(WorkspaceError);
  });

  it("fails closed when consent is missing, expired, or mismatched", () => {
    const consent = createConsent({
      providerId: "openai",
      model: "gpt-4o-mini",
      categories: DISCLOSURE_CATEGORIES,
      consentedAt: now,
    });
    expect(
      consentCovers(consent, { providerId: "openai", model: "gpt-4o" }, now),
    ).toBe(false);
    expect(
      consentCovers(
        consent,
        { providerId: "anthropic", model: "gpt-4o-mini" },
        now,
      ),
    ).toBe(false);
    expect(consentExpired(consent, now + DEFAULT_CONSENT_DURATION_MS + 1)).toBe(
      true,
    );
    expect(
      consentCovers(
        consent,
        { providerId: "openai", model: "gpt-4o-mini" },
        now + DEFAULT_CONSENT_DURATION_MS + 1,
      ),
    ).toBe(false);
    const error = consentRequiredError();
    expect(error.family).toBe("conflict");
    expect(error.code).toBe("CONSENT_REQUIRED");
  });

  it("requires membership of every disclosure category, not a matching count", () => {
    const now = 1_000_000;
    // A record with a duplicated category and one missing has the same
    // array length as the full set; membership must catch the gap.
    // A duplicated entry can never stand in for a missing category:
    // createConsent dedupes, and consentCovers checks membership.
    const duplicated = createConsent({
      providerId: "openai",
      model: "gpt-4o-mini",
      categories: [
        ...DISCLOSURE_CATEGORIES.slice(2),
        DISCLOSURE_CATEGORIES[0] as (typeof DISCLOSURE_CATEGORIES)[number],
        DISCLOSURE_CATEGORIES[0] as (typeof DISCLOSURE_CATEGORIES)[number],
      ],
      consentedAt: now,
    });
    expect(duplicated.categories.length).toBe(DISCLOSURE_CATEGORIES.length - 1);
    expect(
      consentCovers(
        duplicated,
        { providerId: "openai", model: "gpt-4o-mini" },
        now,
      ),
    ).toBe(false);
    // A partial record never covers a run that transmits every category.
    const subset = createConsent({
      providerId: "openai",
      model: "gpt-4o-mini",
      categories: DISCLOSURE_CATEGORIES.slice(0, 1),
      consentedAt: now,
    });
    expect(
      consentCovers(
        subset,
        { providerId: "openai", model: "gpt-4o-mini" },
        now,
      ),
    ).toBe(false);
  });

  it("stores and revokes consent records", async () => {
    const store = new MemoryConsentStore();
    const consent = createConsent({
      providerId: "openai",
      model: "gpt-4o-mini",
      categories: DISCLOSURE_CATEGORIES,
      consentedAt: now,
    });
    await store.save(consent);
    expect((await store.get("openai", "gpt-4o-mini"))?.model).toBe(
      "gpt-4o-mini",
    );
    expect(await store.list()).toHaveLength(1);
    expect(await store.delete("openai", "gpt-4o-mini")).toBe(true);
    expect(await store.get("openai", "gpt-4o-mini")).toBeUndefined();
  });
});

describe("redaction (AC: logs and diagnostics redact secrets)", () => {
  it("redacts explicit secret values everywhere they appear", () => {
    const out = redactSecrets(
      "key sk-live-1 stored; authorization sk-live-1 again",
      ["sk-live-1"],
    );
    expect(out).not.toContain("sk-live-1");
    expect(out).toContain(REDACTION_MARKER);
    expect(out.split(REDACTION_MARKER)).toHaveLength(3);
  });

  it("redacts bearer tokens, OpenAI keys, and auth assignments", () => {
    const input =
      "Authorization: Bearer abc.def-ghi_123\nkey=sk-abcdef1234567890\napi_key=12345 secret=value";
    const out = redactDiagnostics(input);
    expect(out).not.toContain("abc.def-ghi_123");
    expect(out).not.toContain("sk-abcdef1234567890");
    expect(out).not.toContain("12345");
    expect(out).not.toContain("secret=value");
    expect(isRedacted(out)).toBe(true);
  });

  it("redacts absolute paths, home directories, and URLs", () => {
    const input =
      "file at /Users/alice/projects/secret.vxl and C:\\Users\\bob\\doc and https://api.example.com/v1?key=12345";
    const out = redactDiagnostics(input);
    expect(out).not.toContain("alice");
    expect(out).not.toContain("bob");
    expect(out).not.toContain("api.example.com");
    expect(isRedacted(out)).toBe(true);
  });

  it("deep-redacts JSON trees including nested secrets", () => {
    const tree = {
      messages: [
        { role: "user", content: "my key is sk-abcdef1234567890" },
        { role: "tool", value: { secret: "s3cr3t", ok: true } },
      ],
    };
    const out = redactJson(tree, ["s3cr3t"]) as Readonly<{
      messages: readonly Readonly<{
        value: Readonly<Record<string, JsonValue>>;
      }>[];
    }>;
    expect(JSON.stringify(out)).not.toContain("sk-abcdef1234567890");
    expect(JSON.stringify(out)).not.toContain("s3cr3t");
    expect(out.messages[1]?.value.ok).toBe(true);
  });

  it("redacts provider payload fields by protected key name", () => {
    const out = redactProviderPayload({
      apiKey: "sk-x",
      nested: { authorization: "Bearer y", token: "z", count: 3 },
      messages: [{ content: "hello" }],
    }) as Readonly<{
      apiKey: JsonValue;
      nested: Readonly<Record<string, JsonValue>>;
      messages: readonly Readonly<Record<string, JsonValue>>[];
    }>;
    expect(out.apiKey).toBe(REDACTION_MARKER);
    expect(out.nested.authorization).toBe(REDACTION_MARKER);
    expect(out.nested.token).toBe(REDACTION_MARKER);
    expect(out.nested.count).toBe(3);
    expect(out.messages[0]?.content).toBe("hello");
  });
});
