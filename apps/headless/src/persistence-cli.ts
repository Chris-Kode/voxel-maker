#!/usr/bin/env node
import { runPersistenceTrace } from "./persistence.js";
console.log(await runPersistenceTrace());
