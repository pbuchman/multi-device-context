import { createRequire } from "node:module";
import { readFile, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function validate(input) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.uid ?? "") || !uuid.test(input.oldDevice ?? "") || !uuid.test(input.newDevice ?? "") || input.oldDevice === input.newDevice) throw new Error("Invalid exact phone identity mapping");
  if (input.oldDevice === "00000000-0000-4000-8000-000000000002") throw new Error("Agent origin must not be claimed by a phone");
}
async function target(db, input, transaction) {
  const ref = db.doc(`users/${input.uid}/devices/${input.newDevice}`);
  const snapshot = await (transaction ? transaction.get(ref) : ref.get());
  if (!snapshot.exists || snapshot.data()?.platform !== "android") throw new Error("Target must be the registered Android installation of this account");
}
export async function planPhoneOriginRemap(db, input) {
  validate(input); await target(db, input);
  const snapshot = await db.collection(`users/${input.uid}/contexts`).where("originDeviceId", "==", input.oldDevice).get();
  const contextIds = snapshot.docs.map(doc => doc.id).sort();
  if (contextIds.length > 400) throw new Error("This bounded phone operation supports at most 400 contexts");
  return { uid: input.uid, oldDevice: input.oldDevice, newDevice: input.newDevice, contextIds };
}
export async function applyPhoneOriginRemap(db, plan, recordApplied) {
  validate(plan);
  if (!Array.isArray(plan.contextIds) || plan.contextIds.length > 400 || new Set(plan.contextIds).size !== plan.contextIds.length || !plan.contextIds.every(id => uuid.test(id))) throw new Error("Invalid reviewed context inventory");
  await db.runTransaction(async transaction => {
    await target(db, plan, transaction);
    const refs = plan.contextIds.map(id => db.doc(`users/${plan.uid}/contexts/${id}`));
    const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
    if (snapshots.some(snapshot => !snapshot.exists || snapshot.data()?.originDeviceId !== plan.oldDevice)) throw new Error("A reviewed context changed; regenerate and review the dry run");
    for (const ref of refs) transaction.update(ref, { originDeviceId: plan.newDevice });
  });
  // All selected contexts commit atomically. Audit callbacks happen afterwards.
  for (const id of plan.contextIds) await recordApplied(id);
}

async function main() {
  const args = process.argv.slice(2), flags = new Set(["--apply", "--verify"]), options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!["--project", "--uid", "--old-device", "--new-device", "--plan-file", ...flags].includes(key) || key in options) throw new Error("Invalid arguments");
    options[key] = flags.has(key) ? true : args[++i];
  }
  if (!options["--project"] || !isAbsolute(options["--plan-file"] ?? "") || !process.env.GOOGLE_APPLICATION_CREDENTIALS || (options["--apply"] && options["--verify"])) throw new Error("Explicit project, private absolute plan file and Google credential file required");
  const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
  const { applicationDefault, initializeApp, deleteApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const app = initializeApp({ credential: applicationDefault(), projectId: options["--project"] });
  try {
    const db = getFirestore(app), path = options["--plan-file"];
    if (!options["--apply"] && !options["--verify"]) {
      const plan = await planPhoneOriginRemap(db, { uid: options["--uid"], oldDevice: options["--old-device"], newDevice: options["--new-device"] });
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ schemaVersion: 1, project: options["--project"], state: "planned", plannedAt: new Date().toISOString(), ...plan }, null, 2) + "\n"); } finally { await file.close(); }
      process.stdout.write(`Dry run only: ${plan.contextIds.length} contexts. Review the private plan file.\n`);
    } else {
      const plan = JSON.parse(await readFile(path, "utf8"));
      if (plan.schemaVersion !== 1 || plan.project !== options["--project"]) throw new Error("Plan/project mismatch");
      validate(plan);
      if (options["--apply"]) {
        if (plan.state !== "planned") throw new Error("Plan already applied; use --verify");
        await applyPhoneOriginRemap(db, plan, async () => {});
        const temporary = `${path}.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify({ ...plan, state: "applied", appliedAt: new Date().toISOString(), appliedCount: plan.contextIds.length }, null, 2) + "\n");
          await file.sync(); await file.close(); await rename(temporary, path);
        } catch (error) { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
      }
      const snapshots = await Promise.all(plan.contextIds.map(id => db.doc(`users/${plan.uid}/contexts/${id}`).get()));
      const matching = snapshots.filter(snapshot => snapshot.data()?.originDeviceId === plan.newDevice).length;
      process.stdout.write(`Verification: ${matching}/${plan.contextIds.length} reviewed contexts have the registered phone origin.\n`);
      if (matching !== plan.contextIds.length) process.exitCode = 1;
    }
  } finally { await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(() => {
  process.stderr.write("Phone-origin operation failed; retain and review its private audit file. No credential details were printed.\n"); process.exitCode = 1;
});
