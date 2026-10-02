// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
const constructed=vi.hoisted(()=>vi.fn());
vi.mock("./auth.js",()=>({SessionManager: class { constructor(){constructed();}prepare=async()=>{};restore=async()=>undefined; }}));
vi.mock("./AccessPage.js",()=>({AccessPage:()=>"Independent access panel"}));
import App from "./App.js";
afterEach(()=>{cleanup();history.replaceState({},"","/");sessionStorage.clear();vi.clearAllMocks();});
it("opens administration without constructing a workspace session or installation",()=>{
 history.replaceState({},"","/access");render(<App/>);
 expect(screen.getByText("Independent access panel")).toBeTruthy();expect(constructed).not.toHaveBeenCalled();
});
it("routes a marked Auth0 administration callback away from workspace enrollment",()=>{
 sessionStorage.setItem("mdc:access-return","/access");history.replaceState({},"","/auth/callback?code=code&state=state");render(<App/>);
 expect(screen.getByText("Independent access panel")).toBeTruthy();expect(constructed).not.toHaveBeenCalled();
});
