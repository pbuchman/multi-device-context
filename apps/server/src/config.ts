import { resolve } from "node:path";

import {
  MAX_ATTACHMENT_BYTES,
  MAX_TEXT_BYTES,
  RuntimeConfigSchema,
  type RuntimeConfig,
} from "@mdc/contracts";

export type ServerConfig = {
  publicConfig: RuntimeConfig;
  host: string;
  port: number;
  webDist: string;
};

const requiredVariables = [
  "MDC_APP_ORIGIN",
  "MDC_AUTH0_DOMAIN",
  "MDC_AUTH0_AUDIENCE",
  "MDC_AUTH0_WEB_CLIENT_ID",
  "MDC_AUTH0_NATIVE_CLIENT_ID",
  "MDC_FIREBASE_API_KEY",
  "MDC_FIREBASE_AUTH_DOMAIN",
  "MDC_GCP_PROJECT_ID",
  "MDC_STORAGE_BUCKET",
] as const;

const configPathToVariable: Record<string, (typeof requiredVariables)[number]> = {
  appOrigin: "MDC_APP_ORIGIN",
  "auth0.domain": "MDC_AUTH0_DOMAIN",
  "auth0.audience": "MDC_AUTH0_AUDIENCE",
  "auth0.webClientId": "MDC_AUTH0_WEB_CLIENT_ID",
  "auth0.nativeClientId": "MDC_AUTH0_NATIVE_CLIENT_ID",
  "firebase.apiKey": "MDC_FIREBASE_API_KEY",
  "firebase.authDomain": "MDC_FIREBASE_AUTH_DOMAIN",
  "firebase.projectId": "MDC_GCP_PROJECT_ID",
  "firebase.storageBucket": "MDC_STORAGE_BUCKET",
};

export function readServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const missing = requiredVariables.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const publicCandidate = {
    appOrigin: env.MDC_APP_ORIGIN,
    auth0: {
      domain: env.MDC_AUTH0_DOMAIN,
      audience: env.MDC_AUTH0_AUDIENCE,
      webClientId: env.MDC_AUTH0_WEB_CLIENT_ID,
      nativeClientId: env.MDC_AUTH0_NATIVE_CLIENT_ID,
      connection: "google-oauth2",
    },
    firebase: {
      apiKey: env.MDC_FIREBASE_API_KEY,
      authDomain: env.MDC_FIREBASE_AUTH_DOMAIN,
      projectId: env.MDC_GCP_PROJECT_ID,
      storageBucket: env.MDC_STORAGE_BUCKET,
    },
    limits: {
      maxTextBytes: MAX_TEXT_BYTES,
      maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
    },
    bridgeVersion: 1,
  };
  const parsed = RuntimeConfigSchema.safeParse(publicCandidate);
  if (!parsed.success) {
    const variables = new Set<string>();
    for (const issue of parsed.error.issues) {
      const variable = configPathToVariable[issue.path.join(".")];
      if (variable) variables.add(variable);
    }
    throw new Error(`Invalid server configuration: ${[...variables].join(", ") || "public values"}`);
  }

  const portText = env.MDC_PORT ?? "3000";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid server configuration: MDC_PORT");
  }
  const host = env.MDC_HOST ?? "127.0.0.1";
  if (host.length === 0) {
    throw new Error("Invalid server configuration: MDC_HOST");
  }

  return {
    publicConfig: parsed.data,
    host,
    port,
    webDist: resolve(env.MDC_WEB_DIST ?? "apps/web/dist"),
  };
}
