import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Match pinned Node 22.12 behavior even when the local runtime auto-strips TypeScript.
it.each(["build", "serve"] as const)("loads Vite config for %s without native TypeScript loading", command => {
 const script = `
  import { loadConfigFromFile } from "vite";
  const result = await loadConfigFromFile({ command: ${JSON.stringify(command)}, mode: ${JSON.stringify(command === "build" ? "production" : "development")} }, "vite.config.ts");
  if (!result) throw new Error("Missing Vite config");
  console.log(JSON.stringify(result.config.plugins.flat(Infinity).filter(Boolean).map(plugin => plugin.name)));
 `;
 const result = spawnSync(process.execPath, ["--no-experimental-strip-types", "--input-type=module", "-e", script], {cwd:fileURLToPath(new URL(".",import.meta.url)), encoding:"utf8"});
 expect(result.status, result.stderr).toBe(0);
 const plugins = JSON.parse(result.stdout.trim()) as string[];
 if (command === "serve") expect(plugins).toContain("synthetic-device-fixture");
 else expect(plugins).not.toContain("synthetic-device-fixture");
});
