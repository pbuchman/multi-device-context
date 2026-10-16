// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceNameEditor } from "./device-name-editor.js";
afterEach(cleanup);
function ControlledEditor({ save }: { save(name: string): Promise<string> }) {
 const [name, setName] = useState("Browser");
 return <DeviceNameEditor name={name} onSave={async value => { const persisted = await save(value); setName(persisted); return persisted; }} />;
}
it("saves a trimmed name and displays the persisted response", async () => {
 const save=vi.fn(async()=>"MacBook saved");render(<ControlledEditor save={save} />);
 await userEvent.click(screen.getByRole("button",{name:"Rename device"}));
 const input=screen.getByRole("textbox",{name:"Device name"});await userEvent.clear(input);await userEvent.type(input,"  MacBook  ");
 await userEvent.click(screen.getByRole("button",{name:"Save device name"}));
 expect(save).toHaveBeenCalledWith("MacBook");expect(await screen.findByText("MacBook saved")).toBeTruthy();
});
it("validates names, cancels without saving, and retries a failed save", async()=>{
 const save=vi.fn().mockRejectedValueOnce(new Error("private internal failure")).mockResolvedValue("Renamed");render(<ControlledEditor save={save} />);
 await userEvent.click(screen.getByRole("button",{name:"Rename device"}));
 const input=screen.getByRole("textbox",{name:"Device name"});await userEvent.clear(input);await userEvent.type(input,"   ");await userEvent.click(screen.getByRole("button",{name:"Save device name"}));
 expect(screen.getByRole("alert").textContent).toContain("1–80");expect(save).not.toHaveBeenCalled();
 await userEvent.clear(input);await userEvent.type(input,"Renamed");await userEvent.click(screen.getByRole("button",{name:"Save device name"}));
 expect((await screen.findByRole("alert")).textContent).toContain("Try again");expect(screen.queryByText("private internal failure")).toBeNull();
 await userEvent.click(screen.getByRole("button",{name:"Save device name"}));expect(await screen.findByText("Renamed")).toBeTruthy();
 await userEvent.click(screen.getByRole("button",{name:"Rename device"}));await userEvent.click(screen.getByRole("button",{name:"Cancel"}));expect(save).toHaveBeenCalledTimes(2);
});

it("shows an external name restoration after a local save and uses it when editing", async () => {
 const save = vi.fn(async () => "B");
 const { rerender } = render(<DeviceNameEditor name="A" onSave={save} />);
 await userEvent.click(screen.getByRole("button", { name: "Rename device" }));
 const input = screen.getByRole("textbox", { name: "Device name" });
 await userEvent.clear(input); await userEvent.type(input, "B");
 await userEvent.click(screen.getByRole("button", { name: "Save device name" }));
 await screen.findByRole("button", { name: "Rename device" });
 rerender(<DeviceNameEditor name="B" onSave={save} />);
 expect(screen.getByText("B", { exact: true })).toBeTruthy();
 rerender(<DeviceNameEditor name="A" onSave={save} />);
 expect(screen.getByText("A", { exact: true })).toBeTruthy();
 expect(screen.queryByText("B", { exact: true })).toBeNull();
 await userEvent.click(screen.getByRole("button", { name: "Rename device" }));
 expect((screen.getByRole("textbox", { name: "Device name" }) as HTMLInputElement).value).toBe("A");
});
