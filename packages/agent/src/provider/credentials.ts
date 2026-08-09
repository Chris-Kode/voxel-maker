import { REDACTION_MARKER } from "./redact.js";

/**
 * Credential service seam (plan S12.4, ticket #33): provider credentials
 * live in an OS keychain behind this narrow adapter. The semantic core
 * only ever sees a `Secret` that redacts itself in every string and JSON
 * serialization, so a secret can never be written to a log, transcript,
 * diagnostic, telemetry event, or document by accident. Production
 * composition (the desktop app) supplies an OS-keychain-backed store; the
 * memory store here is the deterministic headless/test implementation.
 */

/** Service namespace used for provider credentials in any keychain. */
export const KEYCHAIN_SERVICE = "voxel-maker:provider";

/** A credential value that redacts itself outside explicit `reveal`. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The only way to read the secret; callers must bound its use. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTION_MARKER;
  }

  toJSON(): string {
    return REDACTION_MARKER;
  }
}

/** Builds a redacting secret value. */
export function secret(value: string): Secret {
  return new Secret(value);
}

/** Reference to one stored credential, safe for listing and UI. */
export interface CredentialReference {
  readonly service: string;
  readonly account: string;
  /** True when a secret is currently stored for this reference. */
  readonly present: boolean;
}

/**
 * OS-keychain adapter seam (ADR-0010): `save`/`get`/`delete` map to the
 * platform credential store (macOS Keychain, Windows Credential Manager,
 * Linux Secret Service) in the desktop composition root. The agent
 * package never stores a credential anywhere else.
 */
export interface CredentialStore {
  save(service: string, account: string, value: Secret): Promise<void>;
  get(service: string, account: string): Promise<Secret | undefined>;
  delete(service: string, account: string): Promise<boolean>;
  list(): Promise<readonly CredentialReference[]>;
}

/**
 * Deterministic in-memory credential store for headless runs and tests.
 * It exists to prove the seam and to keep offline workflows usable; the
 * desktop app must not use it for real keys.
 */
export class MemoryCredentialStore implements CredentialStore {
  readonly #entries = new Map<string, Secret>();

  save(service: string, account: string, value: Secret): Promise<void> {
    this.#entries.set(`${service}\u0000${account}`, value);
    return Promise.resolve();
  }

  get(service: string, account: string): Promise<Secret | undefined> {
    return Promise.resolve(this.#entries.get(`${service}\u0000${account}`));
  }

  delete(service: string, account: string): Promise<boolean> {
    return Promise.resolve(this.#entries.delete(`${service}\u0000${account}`));
  }

  list(): Promise<readonly CredentialReference[]> {
    return Promise.resolve(
      [...this.#entries.entries()].map(([key]) => {
        const separator = key.indexOf("\u0000");
        return {
          service: key.slice(0, separator),
          account: key.slice(separator + 1),
          present: true,
        };
      }),
    );
  }
}
