import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";

export function parseOutputArgument(arguments_) {
  assert.deepEqual(
    arguments_.filter(value => value === "--output"),
    ["--output"],
    "Pass exactly one --output ABS_REPORT_JSON argument",
  );
  assert.equal(arguments_.length, 2, "Only --output ABS_REPORT_JSON is accepted");
  assert.equal(arguments_[0], "--output", "Only --output ABS_REPORT_JSON is accepted");
  assert(arguments_[1], "--output requires a report path");
  assert(isAbsolute(arguments_[1]), "--output must be an absolute path");
  return resolve(arguments_[1]);
}

export function normalizeThumbprint(value) {
  const thumbprint = String(value).replaceAll(":", "").toUpperCase();
  assert.match(thumbprint, /^[0-9A-F]{40}$/u, "Expected a SHA-1 certificate thumbprint");
  return thumbprint;
}

export function sanitizedFailure(error, redactions = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of redactions.filter(Boolean)) message = message.replaceAll(value, "[fixture]");
  message = message.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
  return {
    name: error instanceof Error && error.name ? error.name : "Error",
    message: message.slice(0, 500) || "Native system trust acceptance failed",
  };
}
