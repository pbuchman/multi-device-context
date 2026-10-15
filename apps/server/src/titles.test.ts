import { afterEach, describe, expect, it, vi } from "vitest";
import { generateTitle, titleInput, titleSource, validGeneratedTitle, TitleFailure } from "./titles.js";

afterEach(() => vi.restoreAllMocks());

describe("private context titles", () => {
  it("bounds text and shares only attachment metadata", () => {
    expect(titleInput({ kind: "text", text: "x".repeat(9000) })).toHaveLength(8000);
    expect(JSON.parse(titleInput({ kind: "attachment", name: "image.png", contentType: "image/png", size: 100 }))).toEqual({ name: "image.png", type: "image/png" });
  });
  it("uses explicit caching and no reasoning or temperature for GPT-6 Luna", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "Krótka nazwa kontekstu" } }] }), { status: 200 }));
    expect(await generateTitle("private-test-key", "openai/gpt-6-luna", "some text", fetcher)).toBe("Krótka nazwa kontekstu");
    const options = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1];
    const request = JSON.parse(options.body as string);
    expect(request).toEqual({
      model: "openai/gpt-6-luna", provider: { zdr: true }, max_tokens: 80,
      reasoning: { effort: "none" }, prompt_cache_options: { mode: "explicit" },
      messages: [{ role: "system", content: expect.any(String) }, { role: "user", content: "some text" }],
    });
    expect(request.messages[0].content).toContain("2–6 words, at most 60 characters");
    expect(timeout).toHaveBeenCalledWith(8000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(["openai/gpt-4.1-nano", "openai/gpt-6-luna:free", "another/model"])("preserves the original request policy for override %s", async model => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "Override model title" } }] })));
    await expect(generateTitle("private-test-key", model, "some text", fetcher)).resolves.toBe("Override model title");
    const options = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1];
    expect(JSON.parse(options.body as string)).toEqual({
      model, provider: { zdr: true }, max_tokens: 80, temperature: 0.2,
      messages: [{ role: "system", content: expect.any(String) }, { role: "user", content: "some text" }],
    });
  });
  it("rejects titles outside the plain short title limits", () => {
    expect(validGeneratedTitle("Title\nExtra instruction")).toBeUndefined();
    expect(validGeneratedTitle("x".repeat(61))).toBeUndefined();
    expect(validGeneratedTitle("One")).toBeUndefined();
    expect(validGeneratedTitle("one two three four five six seven")).toBeUndefined();
  });
  it("sends bounded image input and requires an English fallback when its language is unclear", async () => {
    const source = titleSource(
      { kind: "attachment", name: "screenshot.png", contentType: "image/png", size: 4 },
      new Uint8Array([137, 80, 78, 71]),
    );
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "Polski raport wdrożenia" } }] }), { status: 200 }));
    await expect(generateTitle("private-test-key", "openai/gpt-6-luna", source, fetcher)).resolves.toBe("Polski raport wdrożenia");
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
  it.each(["", "   ", "One", "Title\nCommentary", { title: "Malformed title" }, null])("rejects empty or malformed title content %j without retrying", async content => {
    await expect(generateTitle("private-test-key", "openai/gpt-6-luna", "text", async () => new Response(JSON.stringify({ choices: [{ message: { content } }] })))).rejects.toEqual(new TitleFailure(false));
  });
  it.each(["not JSON", "{}", '{"choices":[]}'])("rejects malformed provider output %s without retrying", async output => {
    await expect(generateTitle("private-test-key", "openai/gpt-6-luna", "text", async () => new Response(output))).rejects.toEqual(new TitleFailure(false));
  });
  it("retries a timed-out provider request without exposing its error", async () => {
    await expect(generateTitle("private-test-key", "openai/gpt-6-luna", "text", async () => {
      throw new DOMException("sensitive provider timeout", "TimeoutError");
    })).rejects.toEqual(new TitleFailure(true));
  });
  it.each([[402, false], [429, true], [500, true], [503, true]] as const)("keeps HTTP %i provider errors private with retryable=%s", async (status, retryable) => {
    await expect(generateTitle("private-test-key", "openai/gpt-6-luna", "text", async () => new Response("sensitive provider error", { status }))).rejects.toEqual(new TitleFailure(retryable));
  });
});
