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
  // The §32.6 closure is a fixpoint over ids and fields, with no date in it.
  { file: "scripts/differential/redact.ts", zones: ["UTC"] },
  // Durability is about descriptors and renames; the clock has no part in it.
  { file: "scripts/differential/emit.ts", zones: ["UTC"] },
];

const probe = Bun.spawnSync(["python3", "-c", "import sys; print(sys.version)"]);
if (probe.exitCode !== 0) {
  console.error("differential: python3 is required as the oracle and is absent");
  process.exit(2);
}
console.log(`oracle: python3 ${probe.stdout.toString().trim()}`);

let failures = 0;

for (const harness of HARNESSES) {
  for (const zone of harness.zones) {
    const run = Bun.spawnSync(["bun", harness.file], {
      env: { ...process.env, TZ: zone },
      stdout: "inherit",
      stderr: "inherit",
    });
    if (run.exitCode !== 0) failures += 1;
  }
}

console.log(
  failures === 0
    ? "differential: all harnesses agree with the oracle"
    : `differential: ${failures} harness run(s) diverged from the oracle`,
);
process.exit(failures === 0 ? 0 : 1);
