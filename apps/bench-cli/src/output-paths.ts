import { resolve } from "node:path";

/**
 * Validates that `--json` and `--trends` never target the same file
 * (issue #58): the trend append and the standalone report must stay
 * distinct, or the later report write silently destroys the retained
 * trend history the earlier append just extended. Paths are resolved
 * during argument validation so the CLI fails before measuring or
 * writing either file.
 */
export function assertDistinctOutputPaths(
  jsonPath: string | undefined,
  trendsPath: string | undefined,
): void {
  if (jsonPath === undefined || trendsPath === undefined) return;
  const resolvedJson = resolve(jsonPath);
  const resolvedTrends = resolve(trendsPath);
  if (resolvedJson === resolvedTrends) {
    throw new Error(
      `--json and --trends resolve to the same file (${resolvedJson}); use distinct paths so the appended trend history is not overwritten by the report`,
    );
  }
}
