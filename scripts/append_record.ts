#!/usr/bin/env bun
import { basename } from "node:path";

import { main } from "./src/boundary/capture.ts";

process.exitCode = main(process.argv.slice(2), basename(process.argv[1] ?? ""));
