import { expect, it } from "vitest";
import { diagnostic } from "./diagnostics.js";
it("P3: diagnostics contain only approved fields", () => {
  let output = ""; diagnostic("ai-title", "provider-rejected", value => { output += value; });
  expect(Object.keys(JSON.parse(output)).sort()).toEqual(["at", "operation", "reason"]);
  expect(JSON.parse(output)).toMatchObject({ operation: "ai-title", reason: "provider-rejected" });
});
