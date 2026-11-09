import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Electron recommends a 16 px menu-bar image and a 32 px Retina representation:
// https://www.electronjs.org/docs/latest/api/tray#platform-considerations
it.each([
  ["trayTemplate.png", 16, 72],
  ["trayTemplate@2x.png", 32, 144],
] as const)("ships %s at the compact native size and density", (name, size, dpi) => {
  const png = readFileSync(new URL(`../resources/${name}`, import.meta.url));
  expect(png.subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
  expect(png.toString("ascii", 12, 16)).toBe("IHDR");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
  expect(png[25]).toBe(6); // RGBA preserves the transparent template background.

  let density: number[] | undefined;
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "pHYs") {
      density = [png.readUInt32BE(offset + 8), png.readUInt32BE(offset + 12), png.readUInt8(offset + 16)];
    }
    offset += length + 12;
  }
  const pixelsPerMeter = Math.round(dpi / 0.0254);
  expect(density).toEqual([pixelsPerMeter, pixelsPerMeter, 1]);
});
