import { test } from "node:test";
import assert from "node:assert/strict";
import { planPhoneOriginRemap, applyPhoneOriginRemap } from "./remap-phone-origin.mjs";
const oldDevice = "00000000-0000-4000-8000-000000000010", newDevice = "00000000-0000-4000-8000-000000000011", id = "00000000-0000-4000-8000-000000000012";
function fixture() {
  const records = new Map([[`users/owner/devices/${newDevice}`, { platform: "android" }], [`users/owner/contexts/${id}`, { title: "Keep private", originDeviceId: oldDevice, deleting: false }]]);
  const ref = path => ({ path, id: path.split("/").at(-1), get: async () => ({ exists: records.has(path), data: () => records.get(path) }) });
  const db = { doc: ref, collection: () => ({ where: (_field, _op, expected) => ({ get: async () => ({ docs: [...records].filter(([path, data]) => path.includes("/contexts/") && data.originDeviceId === expected).map(([path, data]) => ({ id: path.split("/").at(-1), data: () => data })) }) }) }), runTransaction: async fn => fn({ get: reference => reference.get(), update: (reference, change) => records.set(reference.path, { ...records.get(reference.path), ...change }) }) };
  return { db, records, input: { uid: "owner", oldDevice, newDevice } };
}
test("dry run selects exact old phone origin without changing data or exposing content", async () => {
  const f = fixture(); const plan = await planPhoneOriginRemap(f.db, f.input);
  assert.deepEqual(plan.contextIds, [id]); assert.equal(f.records.get(`users/owner/contexts/${id}`).originDeviceId, oldDevice);
  assert.ok(!JSON.stringify(plan).includes("Keep private"));
});
test("apply changes only origin and refuses a context changed since the reviewed plan", async () => {
  const f = fixture(); const plan = await planPhoneOriginRemap(f.db, f.input); const audit = [];
  await applyPhoneOriginRemap(f.db, plan, async value => audit.push(value));
  assert.deepEqual(f.records.get(`users/owner/contexts/${id}`), { title: "Keep private", originDeviceId: newDevice, deleting: false });
  assert.deepEqual(audit, [id]);
  const changed = fixture(); const otherPlan = await planPhoneOriginRemap(changed.db, changed.input);
  changed.records.set(`users/owner/contexts/${id}`, { originDeviceId: "changed" });
  await assert.rejects(applyPhoneOriginRemap(changed.db, otherPlan, async () => {}), /changed/);
});
test("rejects missing/wrong target installation and never adopts the reserved Agent identity", async () => {
  const f = fixture(); f.records.set(`users/owner/devices/${newDevice}`, { platform: "browser" });
  await assert.rejects(planPhoneOriginRemap(f.db, f.input), /Android/);
  await assert.rejects(planPhoneOriginRemap(f.db, { ...f.input, oldDevice: "00000000-0000-4000-8000-000000000002" }), /Agent/);
});
