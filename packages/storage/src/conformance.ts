import { WorkspaceError } from "@voxel-maker/shared";
import {
  backupPathFor,
  IO_ERROR_CODES,
  PHASE_ERROR_CODES,
  type AtomicWriteFaultPlan,
  type AtomicWritePhase,
  type ProjectStoragePort,
} from "./port.js";

/**
 * One framework-agnostic conformance case. `run` throws on failure, so any
 * test runner can wrap cases in its own `it` blocks.
 */
export interface PortConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

/**
 * Adapter harness for the conformance matrix. `tempPaths` reports the
 * adapter's currently allocated temporary paths so every case can assert
 * cleanup on success and failure. `cleanup` removes case-local fixtures
 * (for example the temporary directory of the Node adapter).
 */
export interface StoragePortHarness {
  readonly port: ProjectStoragePort;
  /** Destination path used by the cases (adapter-specific). */
  readonly projectPath: string;
  readonly tempPaths: () => Promise<readonly string[]>;
  readonly cleanup?: () => Promise<void>;
}

/** Builds a fresh harness; optional faults apply to every write. */
export type StoragePortFactory = (options?: {
  readonly faults?: AtomicWriteFaultPlan;
}) => StoragePortHarness | Promise<StoragePortHarness>;

const V0 = new TextEncoder().encode("version-zero");
const V1 = new TextEncoder().encode("version-one");

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertBytesEqual(
  actual: Uint8Array,
  expected: Uint8Array,
  message: string,
): void {
  assert(actual.byteLength === expected.byteLength, `${message}: length`);
  for (let index = 0; index < actual.byteLength; index += 1) {
    assert(
      actual[index] === expected[index],
      `${message}: byte ${String(index)}`,
    );
  }
}

async function expectIoCode(
  promise: Promise<unknown>,
  code: string,
): Promise<WorkspaceError> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof WorkspaceError)) {
    throw new Error(`Expected WorkspaceError ${code}, got ${String(error)}`);
  }
  assert(error.family === "io", `${code} must be an io-family error`);
  assert(error.code === code, `Expected ${code}, got ${error.code}`);
  return error;
}

/**
 * Shared storage port conformance matrix (ticket #13 acceptance: Memory and
 * Node storage adapters exercise disk-full, permissions, rename,
 * interruption, and stale-completion failures at the same seams).
 */
export function storagePortConformanceCases(
  factory: StoragePortFactory,
): readonly PortConformanceCase[] {
  const cases: PortConformanceCase[] = [];

  cases.push({
    name: "round-trips project bytes through an atomic write and read",
    run: async () => {
      const harness = await factory();
      const { port, projectPath } = harness;
      try {
        const result = await port.writeProjectAtomic(projectPath, V1);
        assert(!result.backupCreated, "first save has no backup");
        assert(
          await port.exists(projectPath),
          "destination must exist after the write",
        );
        assertBytesEqual(await port.readProject(projectPath), V1, "read bytes");
        assert(
          (await harness.tempPaths()).length === 0,
          "no temporary files remain after success",
        );
      } finally {
        await harness.cleanup?.();
      }
    },
  });

  cases.push({
    name: "first save creates no backup; second save preserves the previous destination as last-known-good",
    run: async () => {
      const harness = await factory();
      const { port, projectPath } = harness;
      try {
        const first = await port.writeProjectAtomic(projectPath, V0);
        assert(!first.backupCreated, "first save must not create a backup");
        assert(
          (await port.readBackup(projectPath)) === undefined,
          "no backup after first save",
        );
        const second = await port.writeProjectAtomic(projectPath, V1);
        assert(second.backupCreated, "second save must create a backup");
        assert(
          second.backupPath === backupPathFor(projectPath),
          "backup path is adjacent",
        );
        assertBytesEqual(
          (await port.readBackup(projectPath)) as Uint8Array,
          V0,
          "backup holds the previous destination",
        );
        assertBytesEqual(
          await port.readProject(projectPath),
          V1,
          "destination is new",
        );
      } finally {
        await harness.cleanup?.();
      }
    },
  });

  cases.push({
    name: "a failure at every atomic phase leaves destination and backup untouched and removes the temporary file",
    run: async () => {
      const phases: AtomicWritePhase[] = [
        "create-temp",
        "write-temp",
        "flush-temp",
        "backup",
        "replace",
      ];
      for (const phase of phases) {
        const harness = await factory();
        const { port, projectPath } = harness;
        try {
          await port.writeProjectAtomic(projectPath, V0);
          await port.writeProjectAtomic(projectPath, V1); // backup now V0
          const error = await expectIoCode(
            port.writeProjectAtomic(
              projectPath,
              new TextEncoder().encode("v2"),
              { faults: { failAt: { [phase]: true } } },
            ),
            PHASE_ERROR_CODES[phase],
          );
          assert(
            error.context?.phase === phase,
            `error names the ${phase} phase`,
          );
          assertBytesEqual(
            await port.readProject(projectPath),
            V1,
            "destination untouched",
          );
          // The backup step runs before replace, so a replace-phase fault
          // already refreshed the backup to the current destination; every
          // earlier fault leaves it untouched.
          const expectedBackup = phase === "replace" ? V1 : V0;
          assertBytesEqual(
            (await port.readBackup(projectPath)) as Uint8Array,
            expectedBackup,
            "backup holds the last-known-good destination",
          );
          assert(
            (await harness.tempPaths()).length === 0,
            `no temporary file remains after ${phase} failure`,
          );
        } finally {
          await harness.cleanup?.();
        }
      }
    },
  });

  cases.push({
    name: "directory sync is best-effort and never fails the save",
    run: async () => {
      const harness = await factory();
      const { port, projectPath } = harness;
      try {
        const result = await port.writeProjectAtomic(projectPath, V1, {
          faults: { failAt: { "sync-directory": true } },
        });
        assert(!result.directorySyncSucceeded, "reports the sync failure");
        assertBytesEqual(
          await port.readProject(projectPath),
          V1,
          "save still succeeded",
        );
      } finally {
        await harness.cleanup?.();
      }
    },
  });

  cases.push({
    name: "missing reads reject IO_NOT_FOUND and remove is idempotent",
    run: async () => {
      const harness = await factory();
      const { port, projectPath } = harness;
      try {
        const missing = `${projectPath}.missing`;
        await expectIoCode(port.readProject(missing), IO_ERROR_CODES.notFound);
        assert(!(await port.exists(missing)), "missing stays missing");
        await port.remove(missing);
        await port.remove(missing);
        assert((await port.readBackup(missing)) === undefined, "no backup");
      } finally {
        await harness.cleanup?.();
      }
    },
  });

  cases.push({
    name: "an aborted signal interrupts the write without touching destination or backup",
    run: async () => {
      const harness = await factory();
      const { port, projectPath } = harness;
      try {
        await port.writeProjectAtomic(projectPath, V0);
        const controller = new AbortController();
        controller.abort();
        await expectIoCode(
          port.writeProjectAtomic(projectPath, V1, {
            signal: controller.signal,
          }),
          IO_ERROR_CODES.writeInterrupted,
        );
        assertBytesEqual(
          await port.readProject(projectPath),
          V0,
          "destination untouched",
        );
        assert(
          (await port.readBackup(projectPath)) === undefined,
          "backup untouched",
        );
        assert(
          (await harness.tempPaths()).length === 0,
          "temporary file removed",
        );
      } finally {
        await harness.cleanup?.();
      }
    },
  });

  cases.push({
    name: "a second interrupted write still leaves the previous destination readable",
    run: async () => {
      const harness = await factory();
      const { port, projectPath } = harness;
      try {
        await port.writeProjectAtomic(projectPath, V0);
        await port.writeProjectAtomic(projectPath, V1);
        const controller = new AbortController();
        controller.abort();
        await expectIoCode(
          port.writeProjectAtomic(projectPath, new TextEncoder().encode("v2"), {
            signal: controller.signal,
          }),
          IO_ERROR_CODES.writeInterrupted,
        );
        assertBytesEqual(
          await port.readProject(projectPath),
          V1,
          "latest good version intact",
        );
        assertBytesEqual(
          (await port.readBackup(projectPath)) as Uint8Array,
          V0,
          "backup intact",
        );
      } finally {
        await harness.cleanup?.();
      }
    },
  });

  return cases;
}
