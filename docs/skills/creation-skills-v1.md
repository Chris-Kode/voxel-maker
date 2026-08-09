# Creation skills v1

**Status:** v1 (ticket #38, plan S14.1/S14.2/S14.6/S14.9/S14.10/S14.11)

The creation-skill catalog ships removable, versioned domain knowledge
for building representative asset categories with the generic engine. It
lives in the `@voxel-maker/skills` package (plan S14) and contains:

- the **skill manifest** contract and validator (`src/manifest.ts`);
- the **creation-skill registry** (`src/skill-registry.ts`) — seven v1
  skills: furniture, architecture, vegetation, vehicle, humanoid,
  quadruped, and flying creature;
- the **generic structural-check registry** (`src/checks.ts`);
- the **visual-baseline** and **efficiency-limit** evaluators
  (`src/baselines.ts`, `src/efficiency.ts`);
- the **provenance** helpers that record the active skill in transaction
  metadata (`src/provenance.ts`).

Skills are pure JSON-safe data. They produce generic command proposals
and never touch renderers, providers, or the document schema.

## Manifest contract (plan S14.1)

One skill manifest is a frozen JSON object:

| Field | Meaning | Validation |
|---|---|---|
| `manifestVersion` | Schema version of the manifest contract | must equal `1` |
| `name` | Stable unique name `skill.<kebab-case>` | ≤ 64 chars, pattern-enforced |
| `version` | Skill definition version `major.minor.patch` | ≤ 32 chars, pattern-enforced |
| `description` | Short description | 1..512 chars |
| `category` | Asset category | one of the seven v1 categories |
| `instructions` | Fixed instructions the agent runs under | 1..16384 chars |
| `allowedTools` | Allowed agent tool names | non-empty, unique, all registered |
| `generators` | Compatible generator names | non-empty, unique, all registered |
| `constraints` | Hard caps (rounds/tool calls/commands per run, commands/voxels per proposal) | integers 1..hard engine cap (ADR-0009) |
| `provenance` | Author, source, license, created date | non-empty, bounded, ISO date |
| `evaluation` | Scenario id, fixed prompt, structural checks, visual baselines, efficiency limits | see below |

The validator (`validateSkillManifest`) checks every dimension with its
own stable error code, so a registry failure names the broken field:

`SKILL_MANIFEST_VERSION_INVALID`, `SKILL_NAME_INVALID`,
`SKILL_VERSION_INVALID`, `SKILL_INSTRUCTIONS_INVALID`,
`SKILL_TOOLS_INVALID`, `SKILL_CONSTRAINTS_INVALID`,
`SKILL_GENERATOR_INVALID`, `SKILL_PROVENANCE_INVALID`,
`SKILL_EVALUATION_INVALID`.

### Evaluation metadata (plan S14.10)

Every skill fixes its own evaluation contract:

- `fixedPrompt` — the exact user prompt the skill is evaluated against.
- `structuralChecks` — named checks from the generic check registry
  (below) with concrete, bounded options.
- `visualBaselines` — standard preview views (`perspective`, `front`,
  `side`, `top`) with an optional silhouette-share interval
  (`minSilhouetteRatio`/`maxSilhouetteRatio`, both 0..1, min ≤ max).
- `efficiency` — golden counts and absolute maxima for tool calls,
  rounds, and proposed commands. Goldens must be ≤ their maxima; maxima
  must be ≤ the skill constraints; constraints must be ≤ the hard engine
  caps.

## Structural checks (plan S14.10)

The generic check registry (`src/checks.ts`) provides deterministic
predicates over a committed document. Checks are asset-category-agnostic;
skills reference them with fixed options. Every occupancy scan is bounded
by an explicit region in the options (extent per axis ≤ 2048, volume ≤
1 000 000), so checks can never iterate unbounded space.

| Check | Options | Passes when |
|---|---|---|
| `occupied-voxel-count-in-range` | `region`, `min`, `max` | occupied voxels inside the region stay within `[min, max]` |
| `occupancy-inside-region` | `region`, `scanRegion` | no occupied voxel of the scan region lies outside the inner region |
| `region-nonempty` | `region` | the region contains at least one occupied voxel |
| `material-present` | — | the document contains the skill target material |
| `node-count-in-range` | `min`, `max` | document node count stays within `[min, max]` |
| `symmetric-along-axis` | `axis`, `plane`, `region` | occupancy in the region is mirror-symmetric across the plane |

`runStructuralChecks(checks, store, context)` executes a skill's checks
against a store and returns frozen pass/fail evidence.

## Visual baselines and efficiency (plan S14.10)

`evaluateVisualBaselines(baselines, evidence)` decides pass/fail from
rendered silhouette shares supplied by the evaluation harness (the
skills package itself never renders). `checkEfficiency(limits, stats)`
reports whether a run stayed within the golden expectations and absolute
maxima per dimension (tool calls, rounds, commands).

## Provenance (plan S14.9)

Applying a staged skill proposal through `applyWithProvenance` records
`skill:<name>@<version>` as the transaction label and a deterministic
correlation id (`skill:<name>@<version>:<seed digest>`) in the history
entry and recovery journal. Provenance is **advisory metadata**: it is
never written into the document, never required to open, edit, animate,
or export the result, and never consulted by the command bus. Removing
the skill catalog therefore cannot affect any document previously
created with a skill.

## Authoring a new creation skill

1. Add the category to `SKILL_CATEGORIES` in `src/manifest.ts` (or reuse
   an existing one) and a manifest in `src/creation/`.
2. Reference only **registered tools** (`KNOWN_TOOL_NAMES`) and
   **registered generators** (`KNOWN_GENERATOR_NAMES`); the registry
   rejects unknown names.
3. Keep `constraints` at or below the hard engine caps; keep efficiency
   maxima at or below the constraints and goldens at or below the maxima.
4. Reference only **registered structural checks** with bounded regions;
   the registry rejects unknown checks and unbounded options.
5. Keep the instructions tool- and generator-specific but
   category-generic: fixed prompts, structural checks, and baselines
   describe the fixed evaluation scenario, never a renderer or a
   document type.
6. Register the manifest in `CREATION_SKILLS` (stable category order)
   and re-run `pnpm --filter @voxel-maker/skills test`.

Every skill is validated and deep-frozen at catalog load, so a broken
manifest fails fast at import. The boundary suite
(`src/boundary.test.ts`) proves the catalog stays removable: no package
depends on it, and documents created with a skill open, edit, animate,
and export in a process that imports none of the catalog.
