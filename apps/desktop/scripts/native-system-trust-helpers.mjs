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

function errorGraph(error) {
  const values = [];
  const seen = new Set();
  const pending = [error];
  while (pending.length > 0 && values.length < 8) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    values.push(current);
    pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors.slice(0, 8));
  }
  return values;
}

export function classifyChromiumCertificateError(error) {
  for (const current of errorGraph(error)) {
    if (typeof current.message !== "string") continue;
    const code = CHROMIUM_CERTIFICATE_MESSAGES.get(current.message);
    if (code) return code;
  }
  return undefined;
}

export function classifyNodeCertificateError(error) {
  const allowed = new Set(NODE_UNTRUSTED_CERTIFICATE_CODES);
  for (const current of errorGraph(error)) {
    if (typeof current.code === "string" && allowed.has(current.code)) return current.code;
  }
  return undefined;
}

export function nodeErrorEvidence(error) {
  return errorGraph(error).flatMap(current => {
    const name = typeof current.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(current.name)
      ? current.name
      : undefined;
    const code = typeof current.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(current.code)
      ? current.code
      : undefined;
    return name || code ? [{ ...(name ? { name } : {}), ...(code ? { code } : {}) }] : [];
  }).slice(0, 8);
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

export function buildWindowsRootCertificateCountScript(value) {
  const thumbprint = normalizeThumbprint(value);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$thumbprint = '${thumbprint}'`,
    "$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)",
    "try { $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly); $count = $store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $thumbprint, $false).Count; [Console]::Write([string]$count) } finally { $store.Close() }",
  ].join("; ");
}

export function sanitizedFailure(error, redactions = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of redactions.filter(Boolean)) message = message.replaceAll(value, "[fixture]");
  message = message
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return {
    name: error instanceof Error && error.name ? error.name : "Error",
    message: message.slice(0, 500) || "Native system trust acceptance failed",
  };
}
