#!/usr/bin/env node
import {
  runAnimationDemosTrace,
  runAnimationTrace,
  runHeadlessTrace,
} from "./index.js";
console.log(runHeadlessTrace());
console.log(runAnimationTrace());
console.log(runAnimationDemosTrace());
