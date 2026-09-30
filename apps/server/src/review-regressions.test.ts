import type { RuntimeConfig } from "@mdc/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readServerConfig } from "./config.js";
import {
  BackendConflictError,
  BackendNotFoundError,
  buildServer,
  type Backend,
} from "./server.js";

const CONTEXT_ID = "00000000-0000-4000-8000-000000000001";
const ITEM_ID = "00000000-0000-4000-8000-000000000002";

const publicConfig: RuntimeConfig = {
  appOrigin: "https://app.example.test",
  auth0: {
    domain: "login.example.test",
    audience: "https://api.example.test",
    webClientId: "web-client",
    nativeClientId: "native-client",
    connection: "google-oauth2",
  },
  firebase: {
    apiKey: "public-api-key",
    authDomain: "demo-mdc.firebaseapp.com",
    projectId: "demo-mdc",
    storageBucket: "demo-mdc.firebasestorage.app",
  },
  limits: { maxTextBytes: 262_144, maxAttachmentBytes: 104_857_600 },
  bridgeVersion: 1,
};

function backend(overrides: Partial<Backend> = {}): Backend {
  return {
    createCustomToken: vi.fn(async (uid) => `custom:${uid}`),
    completeUpload: vi.fn(async () => undefined),
    deleteContext: vi.fn(async () => undefined),
    deleteItem: vi.fn(async () => undefined),
    checkReady: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

const verifier = vi.fn(async (token: string) => {
  if (token !== "valid-token") throw new Error("Unauthorized");
  return { uid: "derived_uid", subject: "google-oauth2|person-123" };
});

const openServers: Array<ReturnType<typeof buildServer>> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  vi.clearAllMocks();
});

function server(fake = backend()) {
  const app = buildServer({ publicConfig, verifier, backend: fake });
  openServers.push(app);
  return { app, fake };
}


import { AgentStore } from "./agent-store.js";
import { randomUUID } from "node:crypto";
it("R2: reject excess invalid keys before database lookups", async () => {
 const get=vi.fn(async()=>({data:()=>undefined}));
 const store=new AgentStore({doc:()=>({get})} as never, {} as never, backend());
 const app=buildServer({publicConfig, verifier, backend:backend(),agents:store});openServers.push(app);
 for(let i=0;i<150;i++) {
  const response=await app.inject({method:"GET",url:"/api/agent/v1/contexts",headers:{authorization:`Bearer mdc_${randomUUID()}_${"a".repeat(43)}`}});
  expect(response.statusCode).toBe(i < 60 ? 401 : 429);
 }
 expect(get).toHaveBeenCalledTimes(60);
});
it("R2: readiness requests share the background result", async()=>{
 const {app,fake}=server();
 for(let i=0;i<150;i++) expect((await app.inject({method:"GET",url:"/health/ready"})).statusCode).toBe(200);
 expect(fake.checkReady).toHaveBeenCalledTimes(1);
});
