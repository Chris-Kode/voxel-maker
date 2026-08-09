#!/usr/bin/env node
import { runAnimationTrace, runHeadlessTrace } from "./index.js";
console.log(runHeadlessTrace());
console.log(runAnimationTrace());
