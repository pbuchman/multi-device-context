import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

export type ConnectionStage = "configuration" | "workspace" | "renderer";

export type ConnectionDiagnostic = {
  stage: ConnectionStage;
  code: string;
  message: string;
  occurredAt: string;
  appVersion: string;
  httpStatus?: number;
};

type ConnectionFailureCode =
  | "CONFIGURATION_INVALID"
  | "ORIGIN_MISMATCH"
  | "HTTP_ERROR";

const FAILURE_MESSAGES: Record<ConnectionFailureCode, string> = {
  CONFIGURATION_INVALID: "The desktop connection configuration is invalid.",
  ORIGIN_MISMATCH: "The shared workspace responded from an unexpected origin.",
  HTTP_ERROR: "The shared workspace returned an HTTP error.",
};

export class ConnectionFailure extends Error {
  constructor(
    public readonly code: ConnectionFailureCode,
    public readonly status?: number,
  ) {
    super(FAILURE_MESSAGES[code]);
    this.name = "ConnectionFailure";
  }
}

const CODE_MESSAGES = new Map<string, string>([
  ...[
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "ERR_CERT_AUTHORITY_INVALID",
    "ERR_CERT_COMMON_NAME_INVALID",
    "ERR_CERT_DATE_INVALID",
    "ERR_CERT_INVALID",
    "ERR_CERT_REVOKED",
    "ERR_CERT_WEAK_KEY",
  ].map((code) => [code, "The secure connection certificate could not be verified."] as const),
  ...[
    "ENOTFOUND",
    "EAI_AGAIN",
    "ERR_NAME_NOT_RESOLVED",
    "ERR_NAME_RESOLUTION_FAILED",
  ].map((code) => [code, "The shared workspace address could not be resolved."] as const),
  ...[
    "ETIMEDOUT",
    "ERR_TIMED_OUT",
    "ERR_CONNECTION_TIMED_OUT",
  ].map((code) => [code, "The connection to the shared workspace timed out."] as const),
  ...[
    "ECONNREFUSED",
    "ECONNRESET",
    "ENETDOWN",
    "ENETUNREACH",
    "EHOSTDOWN",
    "EHOSTUNREACH",
    "EPIPE",
    "ERR_ADDRESS_UNREACHABLE",
    "ERR_CONNECTION_CLOSED",
    "ERR_CONNECTION_REFUSED",
    "ERR_CONNECTION_RESET",
    "ERR_INTERNET_DISCONNECTED",
    "ERR_NETWORK_CHANGED",
    "ERR_PROXY_CONNECTION_FAILED",
  ].map((code) => [code, "The shared workspace could not be reached."] as const),
]);

const UNKNOWN = {
  code: "CONNECTION_FAILED",
  message: "Multi Device Context could not connect to the shared workspace.",
};

function readString(value: object, property: string): string | undefined {
  try {
    const result = (value as Record<string, unknown>)[property];
    return typeof result === "string" ? result : undefined;
  } catch {
    return undefined;
  }
}

function recognizedCode(value: unknown): string | undefined {
  if (!value || (typeof value !== "object" && typeof value !== "function"))
    return undefined;
  for (const property of ["code", "errno", "errorDescription"]) {
    const candidate = readString(value as object, property);
    if (!candidate) continue;
    if (CODE_MESSAGES.has(candidate)) return candidate;
    const chromiumCode = candidate.match(/^net::([A-Z0-9_]+)$/u)?.[1];
    if (chromiumCode && CODE_MESSAGES.has(chromiumCode)) return chromiumCode;
  }
  const message = readString(value as object, "message");
  const chromiumCode = message?.match(/^net::([A-Z0-9_]+)$/u)?.[1];
  return chromiumCode && CODE_MESSAGES.has(chromiumCode)
    ? chromiumCode
    : undefined;
}

function readCause(value: unknown): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function"))
    return undefined;
  try {
    return (value as { cause?: unknown }).cause;
  } catch {
    return undefined;
  }
}

function classify(error: unknown): {
  code: string;
  message: string;
  httpStatus?: number;
} {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof ConnectionFailure) {
      const httpStatus =
        current.code === "HTTP_ERROR" &&
        Number.isInteger(current.status) &&
        current.status! >= 100 &&
        current.status! <= 599
          ? current.status
          : undefined;
      return {
        code: current.code,
        message: FAILURE_MESSAGES[current.code],
        ...(httpStatus === undefined ? {} : { httpStatus }),
      };
    }
    const code = recognizedCode(current);
    if (code) return { code, message: CODE_MESSAGES.get(code)! };
    current = readCause(current);
  }
  return UNKNOWN;
}

function safeVersion(value: string): string {
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(value) ? value : "unknown";
}

export class RecoveryDiagnostics {
  private diagnostic: ConnectionDiagnostic | undefined;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly appVersion: string,
  ) {}

  async record(
    stage: ConnectionStage,
    error: unknown,
  ): Promise<ConnectionDiagnostic> {
    const diagnostic: ConnectionDiagnostic = {
      stage: ["configuration", "workspace", "renderer"].includes(stage)
        ? stage
        : "renderer",
      ...classify(error),
      occurredAt: new Date().toISOString(),
      appVersion: safeVersion(this.appVersion),
    };
    this.diagnostic = diagnostic;
    const serialized = `${JSON.stringify(diagnostic)}\n`;
    const write = this.pendingWrite.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const file = await open(this.filePath, "w", 0o600);
      try {
        await file.chmod(0o600);
        await file.writeFile(serialized, "utf8");
      } finally {
        await file.close();
      }
    });
    this.pendingWrite = write.catch(() => {});
    await write.catch(() => {});
    return { ...diagnostic };
  }

  current(): ConnectionDiagnostic | undefined {
    return this.diagnostic ? { ...this.diagnostic } : undefined;
  }

  clear(): void {
    this.diagnostic = undefined;
  }
}
