/**
 * Recent-project store of the desktop shell (plan S7.16, ticket #22,
 * issue #94): a bounded, scoped list of previously opened projects so
 * users can reopen work without navigating. The store is runtime UI state
 * and never touches semantic state; entries are
 * `{ token, path, title, openedAt }` records, most-recent-first.
 * Implementations are injected at the composition root: an in-memory
 * store for tests, localStorage for the plain browser dev build, and a
 * Tauri command backed by a JSON file in the app config directory for the
 * product shell.
 *
 * In the product shell the `token` is the opaque Rust-owned handle used
 * to reopen the project; the stored `path` is written by Rust from the
 * resolved handle and is display-only (no native command accepts a raw
 * path, so a compromised webview can never turn a stored path into file
 * access). The webview only ever supplies tokens it was issued.
 */

export interface RecentProjectEntry {
  /**
   * Opaque storage key: the Rust-owned handle token in the Tauri shell,
   * the plain path in browser/test shells.
   */
  readonly token: string;
  /** Display path (dialog-issued; display-only in the native shell). */
  readonly path: string;
  /** Display title; bounded string, may be empty for untitled projects. */
  readonly title: string;
  /** Wall-clock open time; ordering only (never semantic). */
  readonly openedAt: number;
}

export interface RecentProjectsPort {
  /** Most-recent-first entries, bounded to `MAX_RECENT_PROJECTS`. */
  list(): Promise<readonly RecentProjectEntry[]>;
  /**
   * Records an open project: moves the token to the front, replaces the
   * previous title, and drops the oldest entry past the bound.
   */
  record(entry: RecentProjectEntry): Promise<void>;
  /** Forgets one token; a missing entry is not an error. */
  remove(token: string): Promise<void>;
}

/** Hard bound on the recent list (ADR-0009 style default). */
export const MAX_RECENT_PROJECTS = 10;

/** Storage key of the browser implementation (versioned). */
export const BROWSER_RECENT_KEY = "voxel-maker:recent-projects:v1";

/** In-memory recent-project store (tests and non-persistent shells). */
export function createMemoryRecentProjects(
  initial: readonly RecentProjectEntry[] = [],
): RecentProjectsPort {
  let entries = [...initial].sort(
    (a, b) => b.openedAt - a.openedAt || a.path.localeCompare(b.path),
  );
  return {
    list(): Promise<readonly RecentProjectEntry[]> {
      return Promise.resolve([...entries]);
    },
    record(entry: RecentProjectEntry): Promise<void> {
      const rest = entries.filter((existing) => existing.token !== entry.token);
      entries = [entry, ...rest].slice(0, MAX_RECENT_PROJECTS);
      return Promise.resolve();
    },
    remove(token: string): Promise<void> {
      entries = entries.filter((existing) => existing.token !== token);
      return Promise.resolve();
    },
  };
}

interface RecentRecord {
  readonly token: string;
  readonly path: string;
  readonly title: string;
  readonly openedAt: number;
}

/** Validates one parsed record; unknown shapes are dropped, never trusted. */
export function parseRecentRecord(value: unknown): RecentRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.token !== "string" ||
    record.token.length === 0 ||
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    typeof record.title !== "string" ||
    typeof record.openedAt !== "number" ||
    !Number.isFinite(record.openedAt)
  ) {
    return undefined;
  }
  return {
    token: record.token,
    path: record.path,
    title: record.title.slice(0, 512),
    openedAt: record.openedAt,
  };
}

/** localStorage-backed recent projects for the plain browser dev build. */
export function createBrowserRecentProjects(
  storage: Pick<
    Storage,
    "getItem" | "setItem" | "removeItem"
  > = window.localStorage,
): RecentProjectsPort {
  const read = (): RecentRecord[] => {
    try {
      const raw = storage.getItem(BROWSER_RECENT_KEY);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map(parseRecentRecord)
        .filter((entry): entry is RecentRecord => entry !== undefined);
    } catch {
      return [];
    }
  };
  const write = (entries: readonly RecentRecord[]): void => {
    try {
      storage.setItem(BROWSER_RECENT_KEY, JSON.stringify(entries));
    } catch {
      // Quota/private-mode failures only degrade the recent list.
    }
  };
  return {
    list(): Promise<readonly RecentProjectEntry[]> {
      return Promise.resolve(
        read()
          .sort((a, b) => b.openedAt - a.openedAt)
          .slice(0, MAX_RECENT_PROJECTS),
      );
    },
    record(entry: RecentProjectEntry): Promise<void> {
      const rest = read().filter((existing) => existing.token !== entry.token);
      write([entry, ...rest].slice(0, MAX_RECENT_PROJECTS));
      return Promise.resolve();
    },
    remove(token: string): Promise<void> {
      write(read().filter((existing) => existing.token !== token));
      return Promise.resolve();
    },
  };
}
