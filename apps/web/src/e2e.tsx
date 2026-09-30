import type { Content, Id } from "@mdc/contracts";
import { createRoot } from "react-dom/client";

import { ContextWorkspace, type WorkspaceServices } from "./App.js";
import type { CloudSnapshot } from "./cloud.js";
import type { ContextRecord, ItemRecord } from "./model.js";

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
let contexts: ContextRecord[] = [
  { id: ids.website, title: "Website handoff", createdAt: now - 400_000, updatedAt: now - 60_000, syncState: "synced" },
  { id: ids.commands, title: "Useful commands", createdAt: now - 500_000, updatedAt: now - 180_000, syncState: "synced" },
  { id: ids.weekend, title: "Weekend ideas", createdAt: now - 600_000, updatedAt: now - 280_000, syncState: "synced" },
  { id: ids.design, title: "Design references", createdAt: now - 700_000, updatedAt: now - 380_000, syncState: "synced" },
  { id: ids.notes, title: "Meeting notes", createdAt: now - 800_000, updatedAt: now - 480_000, syncState: "synced" },
];
const item = (id: string, contextId: Id, content: Content, device = dell, age = 100_000): ItemRecord => ({
  id: id as Id, contextId, content, device, createdAt: now - age, ready: true, syncState: "synced",
});
const items = new Map<Id, ItemRecord[]>([
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

const services: WorkspaceServices = {
  viewer: { uid: "browser-test", name: "Alex", email: "alex@example.com" },
  device: dell,
  cloud: {
    subscribeContexts(emit) { contextListener = emit; queueMicrotask(emitContexts); return () => { contextListener = undefined; }; },
    subscribeItems(contextId, emit) { itemListeners.set(contextId, emit); queueMicrotask(() => emitItems(contextId)); return () => itemListeners.delete(contextId); },
    async renameContext(contextId, title) { contexts = contexts.map((context) => context.id === contextId ? { ...context, title } : context); emitContexts(); },
    async deleteContext(contextId) { contexts = contexts.filter((context) => context.id !== contextId); items.delete(contextId); emitContexts(); },
    async deleteItem(contextId, itemId) { items.set(contextId, (items.get(contextId) ?? []).filter((entry) => entry.id !== itemId)); emitItems(contextId); },
    async attachmentBytes() { return png; },
  },
  outbox: { async enqueue() {}, async count() { return 0; }, async clear() {}, async retry() {}, async list() { return []; } },
  async drain() {},
  async copyText() {},
  async copyFile() {},
  async saveFile() { return true; },
  async signOut() {},
};

createRoot(document.getElementById("root")!).render(<ContextWorkspace services={services} />);
