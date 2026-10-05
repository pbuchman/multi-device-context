import { build } from "esbuild";
import { cp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const value = process.env.MDC_APP_ORIGIN;
let origin;
try {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error();
  origin = url.origin;
} catch {
  throw new Error(
    "Set MDC_APP_ORIGIN to the trusted HTTPS application origin before building.",
  );
}
await mkdir("dist", { recursive: true });
for (const name of ["main", "preload"])
  await build({
    entryPoints: [`src/${name}.ts`],
    outfile: `dist/${name}.cjs`,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    define: { MDC_APP_ORIGIN: JSON.stringify(origin) },
    sourcemap: false,
    minify: false,
  });
await cp("resources", "dist/resources", { recursive: true });
await writeFile(
  "dist/build-info.json",
  JSON.stringify({ appOrigin: origin, bridgeVersion: 1 }, null, 2) + "\n",
);

// electron-builder must not discover the monorepo's root production dependencies.
await rm("bundle", { recursive: true, force: true });
await mkdir("bundle", { recursive: true });
await cp("dist", "bundle/dist", { recursive: true });
const metadata = JSON.parse(await readFile("package.json", "utf8"));
const { devDependencies, dependencies, scripts, ...manifest } = metadata;
await writeFile("bundle/package.json", JSON.stringify(manifest, null, 2) + "\n");
await cp("../../LICENSE", "bundle/LICENSE");
const packageFiles = [
  createRequire(import.meta.url).resolve("jose/package.json"),
  join(process.cwd(), "../../packages/contracts/node_modules/zod/package.json"),
  createRequire(import.meta.url).resolve("electron-updater/package.json"),
];
const packages = new Map();
const queue = [...packageFiles];
while (queue.length) {
  const packageFile = queue.shift();
  const packageMetadata = JSON.parse(await readFile(packageFile, "utf8"));
  const key = `${packageMetadata.name}@${packageMetadata.version}`;
  if (packages.has(key)) continue;
  const directory = dirname(packageFile);
  let licenseText;
  for (const candidate of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md"]) {
    try { licenseText = await readFile(join(directory, candidate), "utf8"); break; } catch {}
  }
  if (!licenseText && packageMetadata.license === "MIT") licenseText = await readFile("../../LICENSE", "utf8");
  if (!licenseText) throw new Error(`No bundled license text found for ${key}`);
  packages.set(key, `${key} (${packageMetadata.license ?? "license in package"})\n${licenseText.trim()}\n`);
  const nestedRequire = createRequire(packageFile);
  for (const dependency of Object.keys(packageMetadata.dependencies ?? {}))
    queue.push(nestedRequire.resolve(`${dependency}/package.json`));
}
await writeFile(
  "bundle/THIRD_PARTY_NOTICES.txt",
  [...packages].sort(([left], [right]) => left.localeCompare(right)).map(([, notice]) => notice).join("\n"),
);
