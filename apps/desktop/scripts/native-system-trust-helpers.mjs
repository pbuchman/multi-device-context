import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";

export const NODE_UNTRUSTED_CERTIFICATE_CODES = Object.freeze([
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const CHROMIUM_CERTIFICATE_MESSAGES = new Map([
  ["net::ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_AUTHORITY_INVALID"],
  ["net::ERR_CERT_COMMON_NAME_INVALID", "ERR_CERT_COMMON_NAME_INVALID"],
]);

function errorChain(error) {
  const values = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current) && values.length < 8) {
    seen.add(current);
    values.push(current);
    current = current.cause;
  }
  return values;
}

export function classifyChromiumCertificateError(error) {
  for (const current of errorChain(error)) {
    if (typeof current.message !== "string") continue;
    const code = CHROMIUM_CERTIFICATE_MESSAGES.get(current.message);
    if (code) return code;
  }
  return undefined;
}

export function classifyNodeCertificateError(error) {
  const allowed = new Set(NODE_UNTRUSTED_CERTIFICATE_CODES);
  for (const current of errorChain(error)) {
    if (typeof current.code === "string" && allowed.has(current.code)) return current.code;
  }
  return undefined;
}

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
