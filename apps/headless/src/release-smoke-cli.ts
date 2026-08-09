#!/usr/bin/env node
import { runReleaseSmoke } from "./release-smoke.js";
console.log(await runReleaseSmoke());
