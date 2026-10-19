import { AccessDeviceSchema } from "@mdc/contracts";
import { AccessPanel } from "./AccessPage.js";
import { AccessClient } from "./access-client.js";
import { DurableOutbox } from "./outbox.js";
import { AccountProfileStore, ProfileLoadError } from "./account-profile.js";
import type { Content, Id } from "@mdc/contracts";
import { createRoot } from "react-dom/client";

import { ContextWorkspace, type WorkspaceServices } from "./App.js";
import type { CloudSnapshot } from "./cloud.js";
import type { ContextRecord, ItemRecord } from "./model.js";

const deviceNames = new URLSearchParams(window.location.search).has("deviceNames");
const fixtureRequest = async (path: string, init?: RequestInit) => {
 const response = await fetch(`/__e2e/api${path}`, init);
 if (!response.ok) throw new Error("Synthetic API request failed");
 return response;
};
const pins = new URLSearchParams(window.location.search).has("pins");
const showcase = new URLSearchParams(window.location.search).has("showcase");
const ids = {
  website: "00000000-0000-4000-8000-000000000001" as Id,
  commands: "00000000-0000-4000-8000-000000000002" as Id,
  weekend: "00000000-0000-4000-8000-000000000003" as Id,
  design: "00000000-0000-4000-8000-000000000004" as Id,
  notes: "00000000-0000-4000-8000-000000000005" as Id,
};
const dell = { id: "00000000-0000-4000-8000-000000000010" as Id, name: "Dell Pro" };
const mac = { id: "00000000-0000-4000-8000-000000000011" as Id, name: "MacBook Pro" };
const now = Date.now();
const browser = { id: "00000000-0000-4000-8000-000000000012" as Id, name: "Web browser" };
let contexts: ContextRecord[] = showcase ? [
  { id: ids.notes, title: "Project notes", createdAt: now - 800_000, updatedAt: now - 40_000, syncState: "synced" },
  { id: ids.weekend, title: "Weekend trip", createdAt: now - 600_000, updatedAt: now - 160_000, syncState: "synced" },
  { id: ids.design, title: "Design references", createdAt: now - 700_000, updatedAt: now - 280_000, syncState: "synced" },
] : [
  { id: ids.website, title: "Website handoff", createdAt: now - 400_000, updatedAt: now - 60_000, syncState: "synced" },
  { id: ids.commands, title: "Useful commands", createdAt: now - 500_000, updatedAt: now - 180_000, syncState: "synced" },
  { id: ids.weekend, title: "Weekend ideas", createdAt: now - 600_000, updatedAt: now - 280_000, syncState: "synced" },
  { id: ids.design, title: "Design references", createdAt: now - 700_000, updatedAt: now - 380_000, syncState: "synced" },
  { id: ids.notes, title: "Meeting notes", createdAt: now - 800_000, updatedAt: now - 480_000, syncState: "synced" },
];
if (pins) contexts = contexts.map((context, index) => ({ ...context, title: index === 1 ? "Pinned chat with a very long title to inspect the narrow sidebar" : context.title, pinnedAt: index === 1 ? now - 10_000 : null }));
let pinGate = Promise.resolve();
let finishPin: (() => void) | undefined;
let failNextPin = false;
const item = (id: string, contextId: Id, content: Content, device = dell, age = 100_000): ItemRecord => ({
  id: id as Id, contextId, content, device, createdAt: now - age, ready: true, syncState: "synced",
});
const items = new Map<Id, ItemRecord[]>(showcase ? [
  [ids.notes, [
    item("50000000-0000-4000-8000-000000000001", ids.notes, { kind: "text", text: "Handoff checklist\n• Confirm the launch copy\n• Review the mobile spacing" }, dell, 360_000),
    item("50000000-0000-4000-8000-000000000002", ids.notes, { kind: "code", text: "const handoff = await context.pickUp(\"MacBook Pro\");\nawait handoff.continue();" }, dell, 280_000),
    item("50000000-0000-4000-8000-000000000003", ids.notes, { kind: "text", text: "https://docs.example.com/project-brief" }, browser, 180_000),
    item("50000000-0000-4000-8000-000000000004", ids.notes, { kind: "attachment", name: "project-brief.pdf", contentType: "application/pdf", size: 2_482_176 }, mac, 80_000),
  ]],
  [ids.weekend, [
    item("30000000-0000-4000-8000-000000000001", ids.weekend, { kind: "text", text: "Train leaves Saturday at 08:12. Meet by the main entrance at 07:55." }, mac, 320_000),
    item("30000000-0000-4000-8000-000000000002", ids.weekend, { kind: "text", text: "https://maps.example.com/riverside-trail" }, browser, 220_000),
    item("30000000-0000-4000-8000-000000000003", ids.weekend, { kind: "attachment", name: "weekend-packing-list.txt", contentType: "text/plain", size: 1_834 }, dell, 120_000),
  ]],
  [ids.design, [
    item("40000000-0000-4000-8000-000000000001", ids.design, { kind: "text", text: "Direction: calm surfaces, generous spacing, and one clear action per screen." }, dell, 200_000),
    item("40000000-0000-4000-8000-000000000002", ids.design, { kind: "attachment", name: "calm-workspace-board.png", contentType: "image/png", size: 118_640 }, mac, 100_000),
  ]],
] : [
  [ids.website, [
    item("10000000-0000-4000-8000-000000000001", ids.website, { kind: "text", text: "Here’s the layout I was working on. Picking this up on the Mac." }, dell, 180_000),
    item("10000000-0000-4000-8000-000000000002", ids.website, { kind: "code", text: "const context = {\n  title: \"Website handoff\",\n  devices: [\"Dell Pro\", \"MacBook Pro\"]\n};" }, dell, 120_000),
    item("10000000-0000-4000-8000-000000000003", ids.website, { kind: "attachment", name: "homepage-layout.png", contentType: "image/png", size: 68 }, mac, 60_000),
  ]],
  [ids.commands, [item("20000000-0000-4000-8000-000000000001", ids.commands, { kind: "code", text: "git status\ngit log --oneline -5" }, mac)]],
]);
let contextListener: ((snapshot: CloudSnapshot<ContextRecord>) => void) | undefined;
const itemListeners = new Map<Id, (snapshot: CloudSnapshot<ItemRecord>) => void>();
const emitContexts = () => contextListener?.({ records: contexts, fromCache: false, hasPendingWrites: false });
const emitItems = (contextId: Id) => itemListeners.get(contextId)?.({ records: items.get(contextId) ?? [], fromCache: false, hasPendingWrites: false });
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
const avatarUrl = showcase ? undefined : "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const viewerName = showcase ? "Alex Demo" : "Alex";

let illustration: Promise<Uint8Array> | undefined;
function illustrationBytes(): Promise<Uint8Array> {
  illustration ??= new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200; canvas.height = 720;
    const context = canvas.getContext("2d");
    if (!context) { reject(new Error("Canvas is unavailable")); return; }
    context.fillStyle = "#eef3ea"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#d3e4ce"; context.beginPath(); context.arc(1050, 92, 220, 0, Math.PI * 2); context.fill();
    context.fillStyle = "#f9fbf7"; context.beginPath(); context.roundRect(76, 68, 1048, 584, 32); context.fill();
    context.strokeStyle = "#c5d1c2"; context.lineWidth = 3; context.stroke();
    context.fillStyle = "#26352a"; context.font = "700 38px system-ui, sans-serif"; context.fillText("Calm workspace", 126, 142);
    context.fillStyle = "#6a776b"; context.font = "22px system-ui, sans-serif"; context.fillText("A small visual board for the next handoff", 126, 180);
    const card = (x: number, y: number, width: number, height: number, color: string) => {
      context.fillStyle = color; context.beginPath(); context.roundRect(x, y, width, height, 24); context.fill();
    };
    card(126, 232, 276, 318, "#e2eee0");
    card(438, 232, 276, 318, "#f1e9d8");
    card(750, 232, 276, 318, "#dde7ed");
    context.fillStyle = "#52745a"; context.beginPath(); context.arc(264, 348, 68, 0, Math.PI * 2); context.fill();
    context.strokeStyle = "#f8fbf6"; context.lineWidth = 10; context.beginPath(); context.moveTo(224, 350); context.lineTo(252, 378); context.lineTo(309, 315); context.stroke();
    context.fillStyle = "#26352a"; context.font = "650 25px system-ui, sans-serif"; context.fillText("Collect", 202, 473);
    context.fillStyle = "#9b7848"; context.beginPath(); context.roundRect(493, 294, 166, 112, 18); context.fill();
    context.fillStyle = "#f7f1e6"; context.font = "700 20px ui-monospace, monospace"; context.fillText("{ context }", 511, 359);
    context.fillStyle = "#26352a"; context.font = "650 25px system-ui, sans-serif"; context.fillText("Continue", 520, 473);
    context.strokeStyle = "#507188"; context.lineWidth = 12; context.lineCap = "round";
    context.beginPath(); context.moveTo(818, 382); context.bezierCurveTo(850, 298, 925, 438, 962, 324); context.stroke();
    context.fillStyle = "#26352a"; context.font = "650 25px system-ui, sans-serif"; context.fillText("Share", 858, 473);
    context.fillStyle = "#758176"; context.font = "18px system-ui, sans-serif"; context.fillText("DEMO ARTWORK · FICTIONAL CONTENT", 126, 606);
    canvas.toBlob(blob => {
      if (!blob) { reject(new Error("Could not render the demo illustration")); return; }
      void blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)), reject);
    }, "image/png");
  });
  return illustration;
}

let refreshGate = Promise.resolve();
let finishRefresh: (() => void) | undefined;
Object.assign(window, { mdcRefreshTest: {
  pause() { refreshGate = new Promise<void>(resolve => { finishRefresh = resolve; }); },
  finish() { finishRefresh?.(); },
} });
let profileFailure = false;
const profile = new AccountProfileStore("browser-test", async () => {
  if (profileFailure) { profileFailure = false; throw new ProfileLoadError("Account provider test failure", false); }
  return { name: viewerName, email: "alex@example.com", avatarUrl };
}, () => true);
void profile.refresh();
let deleteGate = Promise.resolve();let finishDelete: (() => void) | undefined;
Object.assign(window, {
  mdcPinTest: {
    records() { return contexts; },
    remote(contextId: string, pinnedAt: number | null) { contexts = contexts.map(context => context.id === contextId ? { ...context, pinnedAt } : context); emitContexts(); },
    pause() { pinGate = new Promise<void>(resolve => { finishPin = resolve; }); },
    finish() { finishPin?.(); },
    failNext() { failNextPin = true; },
  },
  mdcProfileTest: { async fail() { profileFailure = true; await profile.refresh(); } },
  mdcDeletionTest: { pause() { deleteGate = new Promise<void>(resolve => { finishDelete = resolve; }); }, finish() { finishDelete?.(); } },
});
let currentDevice = { ...dell };
const deviceListeners = new Set<(device: typeof dell) => void>();
const fixtureOutbox = deviceNames ? new DurableOutbox({ projectId: "device-name-fixture", uid: "browser-test" }) : undefined;
const readFixtureDevice = async () => {
 const value = AccessDeviceSchema.parse(await (await fixtureRequest("/device")).json());
 currentDevice = { id: value.id, name: value.name };
 for (const listener of deviceListeners) listener(currentDevice);
 return currentDevice;
};
Object.assign(window, { mdcDeviceTest: {
 async failNext() { await fixtureRequest("/fail-next", { method: "POST" }); },
 async refresh() { return readFixtureDevice(); },
 async reset() { await fixtureRequest("/reset", { method: "POST" }); await fixtureOutbox?.clear(); return readFixtureDevice(); },
 async queued() { return fixtureOutbox?.list() ?? []; },
} });
const services: WorkspaceServices = {
  profile,
  viewer: { uid: "browser-test", name: viewerName, email: "alex@example.com", ...(avatarUrl ? { avatarUrl } : {}) },
  get device() { return currentDevice; },
  ...(deviceNames ? {
    subscribeDevice(listener: (device: typeof dell) => void) { deviceListeners.add(listener); return () => { deviceListeners.delete(listener); }; },
    async renameDevice(name: string) {
      const value = AccessDeviceSchema.parse(await (await fixtureRequest("/device", {method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({name})})).json());
      currentDevice = {id:value.id,name:value.name};for(const listener of deviceListeners)listener(currentDevice);return currentDevice;
    },
    accessMode: "all" as const,
    async openAccessPanel() { window.open("/e2e.html?deviceNames&access", "_blank", "noopener,noreferrer"); },
  } : {}),
  cloud: {
    async refreshContexts() { await refreshGate; return { records: contexts, fromCache: false, hasPendingWrites: false }; },
    async refreshDeletedContexts() { return []; },
    async refreshDeletedItems() { return []; },
    async refreshItems(contextId) { return { records: items.get(contextId) ?? [], fromCache: false, hasPendingWrites: false }; },
    subscribeDeletedContexts(emit) { queueMicrotask(() => emit([])); return () => {}; },
    subscribeDeletedItems(emit) { queueMicrotask(() => emit([])); return () => {}; },
    subscribeContexts(emit) { contextListener = emit; queueMicrotask(emitContexts); return () => { contextListener = undefined; }; },
    subscribeItems(contextId, emit) { itemListeners.set(contextId, emit); queueMicrotask(() => emitItems(contextId)); return () => itemListeners.delete(contextId); },
    async setContextPinned(contextId, pinned) {
      await pinGate;
      if (navigator.onLine === false) throw new Error("Go online to pin or unpin chats");
      if (failNextPin) { failNextPin = false; throw new Error("Synthetic pin write failed"); }
      if (!contexts.some(context => context.id === contextId)) throw new Error("This chat is unavailable");
      contexts = contexts.map(context => context.id === contextId ? { ...context, pinnedAt: pinned ? context.pinnedAt ?? Date.now() : null } : context);
      emitContexts();
    },
    async renameContext(contextId, title) { contexts = contexts.map((context) => context.id === contextId ? { ...context, title } : context); emitContexts(); },
    async deleteContext(contextId) { await deleteGate; contexts = contexts.filter((context) => context.id !== contextId); items.delete(contextId); emitContexts(); },
    async deleteItem(contextId, itemId) { items.set(contextId, (items.get(contextId) ?? []).filter((entry) => entry.id !== itemId)); emitItems(contextId); },
    async attachmentBytes(_contextId, _itemId, content) { return showcase && content.name === "calm-workspace-board.png" ? illustrationBytes() : png; },
  },
  outbox: fixtureOutbox ?? { namespace: "browser-test:browser-test", async enqueue() {}, async count() { return 0; }, async clear() {}, async retry() {}, async list() { return []; } },
  async drain() {},
  async copyText() {},
  async copyFile() {},
  async saveFile() { return true; },
  async signOut() {},
};

async function renderFixture() {
 if (deviceNames) await readFixtureDevice();
 const access = deviceNames && new URLSearchParams(window.location.search).has("access");
 const accessClient = new AccessClient(async () => "synthetic-fixture", (input, init) => fetch(String(input).replace("/api/", "/__e2e/api/"), init), { authenticate: async () => ({ id: "synthetic-passkey" }) as never, register: async () => ({}) as never });
 createRoot(document.getElementById("root")!).render(access ? <AccessPanel client={accessClient} account="Synthetic fixture · no real account" /> : <ContextWorkspace services={services} />);
}
void renderFixture();
