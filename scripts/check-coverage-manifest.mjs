/**
 * Coverage-manifest guard (W07 phase re-review).
 *
 * The coverage config holds the execution money path to 100% through a PER-GLOB threshold
 * keyed on `src/lib/execution/*.ts`. A per-glob threshold that matches nothing is not an
 * error in vitest — it is silence. A rename, a move, or a directory that quietly emptied out
 * would therefore leave the strictest gate in the repository VACUOUSLY GREEN: 100% asserted
 * over zero files, and nothing in the run says so.
 *
 * This script is the non-empty-match proof. It names, explicitly, every file that glob must
 * resolve to, and refuses the coverage run on any drift — zero matches, a manifest entry
 * absent from disk, or a file on disk absent from the manifest. Adding a module under
 * `src/lib/execution/` is a deliberate act here and in the coverage `include` list, exactly
 * the rule that list already states about itself.
 *
 * Rounds 4-5: the checks are STRUCTURAL end to end. Text search could not distinguish code
 * from a comment, and a lexical wiring anchor could not see a later spread overriding the
 * coverage value. The guard now imports the resolved vitest config module itself (plain JS
 * for exactly this reason) and asserts its test.coverage IS the guarded object by identity,
 * then asserts on that object's live value.
 *
 * Run:  node scripts/check-coverage-manifest.mjs   (wired into `npm run test:coverage`)
 */
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXECUTION_DIR,
  EXECUTION_FILES,
  EXECUTION_GLOB,
  coverageConfig,
} from "./coverage.config.mjs";
import * as vitestConfigModule from "../vitest.config.mjs";

// CLI output channel, routed through stdout/stderr directly so `no-console` stays an error
// repo-wide (the scripts/lint-boundaries.mjs pattern).
const emit = (line) => process.stdout.write(`${line}\n`);
const fail = (line) => process.stderr.write(`${line}\n`);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The values the guarded per-glob threshold must hold, exactly. */
const REQUIRED_THRESHOLD = { lines: 100, branches: 100, statements: 100 };

const problems = [];

let entries = [];
try {
  entries = readdirSync(join(REPO_ROOT, EXECUTION_DIR), { withFileTypes: true });
} catch {
  entries = [];
}
const resolved = entries
  .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
  .map((e) => e.name)
  .sort();
// The guarded glob is flat `*.ts`: a nested directory or a .tsx module would sit OUTSIDE
// the threshold while looking enrolled. Refuse both shapes rather than guessing.
const outsideGlob = entries
  .filter((e) => e.isDirectory() || (e.isFile() && e.name.endsWith(".tsx")))
  .map((e) => e.name)
  .sort();

if (outsideGlob.length > 0) {
  problems.push(
    `under ${EXECUTION_DIR}/ but OUTSIDE the flat "${EXECUTION_GLOB}" glob: ${outsideGlob.join(", ")} — ` +
      "nested directories and .tsx modules escape the 100% threshold; restructure or extend the gate first.",
  );
}

if (resolved.length === 0) {
  problems.push(
    `${EXECUTION_GLOB} resolves to ZERO files — the 100% threshold is vacuously green. ` +
      `Either ${EXECUTION_DIR}/ is gone or every module in it was renamed out from under the gate.`,
  );
}

const missing = EXECUTION_FILES.filter((name) => !resolved.includes(name));
if (missing.length > 0) {
  problems.push(
    `named in this manifest but absent under ${EXECUTION_DIR}/: ${missing.join(", ")} — ` +
      "the threshold no longer covers them.",
  );
}

const unexpected = resolved.filter((name) => !EXECUTION_FILES.includes(name));
if (unexpected.length > 0) {
  problems.push(
    `present under ${EXECUTION_DIR}/ but not in this manifest: ${unexpected.join(", ")} — ` +
      "enrol each one here and in the coverage include list, deliberately.",
  );
}

// Vitest builds the threshold's match set from the COVERAGE MAP, which coverage.include
// filters first: dropping a module from include leaves the threshold key present but
// matching nothing of that file — vacuous again, one layer deeper. Every manifest file must
// therefore appear in the include list. Asserted against the real array: a commented-out
// entry is not an array element, so it cannot satisfy this the way a text search let it.
const include = Array.isArray(coverageConfig.include) ? coverageConfig.include : [];
const notIncluded = EXECUTION_FILES.filter(
  (name) => !include.includes(`${EXECUTION_DIR}/${name}`),
);
if (notIncluded.length > 0) {
  problems.push(
    `absent from coverage.include: ${notIncluded
      .map((name) => `${EXECUTION_DIR}/${name}`)
      .join(", ")} — the 100% threshold cannot see files the coverage map never receives.`,
  );
}

// The threshold's values are the claim; a softened line/branch/statement bound is drift too,
// and so is dropping the key altogether — then the manifest guards a gate that does not exist.
const threshold = coverageConfig.thresholds?.[EXECUTION_GLOB];
const thresholdMatches =
  threshold !== null &&
  typeof threshold === "object" &&
  Object.keys(threshold).length === Object.keys(REQUIRED_THRESHOLD).length &&
  Object.entries(REQUIRED_THRESHOLD).every(([key, value]) => threshold[key] === value);
if (!thresholdMatches) {
  problems.push(
    `the "${EXECUTION_GLOB}" threshold reads ${JSON.stringify(threshold ?? null)}, not ` +
      `${JSON.stringify(REQUIRED_THRESHOLD)} — the 100% claim this manifest exists to keep ` +
      "honest has been softened, reshaped, or removed.",
  );
}

// The wiring proof, structural end to end (round 5): every assertion above reads the object
// exported by scripts/coverage.config.mjs, which proves nothing if the config vitest actually
// loads stops using it. vitest.config is plain JS precisely so this script can import the SAME
// FILE vitest loads and assert its resolved test.coverage is the guarded object BY IDENTITY —
// a later spread, an override, or a rewire to a different object is a different reference and
// fails here, no text inspection involved.
const resolvedTestConfig = vitestConfigModule.default?.test;
if (resolvedTestConfig?.coverage !== coverageConfig) {
  problems.push(
    "vitest.config.mjs's resolved test.coverage is not the coverage.config.mjs object " +
      "(identity check) — the config this manifest inspects is not the config vitest runs.",
  );
}

if (problems.length > 0) {
  fail("coverage-manifest drift:");
  for (const problem of problems) fail(`  - ${problem}`);
  process.exit(1);
}

emit(
  `coverage manifest OK — ${EXECUTION_GLOB} resolves to ${resolved.length} files: ` +
    resolved.join(", "),
);
