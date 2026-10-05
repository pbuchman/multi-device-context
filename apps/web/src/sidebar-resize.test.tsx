// @vitest-environment jsdom
import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarResize } from "./sidebar-resize.js";
function Fixture({ accountId = "a", compact = false }: { accountId?: string; compact?: boolean }) {
  const sidebarRef = useRef<HTMLElement>(null);
  return <div><aside ref={sidebarRef} data-testid="sidebar" /><SidebarResize accountId={accountId} compact={compact} sidebarRef={sidebarRef} /></div>;
}
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true }); });
it("supports keyboard bounds, default reset and persistence per account", () => {
  const view = render(<Fixture />); const separator = screen.getByRole("separator");
  expect(screen.getByTestId("sidebar").style.width).toBe("274px");
  fireEvent.keyDown(separator, { key: "ArrowRight" }); expect(separator.getAttribute("aria-valuenow")).toBe("284");
  fireEvent.keyDown(separator, { key: "End" }); expect(screen.getByTestId("sidebar").style.width).toBe("480px");
  view.rerender(<Fixture accountId="b" />); expect(screen.getByTestId("sidebar").style.width).toBe("274px");
  view.rerender(<Fixture />); expect(screen.getByTestId("sidebar").style.width).toBe("480px");
  fireEvent.keyDown(screen.getByRole("separator"), { key: "Home" }); expect(screen.getByTestId("sidebar").style.width).toBe("220px");
  fireEvent.doubleClick(screen.getByRole("separator")); expect(screen.getByTestId("sidebar").style.width).toBe("274px");
  view.unmount(); render(<Fixture />); expect(screen.getByTestId("sidebar").style.width).toBe("274px");
});
it("clamps a smaller container without overwriting the saved preference and hides in compact layout", () => {
  const view = render(<Fixture />); fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
  Object.defineProperty(window, "innerWidth", { value: 800, configurable: true }); fireEvent(window, new Event("resize"));
  expect(screen.getByTestId("sidebar").style.width).toBe("440px");
  view.rerender(<Fixture compact />); expect(screen.queryByRole("separator")).toBeNull(); expect(screen.getByTestId("sidebar").style.width).toBe("");
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true }); fireEvent(window, new Event("resize")); view.rerender(<Fixture />);
  expect(screen.getByTestId("sidebar").style.width).toBe("480px");
});
it("keeps resize working when browser storage is blocked", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
  const view = render(<Fixture accountId="blocked" />); fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
  expect(screen.getByTestId("sidebar").style.width).toBe("264px"); view.unmount(); render(<Fixture accountId="blocked" />);
  expect(screen.getByTestId("sidebar").style.width).toBe("264px");
});
it("persists only completed drags and restores the preference on cancellation", () => {
  class TestPointerEvent extends MouseEvent { pointerId: number; constructor(type: string, options: MouseEventInit & { pointerId?: number } = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; } }
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  const view = render(<Fixture accountId="drag" />); const separator = screen.getByRole("separator");
  separator.setPointerCapture = vi.fn(); separator.releasePointerCapture = vi.fn();
  const saved = vi.spyOn(Storage.prototype, "setItem");
  fireEvent.pointerDown(separator, { button: 0, clientX: 274, pointerId: 1 });
  fireEvent.pointerMove(separator, { clientX: 350, pointerId: 1 });
  expect(screen.getByTestId("sidebar").style.width).toBe("350px"); expect(saved).not.toHaveBeenCalled();
  fireEvent.pointerUp(separator, { pointerId: 1 }); expect(saved).toHaveBeenCalledWith("mdc-sidebar-width:v1:drag", "350");
  fireEvent.pointerDown(separator, { button: 0, clientX: 350, pointerId: 1 }); fireEvent.pointerMove(separator, { clientX: 900, pointerId: 1 });
  expect(screen.getByTestId("sidebar").style.width).toBe("480px"); fireEvent.pointerCancel(separator, { pointerId: 1 });
  expect(screen.getByTestId("sidebar").style.width).toBe("350px"); expect(saved).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(separator, { button: 0, clientX: 350, pointerId: 1 }); fireEvent.pointerMove(separator, { clientX: 230, pointerId: 1 });
  view.rerender(<Fixture accountId="other" />); expect(screen.getByTestId("sidebar").style.width).toBe("274px");
  view.rerender(<Fixture accountId="drag" />); expect(screen.getByTestId("sidebar").style.width).toBe("350px");
  vi.unstubAllGlobals();
});

it("retains session preference when only storage writes fail", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  const view = render(<Fixture accountId="quota" />); fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
  view.unmount(); render(<Fixture accountId="quota" />); expect(screen.getByTestId("sidebar").style.width).toBe("284px");
});

it("leaves the main panel 360px inside a container with safe-area padding", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(840);
  const view = render(<Fixture accountId="safe-area" />);
  const container = screen.getByTestId("sidebar").parentElement!;
  container.style.paddingLeft = "30px"; container.style.paddingRight = "20px";
  fireEvent(window, new Event("resize"));
  fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
  expect(screen.getByTestId("sidebar").style.width).toBe("430px");
  expect(screen.getByRole("separator").getAttribute("aria-valuemax")).toBe("430");
  view.unmount();
});
