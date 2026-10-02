import { startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { AccessActionSchema, AccessDeviceSchema, AgentKeyInfoSchema, IdSchema, type AccessAction, type AccessDevice, type AgentKeyInfo } from "@mdc/contracts";
import type { AgentKeyClient } from "./AgentKeys.js";

type AccessResult = { kind: "device"; device: AccessDevice } | { kind: "agent-key"; key: AgentKeyInfo & { key: string } } | { kind: "revoked"; id: string };
type Passkeys = { authenticate: typeof startAuthentication; register: typeof startRegistration };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid access response.");
  return value as Record<string, unknown>;
};
function challenge(value: unknown) {
  const result = object(value); const id = IdSchema.parse(result.challengeId); const options = object(result.options);
  if (typeof options.challenge !== "string" || !options.challenge) throw new Error("Invalid passkey challenge.");
  return { challengeId: id, options };
}
function result(value: unknown): AccessResult {
  const data = object(value);
  if (data.kind === "device") return { kind: "device", device: AccessDeviceSchema.parse(data.device) };
  if (data.kind === "revoked") return { kind: "revoked", id: IdSchema.parse(data.id) };
  if (data.kind === "agent-key") {
    const key = object(data.key); const { key: secret, ...info } = key;
    if (typeof secret !== "string" || !/^mdc_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("Invalid agent key response.");
    return { kind: "agent-key", key: { ...AgentKeyInfoSchema.parse(info), key: secret } };
  }
  throw new Error("Invalid access response.");
}
export class AccessClient implements AgentKeyClient {
  constructor(private readonly token: () => Promise<string>, private readonly fetcher: typeof fetch = (...args) => fetch(...args), private readonly passkeys: Passkeys = { authenticate: startAuthentication, register: startRegistration }) {}
  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(`/api/access/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${await this.token()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: "no-store" });
    if (!response.ok) {
      const message = response.status === 401 ? "Sign in again to manage access." : response.status === 409 ? "Access changed. Refresh the page and confirm again." : response.status === 410 ? "This confirmation expired or was already used. Start again." : response.status === 429 ? "Too many attempts. Wait a minute and try again." : "Access could not be changed. Confirm with your registered passkey.";
      throw new Error(message);
    }
    return response.json();
  }
  async status(): Promise<{ passkeyRegistered: boolean }> {
    const value = object(await this.request("status"));
    if (typeof value.passkeyRegistered !== "boolean") throw new Error("Invalid access status.");
    return { passkeyRegistered: value.passkeyRegistered };
  }
  async devices(): Promise<AccessDevice[]> { return AccessDeviceSchema.array().parse(await this.request("devices")); }
  async register(): Promise<void> {
    const ceremony = challenge(await this.request("passkey/registration/options", {}));
    const response = await this.passkeys.register({ optionsJSON: ceremony.options as unknown as PublicKeyCredentialCreationOptionsJSON });
    await this.request("passkey/registration/verify", { challengeId: ceremony.challengeId, response });
  }
  async perform(action: AccessAction): Promise<AccessResult> {
    const ceremony = challenge(await this.request("challenges", AccessActionSchema.parse(action)));
    const response = await this.passkeys.authenticate({ optionsJSON: ceremony.options as unknown as PublicKeyCredentialRequestOptionsJSON });
    return result(await this.request(`challenges/${ceremony.challengeId}/complete`, { response }));
  }
  async listKeys(): Promise<AgentKeyInfo[]> { return AgentKeyInfoSchema.array().parse(await this.request("agent-keys")); }
  async createKey(name: string): Promise<AgentKeyInfo & { key: string }> {
    const result = await this.perform({ action: "create-agent-key", name });
    if (result.kind !== "agent-key") throw new Error("Invalid agent key response.");
    return result.key;
  }
  async revokeKey(targetId: string): Promise<void> { await this.perform({ action: "revoke-agent-key", targetId }); }
}
