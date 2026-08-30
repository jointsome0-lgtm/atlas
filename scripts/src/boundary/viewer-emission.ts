import { fileURLToPath } from "node:url";

export function buildViewer(): boolean {
  const build = Bun.spawnSync([
    process.execPath,
    "--no-install",
    fileURLToPath(new URL("../../build_viewer.ts", import.meta.url)),
  ]);
  if (build.stderr.length > 0) process.stderr.write(build.stderr);
  if (build.exitCode === 0) return true;
  console.error("ERROR: the viewer emission could not be built from viewer/src");
  return false;
}
