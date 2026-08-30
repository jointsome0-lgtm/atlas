import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";

const ROOT = `${import.meta.dir}/../../..`;

test("help and invalid usage do not build or write viewer emissions", () => {
  const checkout = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/atlas-serve-cli-`));
  try {
    fs.cpSync(`${ROOT}/scripts`, `${checkout}/scripts`, { recursive: true });
    fs.cpSync(`${ROOT}/viewer`, `${checkout}/viewer`, { recursive: true });
    const emissions = [
      `${checkout}/viewer/contract.js`,
      `${checkout}/viewer/viewer.js`,
    ];
    for (const emission of emissions) fs.rmSync(emission, { force: true });

    const cases = [
      { script: "view_demo.ts", argv: ["--help"], code: 0, stderr: "" },
      { script: "view_demo.ts", argv: ["--port", "nope"], code: 2 },
      { script: "serve_instance.ts", argv: ["--help"], code: 0, stderr: "" },
      {
        script: "serve_instance.ts",
        argv: ["--port", "nope", "/instance"],
        code: 2,
      },
    ] as const;

    for (const attempt of cases) {
      const run = Bun.spawnSync(
        [
          process.execPath,
          "--no-install",
          `${checkout}/scripts/${attempt.script}`,
          ...attempt.argv,
        ],
        { cwd: checkout, stdout: "pipe", stderr: "pipe" },
      );
      expect(run.exitCode, attempt.script).toBe(attempt.code);
      if ("stderr" in attempt) {
        expect(run.stderr.toString(), attempt.script).toBe(attempt.stderr);
      }
      for (const emission of emissions) expect(fs.existsSync(emission)).toBe(false);
    }
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});
