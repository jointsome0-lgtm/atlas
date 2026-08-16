// Runs every differential harness against the CPython oracle and reports a
// single verdict. The oracle stays authoritative until the cutover gate, so
// a non-zero exit here means the port disagrees with the implementation it
// is replacing — not that a test needs adjusting.

// Zones chosen to break a wall-clock implementation rather than to sample
// the world: Santiago moves its clock at midnight (so a local midnight can
// be missing), Apia once skipped a whole calendar day, Kathmandu sits at a
// 45-minute offset, Lord Howe shifts by 30 minutes, and Kiritimati is the
// far side of the date line at UTC+14. UTC is included precisely because it
// hides these faults: a harness that only ran there would pass a broken
// implementation.
const ZONES = [
  "UTC",
  "America/Santiago",
  "Pacific/Apia",
  "Asia/Kathmandu",
  "Australia/Lord_Howe",
  "Pacific/Kiritimati",
] as const;

interface Harness {
  readonly file: string;
  // Only calendar arithmetic can be perturbed by an ambient zone; running
  // the JSON forms six times would buy nothing but wall time.
  readonly zones: readonly string[];
}

const HARNESSES: readonly Harness[] = [
  { file: "scripts/differential/json-forms.ts", zones: ["UTC"] },
  { file: "scripts/differential/calendar.ts", zones: ZONES },
  { file: "scripts/differential/frontmatter.ts", zones: ["UTC"] },
  { file: "scripts/differential/posix.ts", zones: ["UTC"] },
  { file: "scripts/differential/reader.ts", zones: ["UTC"] },
  { file: "scripts/differential/instance.ts", zones: ["UTC"] },
  // Freshness is a day count, so this one runs the hostile-timezone matrix
  // for the same reason the calendar harness does.
  { file: "scripts/differential/domain.ts", zones: ZONES },
  { file: "scripts/differential/preflight.ts", zones: ["UTC"] },
  // Freshness is recomputed inside the review gate, so the §-rule joins run
  // the hostile-timezone matrix too.
  { file: "scripts/differential/checks.ts", zones: ZONES },
  // The emitted-graph pass runs the review gate over whole graphs, so its
  // freshness arithmetic meets the same matrix.
  { file: "scripts/differential/graph-rules.ts", zones: ZONES },
  // The whole-instance driver reaches every pass, review gate included.
  { file: "scripts/differential/validate-instance.ts", zones: ZONES },
  // The grammar knows nothing about dates, so one zone is the whole matrix
  // here — and this one builds every ceiling fixture from its limit, which is
  // a quarter of a megabyte several times over. Running it six times would
  // buy a repeat of an answer that cannot depend on the clock.
  { file: "scripts/differential/conformance.ts", zones: ["UTC"] },
  // The command line over the preflight, the constants gate and the grammar
  // suite. The passes underneath it meet the matrix on their own lines; what
  // is compared here is dispatch, diagnostics and the summary each prints.
  { file: "scripts/differential/validate-cli.ts", zones: ["UTC"] },
  // Argument reading has no clock in it, and the demo's own server is the
  // instance server's route table, compared over a socket further down.
  { file: "scripts/differential/demo-cli.ts", zones: ["UTC"] },
  // What git reports about a repository does not turn with the clock either.
  { file: "scripts/differential/hygiene.ts", zones: ["UTC"] },
  // The §32.6 closure is a fixpoint over ids and fields, with no date in it.
  { file: "scripts/differential/redact.ts", zones: ["UTC"] },
  // Durability is about descriptors and renames; the clock has no part in it.
  { file: "scripts/differential/emit.ts", zones: ["UTC"] },
  // The builder folds freshness onto the graph it emits, so its whole-graph
  // comparison meets the hostile-timezone matrix as well.
  { file: "scripts/differential/build.ts", zones: ZONES },
  // The command line runs two programs per case, which is expensive, and adds
  // nothing the clock can reach: argument grammar, path resolution, the lock
  // and what a run leaves behind. The fold underneath it already meets the
  // matrix on the line above.
  { file: "scripts/differential/build-cli.ts", zones: ["UTC"] },
  // A case here is a sequence of runs over one tree, which is the most
  // expensive shape in this list. Dates in a delivery are carried, never
  // computed — a receipt's date is the record's own — so the clock has
  // nothing to perturb.
  { file: "scripts/differential/intake.ts", zones: ["UTC"] },
  // The capture lane carries the date it is given onto its receipts and never
  // asks what day it is, so one zone is the whole matrix here too.
  { file: "scripts/differential/capture.ts", zones: ["UTC"] },
  // The server's only clock is the Date header, which is folded away because
  // two processes cannot share a second — and it is GMT by construction, so an
  // ambient zone cannot reach it either.
  { file: "scripts/differential/serve.ts", zones: ["UTC"] },
];

let failures = 0;

// No arguments. `--record` was forwarded here while CPython was installed and
// there was something to record from; the 2026-08-16 §27.8 decision rejected
// keeping it — "with no oracle there is nothing left to record from" — and the
// harnesses have read their frozen answers alone since the cutover. Accepting
// it silently would let `--record` exit 0 having recorded nothing, which is the
// worst of the three possible behaviours.
if (process.argv.length > 2) {
  for (const line of ["this command takes no arguments", "usage: run.ts"]) {
    process.stderr.write(`ERROR: ${line}\n`);
  }
  process.exit(2);
}

for (const harness of HARNESSES) {
  for (const zone of harness.zones) {
    const run = Bun.spawnSync(["bun", harness.file], {
      env: { ...process.env, TZ: zone },
      // Progress and comparison counts are this run's result summary, so they
      // stay on stdout and stay live. A harness's stderr is a diagnostic, and
      // §25.8 wants those prefixed one line at a time — inherited, a divergence
      // report or a Bun traceback arrived here as raw unprefixed lines. Control
      // characters fold so a forwarded line cannot erase the prefix put in
      // front of it.
      stdout: "inherit",
      stderr: "pipe",
    });
    const said = Buffer.from(run.stderr).toString("utf8");
    for (const line of said.split("\n")) {
      if (line === "") continue;
      process.stderr.write(`ERROR: ${line.replace(/[\p{Cc}\p{Cf}]/gu, "?")}\n`);
    }
    if (run.exitCode !== 0) failures += 1;
  }
}

console.log(
  failures === 0
    ? "differential: all harnesses agree with the oracle"
    : `differential: ${failures} harness run(s) diverged from the oracle`,
);
process.exit(failures === 0 ? 0 : 1);
