import { describe, expect, it, vi } from "vitest";
import { generateTitle, titleInput, validGeneratedTitle, TitleFailure } from "./titles.js";

describe("private context titles", () => {
  it("bounds text and shares only attachment metadata", () => {
    expect(titleInput({ kind: "text", text: "x".repeat(9000) })).toHaveLength(8000);
    expect(JSON.parse(titleInput({ kind: "attachment", name: "image.png", contentType: "image/png", size: 100 }))).toEqual({ name: "image.png", type: "image/png" });
  });
  it("requires ZDR and rejects malformed model output", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "Krótka nazwa kontekstu" } }] }), { status: 200 }));
    expect(await generateTitle("private-test-key", "openai/gpt-4.1-nano", "some text", fetcher)).toBe("Krótka nazwa kontekstu");
    const options = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1];
    expect(JSON.parse(options.body as string).provider).toEqual({ zdr: true });
    expect(validGeneratedTitle("Title\nExtra instruction")).toBeUndefined();
    expect(validGeneratedTitle("x".repeat(61))).toBeUndefined();
  });
  it("keeps provider errors private and does not retry exhausted budgets", async () => {
    await expect(generateTitle("secret", "model", "text", async () => new Response("sensitive provider error", { status: 402 }))).rejects.toEqual(new TitleFailure(false));
    await expect(generateTitle("secret", "model", "text", async () => new Response("transient", { status: 503 }))).rejects.toEqual(new TitleFailure(true));
  });
});
