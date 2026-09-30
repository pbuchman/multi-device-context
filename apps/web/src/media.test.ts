import { expect, it, vi } from "vitest";
import { dayLabel, fileParts } from "./media.js";
it("R6: rejects oversize and aggregate oversize before reading bytes", async () => {
  const file = new File(["x"], "sample.bin"); const arrayBuffer = vi.fn(async () => new ArrayBuffer(1)); Object.defineProperty(file, "arrayBuffer", { value: arrayBuffer });
  Object.defineProperty(file, "size", { value: 101 * 1024 * 1024, configurable: true });
  await expect(fileParts([file])).rejects.toThrow("100 MiB"); expect(arrayBuffer).not.toHaveBeenCalled();
  Object.defineProperty(file, "size", { value: 60 * 1024 * 1024 });
  await expect(fileParts([file, file])).rejects.toThrow("100 MiB"); expect(arrayBuffer).not.toHaveBeenCalled();
});
it("P3: date groups use local calendar days across midnight", () => {
  const now = new Date(2026, 9, 1, 0, 1);
  expect(dayLabel(new Date(2026, 9, 1).getTime(), now)).toBe("Today");
  expect(dayLabel(new Date(2026, 8, 30, 23, 59).getTime(), now)).toBe("Yesterday");
  expect(dayLabel(new Date(2026, 8, 29).getTime(), now)).not.toMatch(/Today|Yesterday/);
});
