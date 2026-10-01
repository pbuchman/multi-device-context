import { beforeEach, expect, it, vi } from "vitest";
import type { FirebaseApp } from "firebase/app";
import { disableNetwork, enableNetwork } from "firebase/firestore";
import { FirebaseCloud } from "./cloud.js";

vi.mock("firebase/firestore", async importOriginal => ({
  ...await importOriginal<typeof import("firebase/firestore")>(),
  initializeFirestore: vi.fn(() => ({})),
  enableNetwork: vi.fn(async () => undefined),
  disableNetwork: vi.fn(async () => undefined),
}));
vi.mock("firebase/storage", async importOriginal => ({
  ...await importOriginal<typeof import("firebase/storage")>(),
  getStorage: vi.fn(() => ({})),
}));
beforeEach(() => { vi.clearAllMocks(); });
const cloud = () => new FirebaseCloud({} as FirebaseApp, "user", async () => "unused");

it("does not re-enable the already-enabled startup connection with active listen targets", async () => {
  const instance = cloud();
  await instance.setNetworkEnabled(true);
  await instance.setNetworkEnabled(true);
  expect(enableNetwork).not.toHaveBeenCalled();
});

it("serializes rapid background/foreground transitions and skips duplicate requests", async () => {
  let finish!: () => void;
  vi.mocked(disableNetwork).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const instance = cloud();
  const background = instance.setNetworkEnabled(false);
  const duplicate = instance.setNetworkEnabled(false);
  const foreground = instance.setNetworkEnabled(true);
  await vi.waitFor(() => expect(disableNetwork).toHaveBeenCalledTimes(1));
  expect(enableNetwork).not.toHaveBeenCalled();
  finish();
  await Promise.all([background, duplicate, foreground]);
  expect(disableNetwork).toHaveBeenCalledTimes(1);
  expect(enableNetwork).toHaveBeenCalledTimes(1);
});

it("allows a failed transition to be retried without falsely changing network state", async () => {
  vi.mocked(disableNetwork).mockRejectedValueOnce(new Error("temporarily unavailable"));
  const instance = cloud();
  await expect(instance.setNetworkEnabled(false)).rejects.toThrow("temporarily unavailable");
  await instance.setNetworkEnabled(false);
  await instance.setNetworkEnabled(true);
  expect(disableNetwork).toHaveBeenCalledTimes(2);
  expect(enableNetwork).toHaveBeenCalledTimes(1);
});
