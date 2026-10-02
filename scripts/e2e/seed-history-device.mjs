import { readFile } from "node:fs/promises";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (host !== "127.0.0.1:18080") {
  throw new Error("Refusing to seed outside the dedicated Firestore emulator");
}

const environment = await initializeTestEnvironment({
  projectId: "demo-mdc",
  firestore: {
    host: "127.0.0.1",
    port: 18080,
    rules: await readFile("infra/firestore.rules", "utf8"),
  },
});

try {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(
      doc(
        context.firestore(),
        "users/migration-user/devices/00000000-0000-4000-8000-000000000001",
      ),
      { mode: "all", version: 1 },
    );
  });
} finally {
  await environment.cleanup();
}
