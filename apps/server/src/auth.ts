import { createHash } from "node:crypto";

import type { RuntimeConfig } from "@mdc/contracts";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

export type VerifiedIdentity = { uid: string; subject: string };
export type AuthVerifier = (bearerToken: string) => Promise<VerifiedIdentity>;

export function createAuthVerifier(
  config: RuntimeConfig,
  keyResolver?: JWTVerifyGetKey,
): AuthVerifier {
  const issuer = `https://${config.auth0.domain}/`;
  const resolver =
    keyResolver ?? createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
  const allowedClients = new Set([
    config.auth0.webClientId,
    config.auth0.nativeClientId,
  ]);

  return async (bearerToken) => {
    try {
      const { payload, protectedHeader } = await jwtVerify(bearerToken, resolver, {
        issuer,
        audience: config.auth0.audience,
        algorithms: ["RS256"],
      });
      if (
        protectedHeader.alg !== "RS256" ||
        typeof payload.exp !== "number" ||
        typeof payload.sub !== "string" ||
        !payload.sub.startsWith("google-oauth2|") ||
        payload.sub.length === "google-oauth2|".length ||
        typeof payload.azp !== "string" ||
        !allowedClients.has(payload.azp)
      ) {
        throw new Error("invalid claims");
      }

      return {
        subject: payload.sub,
        uid: createHash("sha256")
          .update(`${issuer}\0${payload.sub}`)
          .digest("base64url"),
      };
    } catch {
      throw new Error("Unauthorized");
    }
  };
}
