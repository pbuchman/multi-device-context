import { AccountSettings } from "./settings.js";
import { pathToFileURL } from "node:url";

import { applicationDefault, deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

import { AgentStore } from "./agent-store.js";
import { TitleWorker } from "./titles.js";

import { createAuthVerifier } from "./auth.js";
import { readServerConfig } from "./config.js";
import { FirebaseBackend } from "./firebase.js";
import { DeviceAccessStore } from "./device-access.js";
import { FirestoreAccessAdministration } from "./access.js";
import { AttachmentStore } from "./attachments.js";
import { buildServer } from "./server.js";

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const config = readServerConfig(env);
  const adminApp = initializeApp({
    credential: applicationDefault(),
    projectId: config.publicConfig.firebase.projectId,
    storageBucket: config.publicConfig.firebase.storageBucket,
  });
  const backend = new FirebaseBackend({
    firestore: getFirestore(adminApp),
    bucket: getStorage(adminApp).bucket(),
    auth: getAuth(adminApp),
    dispose: () => deleteApp(adminApp),
  });
  const settings = new AccountSettings(getFirestore(adminApp), env.MDC_AI_EXISTING_OWNER_UID);
  const server = buildServer({
    settings,
    publicConfig: config.publicConfig,
    verifier: createAuthVerifier(config.publicConfig),
    backend,
    devices: new DeviceAccessStore(getFirestore(adminApp), getAuth(adminApp)),
    access: new FirestoreAccessAdministration(getFirestore(adminApp), { origin: config.publicConfig.appOrigin }),
    attachments: new AttachmentStore(getFirestore(adminApp), getStorage(adminApp).bucket(), backend),
    webDist: config.webDist,
    agents: new AgentStore(getFirestore(adminApp), getStorage(adminApp).bucket(), backend),
  });
  const titles = new TitleWorker(getFirestore(adminApp), env.MDC_OPENROUTER_API_KEY, env.MDC_TITLE_MODEL, settings);
  server.addHook("preClose", async () => { await titles.close(); });
  try {
    await backend.startCleanup();
    titles.start();
    await server.listen({ host: config.host, port: config.port });
    return server;
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer();
  } catch {
    process.stderr.write("Server startup failed\n");
    process.exitCode = 1;
    return;
  }

  const shutdown = async () => {
    try {
      await server?.close();
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
