import { describe, expect, it, vi } from "vitest";
import { generateTitle, titleInput, titleSource, validGeneratedTitle, TitleFailure } from "./titles.js";

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
  it("sends bounded image input and requires an English fallback when its language is unclear", async () => {
    const source = titleSource(
      { kind: "attachment", name: "screenshot.png", contentType: "image/png", size: 4 },
      new Uint8Array([137, 80, 78, 71]),
    );
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "Polski raport wdrożenia" } }] }), { status: 200 }));
    await expect(generateTitle("private-test-key", "openai/gpt-4.1-nano", source, fetcher)).resolves.toBe("Polski raport wdrożenia");
    const options = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1];
    const request = JSON.parse(options.body as string);
    expect(request.messages[1].content).toEqual([
      { type: "text", text: JSON.stringify({ name: "screenshot.png", type: "image/png" }) },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
    ]);
    expect(request.messages[0].content).toContain("meaningful visible text");
    expect(request.messages[0].content).toContain("use English");
  });
  it("does not attach unsupported or oversized image bytes to a title request", () => {
    expect(titleSource(
      { kind: "attachment", name: "vector.svg", contentType: "image/svg+xml", size: 4 },
      new Uint8Array([1, 2, 3, 4]),
    )).toEqual({ text: JSON.stringify({ name: "vector.svg", type: "image/svg+xml" }) });
    expect(titleSource(
      { kind: "attachment", name: "large.png", contentType: "image/png", size: 5 * 1024 * 1024 + 1 },
      new Uint8Array([1]),
    )).toEqual({ text: JSON.stringify({ name: "large.png", type: "image/png" }) });
  });
  it("keeps provider errors private and does not retry exhausted budgets", async () => {
    await expect(generateTitle("secret", "model", "text", async () => new Response("sensitive provider error", { status: 402 }))).rejects.toEqual(new TitleFailure(false));
    await expect(generateTitle("secret", "model", "text", async () => new Response("transient", { status: 503 }))).rejects.toEqual(new TitleFailure(true));
  });
});
