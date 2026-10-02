// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useTimelineScroll } from "./use-timeline-scroll.js";
const alpha = "00000000-0000-4000-8000-000000000001", beta = "00000000-0000-4000-8000-000000000002";
const ids = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`);
function Timeline({ id, items }: { id: string; items: string[] }) {
  const scroll = useTimelineScroll(id, items);
  return <section data-testid="timeline" ref={element => {
    scroll.viewport.current = element;
    if (element) {
      Object.defineProperty(element, "clientHeight", { configurable: true, value: 100 });
      Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => Math.max(100, element.querySelectorAll("article").length * 100) });
      element.getBoundingClientRect = () => ({ top: 0, bottom: 100 } as DOMRect);
    }
  }}><div ref={scroll.content}>{items.map((item, index) => <article key={item} data-item-id={item} ref={element => {
    if (element) element.getBoundingClientRect = () => ({ top: index * 100 - (scroll.viewport.current?.scrollTop ?? 0), bottom: (index + 1) * 100 - (scroll.viewport.current?.scrollTop ?? 0) } as DOMRect);
  }}>{item}</article>)}</div><button hidden={!scroll.newMessages} onClick={() => scroll.scrollToBottom()}>New messages</button></section>;
}
afterEach(cleanup);
it("preserves a history anchor across a returning chat's temporarily empty listener snapshot and collapse scroll event", () => {
  const view = render(<Timeline id={alpha} items={ids} />);
  const element = view.getByTestId("timeline");
  expect(element.scrollTop).toBe(900);
  element.scrollTop = 200; fireEvent.scroll(element);
  view.rerender(<Timeline id={beta} items={ids.slice(0, 2)} />);
  view.rerender(<Timeline id={alpha} items={[]} />);
  element.scrollTop = 0; fireEvent.scroll(element);
  view.rerender(<Timeline id={alpha} items={ids} />);
  expect(element.scrollTop).toBe(200);
});
