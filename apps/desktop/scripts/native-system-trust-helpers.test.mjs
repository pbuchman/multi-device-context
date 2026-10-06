import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  normalizeThumbprint,
  parseOutputArgument,
  sanitizedFailure,
} from "./native-system-trust-helpers.mjs";

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

test("redacts private fixture paths and bounds single-line failure details", () => {
  const privateRoot = resolve("private fixture");
  const result = sanitizedFailure(new Error(`failed at ${privateRoot}\n${"x".repeat(600)}`), [privateRoot]);
  assert.equal(result.name, "Error");
  assert.match(result.message, /\[fixture\]/u);
  assert(!result.message.includes(privateRoot));
  assert(!result.message.includes("\n"));
  assert.equal(result.message.length, 500);
});
