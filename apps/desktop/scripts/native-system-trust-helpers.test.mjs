import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  NODE_UNTRUSTED_CERTIFICATE_CODES,
  buildWindowsRootCertificateCountScript,
  classifyChromiumCertificateError,
  classifyNodeCertificateError,
  normalizeThumbprint,
  parseOutputArgument,
  sanitizedFailure,
} from "./native-system-trust-helpers.mjs";

test("classifies only the exact Chromium certificate failures used by the harness", () => {
  assert.equal(
    classifyChromiumCertificateError(new TypeError("net::ERR_CERT_AUTHORITY_INVALID")),
    "ERR_CERT_AUTHORITY_INVALID",
  );
  assert.equal(
    classifyChromiumCertificateError(new TypeError("fetch failed", {
      cause: new Error("net::ERR_CERT_COMMON_NAME_INVALID"),
    })),
    "ERR_CERT_COMMON_NAME_INVALID",
  );
  assert.equal(classifyChromiumCertificateError(new Error("net::ERR_CONNECTION_REFUSED")), undefined);
  assert.equal(classifyChromiumCertificateError(new Error("ERR_CERT_AUTHORITY_INVALID")), undefined);
  assert.equal(classifyChromiumCertificateError(new Error("Request failed: net::ERR_CERT_AUTHORITY_INVALID")), undefined);
  assert.equal(classifyChromiumCertificateError(new Error("net::ERR_CERT_AUTHORITY_INVALID_EXTRA")), undefined);
  assert.equal(classifyChromiumCertificateError({ code: "net::ERR_CERT_AUTHORITY_INVALID" }), undefined);
});

test("accepts fixed Node trust-chain codes only through the error cause chain", () => {
  assert(Object.isFrozen(NODE_UNTRUSTED_CERTIFICATE_CODES));
  assert.equal(
    classifyNodeCertificateError(new TypeError("fetch failed", {
      cause: Object.assign(new Error("private CA"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
    })),
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  );
  assert.equal(
    classifyNodeCertificateError({ cause: { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } } }),
    "SELF_SIGNED_CERT_IN_CHAIN",
  );
  assert.equal(classifyNodeCertificateError(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })), undefined);
  assert.equal(classifyNodeCertificateError(new Error("UNABLE_TO_VERIFY_LEAF_SIGNATURE")), undefined);
});

test("requires one absolute report path and rejects unrelated arguments", () => {
  const report = resolve("release/native-system-trust.json");
  assert.equal(parseOutputArgument(["--output", report]), report);
  assert.throws(() => parseOutputArgument(["--output", join("release", "report.json")]), /absolute/u);
  assert.throws(() => parseOutputArgument(["--output", report, "--extra"]), /Only/u);
  assert.throws(() => parseOutputArgument(["--output", report, "--output", report]), /exactly one/u);
});

test("normalizes only complete SHA-1 certificate thumbprints", () => {
  assert.equal(
    normalizeThumbprint("aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd"),
    "AABBCCDDEEFF00112233445566778899AABBCCDD",
  );
  assert.throws(() => normalizeThumbprint("not-a-thumbprint"), /SHA-1/u);
});

test("builds a Windows certificate count command without static-property method syntax", () => {
  const script = buildWindowsRootCertificateCountScript("aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd");
  assert.match(script, /\$thumbprint = 'AABBCCDDEEFF00112233445566778899AABBCCDD'/u);
  assert.match(script, /Get-ChildItem -LiteralPath 'Cert:\\CurrentUser\\Root'/u);
  assert.match(script, /\$count = \$certificates\.Count/u);
  assert.match(script, /\[Console\]::Write\(\[string\]\$count\)/u);
  assert.doesNotMatch(script, /::Out\.Write/u);
  assert.throws(() => buildWindowsRootCertificateCountScript("not-a-thumbprint"), /SHA-1/u);
});

test("redacts private fixture paths and bounds single-line failure details", () => {
  const privateRoot = resolve("private fixture");
  const result = sanitizedFailure(new Error(`\u001B[31mfailed\u001B[0m at ${privateRoot}\n${"x".repeat(600)}`), [privateRoot]);
  assert.equal(result.name, "Error");
  assert.match(result.message, /^failed at/u);
  assert.match(result.message, /\[fixture\]/u);
  assert(!result.message.includes(privateRoot));
  assert(!result.message.includes("\n"));
  assert(!result.message.includes("\u001B"));
  assert.equal(result.message.length, 500);
});
