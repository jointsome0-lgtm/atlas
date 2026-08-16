// The command line over the three checks that read canon rather than write it.
//
//   validate INSTANCE_ROOT   the §25.7 preflight over one instance
//   check-constants          code against `spec/schemas` and §25.8
//   conformance              the frontmatter grammar against its fixtures
//
// There is no argparse here and none in the oracle either: three fixed shapes,
// anything else is the usage line and exit 2. Diagnostics go to stderr with
// their newlines flattened (§24.4 asks for one line per finding), the count
// goes to stdout, and the exit code says only whether anything was wrong.
//
// Ported from main and _emit_diagnostics in scripts/validate_atlas.py.

import { checkConstants } from "./constants.ts";
import { runConformance } from "./conformance.ts";
import { validateInstance } from "./validate.ts";

/** Where the two canons live: the repository, not the instance under test. */
const REPOSITORY = `${import.meta.dir}/../..`;

export interface Sinks {
  readonly out: { write(text: string): void };
  readonly err: { write(text: string): void };
}

const flattened = (text: string): string => text.replaceAll("\n", " ");

function emit(sinks: Sinks, errors: readonly string[], warnings: readonly string[] = []): void {
  for (const warning of warnings) sinks.err.write(`WARNING: ${flattened(warning)}\n`);
  for (const error of errors) sinks.err.write(`ERROR: ${flattened(error)}\n`);
}

export function main(
  args: readonly string[],
  program: string,
  sinks: Sinks = { out: process.stdout, err: process.stderr },
  repository: string = REPOSITORY,
): number {
  const usage = (): number => {
    sinks.err.write(
      `ERROR: usage: ${program} validate INSTANCE_ROOT | check-constants | conformance\n`,
    );
    return 2;
  };

  if (args.length === 0) return usage();
  const [command, ...rest] = args;

  if (command === "validate" && rest.length === 1) {
    const { errors, warnings, counts } = validateInstance(rest[0] as string, repository);
    emit(sinks, errors, warnings);
    sinks.out.write(
      `validated: ${counts.frontmatter} frontmatter documents, ` +
        `${counts.rows} journal rows, ${counts.intake} intake batches, ` +
        `${counts.emitted} emitted files; ` +
        `${errors.length} errors, ${warnings.length} warnings\n`,
    );
    return errors.length > 0 ? 1 : 0;
  }
  if (command === "check-constants" && rest.length === 0) {
    const errors = checkConstants(repository);
    emit(sinks, errors);
    sinks.out.write(`checked constants: ${errors.length} errors\n`);
    return errors.length > 0 ? 1 : 0;
  }
  if (command === "conformance" && rest.length === 0) {
    const { errors, count } = runConformance(repository);
    emit(sinks, errors);
    sinks.out.write(`conformance: ${count} cases, ${errors.length} errors\n`);
    return errors.length > 0 ? 1 : 0;
  }
  return usage();
}
