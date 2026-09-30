import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CopiedFiles } from "./copied-files.js";
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
it("keeps current clipboard exports and removes expired app-owned copies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdc-copies-"));
  folders.push(directory);
  const copies = await CopiedFiles.open(directory);
  const file = {
    name: "CON.txt",
    contentType: "text/plain",
    bytes: new Uint8Array([0, 255, 10]),
  };
  const first = await copies.write(file),
    second = await copies.write(file);
  expect(await readFile(first)).toEqual(Buffer.from(file.bytes));
  expect(first.endsWith("_CON.txt")).toBe(true);
  const old = new Date(Date.now() - 2 * 86400000);
  await utimes(first, old, old);
  await utimes(second, old, old);
  await copies.prune(new Set([first]));
  expect(await readFile(first)).toEqual(Buffer.from(file.bytes));
  await expect(readFile(second)).rejects.toThrow();
  await copies.clear();
  await expect(readFile(first)).rejects.toThrow();
});
