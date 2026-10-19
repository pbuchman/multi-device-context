import { describe, expect, expectTypeOf, it } from "vitest";
import { AccessDeviceSchema, ContextOriginSchema, ContextOriginsRequestSchema, ContextOriginsResponseSchema, type ContextOrigin } from "./index.js";

const id = "00000000-0000-4000-8000-000000000001";

describe("context origin metadata contract", () => {
  it("accepts bounded UUID requests and permits duplicate or empty IDs", () => {
    expect(ContextOriginsRequestSchema.parse({ contextIds: [] })).toEqual({ contextIds: [] });
    expect(ContextOriginsRequestSchema.parse({ contextIds: [id, id] })).toEqual({ contextIds: [id, id] });
    expect(ContextOriginsRequestSchema.safeParse({ contextIds: Array(100).fill(id) }).success).toBe(true);
    for (const input of [{}, { contextIds: id }, { contextIds: ["invalid"] }, { contextIds: Array(101).fill(id) }, { contextIds: [id], uid: "other" }, { contextIds: [id], colorIndex: 1 }]) {
      expect(ContextOriginsRequestSchema.safeParse(input).success).toBe(false);
    }
  });

  it("exposes strict origin records with eight palette indices", () => {
    expectTypeOf<ContextOrigin>().toEqualTypeOf<{ id: string; name: string; colorIndex: number }>();
    for (let colorIndex = 0; colorIndex < 8; colorIndex++) {
      const record = { id, name: "Radio", colorIndex };
      expect(ContextOriginSchema.parse(record)).toEqual(record);
      expect(ContextOriginsResponseSchema.parse({ records: [record] })).toEqual({ records: [record] });
    }
    for (const input of [{ id, name: "", colorIndex: 0 }, { id, name: "a".repeat(81), colorIndex: 0 }, { id: "bad", name: "Radio", colorIndex: 0 }, ...[-1, 8, 1.5, "1", null].map(colorIndex => ({ id, name: "Radio", colorIndex })), { id, name: "Radio", colorIndex: 0, mode: "all" }]) {
      expect(ContextOriginSchema.safeParse(input).success).toBe(false);
    }
    expect(ContextOriginsResponseSchema.safeParse({ records: [], more: true }).success).toBe(false);
    expect(ContextOriginsResponseSchema.safeParse({ records: Array(101).fill({ id, name: "Radio", colorIndex: 0 }) }).success).toBe(false);
    // Color metadata must never become part of a public self-policy document.
    expect(AccessDeviceSchema.safeParse({ id, name: "Radio", platform: "android", mode: "own", version: 1, createdAt: 1, updatedAt: 1, colorIndex: 0 }).success).toBe(false);
  });
});
