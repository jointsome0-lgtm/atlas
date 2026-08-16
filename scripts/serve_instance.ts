#!/usr/bin/env bun
import { basename } from "node:path";

import { main } from "./src/serve.ts";

process.exitCode = await main(process.argv.slice(2), basename(process.argv[1] ?? ""));
