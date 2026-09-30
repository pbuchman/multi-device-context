import type { Content, Device, Id, NativeFile } from "@mdc/contracts";

export type SyncState = "cached" | "pending" | "synced" | "failed" | "paused";

export type ContextRecord = {
  id: Id;
  title: string;
  createdAt: number;
  updatedAt: number;
  syncState: SyncState;
  unread?: boolean;
};

export type ItemRecord = {
  id: Id;
  contextId: Id;
  content: Content;
  device: Device;
  createdAt: number;
  ready: boolean;
  syncState: SyncState;
};

export type ShareDraft = {
  contextId: Id;
  itemId: Id;
  title: string;
  content: Content;
  device: Device;
  createsContext: boolean;
  bytes?: Uint8Array;
  nativeRequestId?: Id;
};

export type Viewer = { uid: string; name: string; email?: string };

export type ClipboardContent = { text?: string; files: NativeFile[] };
