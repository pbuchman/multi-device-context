import { readFile } from "node:fs/promises";
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";
import { afterAll, beforeAll, describe, it } from "vitest";
import { emulatorAddress } from "./emulator-address.js";

const uid = "context-origin-rule-owner", id = "00000000-0000-4000-8000-000000000011";
let env: RulesTestEnvironment;
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-mdc", firestore: { ...emulatorAddress(process.env.FIRESTORE_EMULATOR_HOST), rules: await readFile("infra/firestore.rules", "utf8") } });
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, `users/${uid}/devices/${id}`), { mode: "all", version: 1 });
    await setDoc(doc(db, `internalContextOriginAccounts/${uid}`), { counts: [1, 0, 0, 0, 0, 0, 0, 0] });
    await setDoc(doc(db, `internalContextOriginAccounts/${uid}/origins/${id}`), { colorIndex: 0 });
  });
});
afterAll(async () => { await env.cleanup(); });

describe("private context-origin palette metadata", () => {
  it("denies direct reads and writes to clients, including an owner installation with full access", async () => {
    for (const context of [env.authenticatedContext(uid, { mdcDeviceId: id }), env.authenticatedContext(uid), env.authenticatedContext("other", { mdcDeviceId: id }), env.unauthenticatedContext()]) {
      const db = context.firestore(), account = doc(db, `internalContextOriginAccounts/${uid}`), origin = doc(db, `internalContextOriginAccounts/${uid}/origins/${id}`);
      await assertFails(getDoc(account));
      await assertFails(getDoc(origin));
      await assertFails(getDocs(collection(db, `internalContextOriginAccounts/${uid}/origins`)));
      await assertFails(setDoc(account, { counts: [0, 0, 0, 0, 0, 0, 0, 0] }));
      await assertFails(updateDoc(origin, { colorIndex: 7 }));
      await assertFails(setDoc(doc(db, `internalContextOriginAccounts/${uid}/origins/00000000-0000-4000-8000-000000000012`), { colorIndex: 2 }));
    }
  });
});
