import { pathToFileURL } from "node:url";

import { applicationDefault, deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { attachmentPath } from "@mdc/contracts";

import { AgentStore } from "./agent-store.js";
import { createAuthVerifier } from "./auth.js";
import { FirestoreAccessAdministration } from "./access.js";
import { AttachmentStore } from "./attachments.js";
import { buildServer } from "./server.js";
import { readServerConfig } from "./config.js";
import { DeviceAccessStore } from "./device-access.js";
import { ContextOriginsStore } from "./context-origins.js";
import { FirebaseBackend } from "./firebase.js";
import { AccountSettings } from "./settings.js";
import { TitleWorker } from "./titles.js";
import { RecoveryLifecycle } from "./lifecycle.js";
import { DependencyUnavailable, type IoOperation } from "./io-watchdog.js";

export async function startServer(env: NodeJS.ProcessEnv = process.env, lifecycle?: RecoveryLifecycle) {
  const config = readServerConfig(env);
  const adminApp = initializeApp({
    credential: applicationDefault(),
    projectId: config.publicConfig.firebase.projectId,
    storageBucket: config.publicConfig.firebase.storageBucket,
  });
  const bucket = getStorage(adminApp).bucket();
  const backend = new FirebaseBackend({
    firestore: getFirestore(adminApp),
    bucket,
    auth: getAuth(adminApp),
    dispose: () => deleteApp(adminApp),
    onFatal: (_operation: IoOperation) => lifecycle?.request("io-timeout"),
  });
  const settings = new AccountSettings(getFirestore(adminApp), env.MDC_AI_EXISTING_OWNER_UID);
  const server = buildServer({
    settings,
    publicConfig: config.publicConfig,
    verifier: createAuthVerifier(config.publicConfig),
    backend,
    devices: new DeviceAccessStore(getFirestore(adminApp), getAuth(adminApp)),
    contextOrigins: new ContextOriginsStore(getFirestore(adminApp)),
    access: new FirestoreAccessAdministration(getFirestore(adminApp), { origin: config.publicConfig.appOrigin }),
    attachments: new AttachmentStore(getFirestore(adminApp), bucket, backend),
    webDist: config.webDist,
    agents: new AgentStore(getFirestore(adminApp), bucket, backend),
  });
  lifecycle?.attach({
    close: () => server.close(),
    forceClose: () => { server.server.closeAllConnections(); server.server.closeIdleConnections(); },
  });
  const titles = new TitleWorker(getFirestore(adminApp), env.MDC_OPENROUTER_API_KEY, env.MDC_TITLE_MODEL, settings, async ({ uid, contextId, itemId, content }) => {
    const [bytes] = await bucket.file(attachmentPath(uid, contextId, itemId)).download();
    if (bytes.byteLength !== content.size) throw new Error("Title image size changed");
    return new Uint8Array(bytes);
  });
  server.addHook("preClose", async () => { await titles.close(); });
  try {
    await backend.startCleanup();
    if (backend.isFatal() || lifecycle?.stopping) throw new DependencyUnavailable();
    titles.start();
    await server.listen({ host: config.host, port: config.port });
    return server;
  } catch (error) {
    // The boundary still forces exit if Fastify/Firebase disposal never settles.
    if (lifecycle) lifecycle.request("startup-failed");
    else await server.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const lifecycle = new RecoveryLifecycle();
  process.once("SIGINT", () => lifecycle.request("operator-signal"));
  process.once("SIGTERM", () => lifecycle.request("operator-signal"));
  try {
    await startServer(process.env, lifecycle);
  } catch {
    lifecycle.request("startup-failed");
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
