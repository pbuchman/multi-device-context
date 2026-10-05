import assert from "node:assert/strict";
import { isAbsolute } from "node:path";

function appleScriptString(value) {
  assert(typeof value === "string" && value.length > 0 && !/[\r\n]/u.test(value), "Invalid AppleScript consent value");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function parseSecurityKeychains(output) {
  const paths = output.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    assert(line.startsWith('"') && line.endsWith('"'), "security returned an unquoted keychain path");
    const path = JSON.parse(line);
    assert(typeof path === "string" && isAbsolute(path), "security returned a non-absolute keychain path");
    return path;
  });
  assert(paths.length > 0, "security returned no keychain paths");
  return paths;
}

export function redactSecret(message, secret) {
  assert(typeof secret === "string" && secret.length > 0, "A non-empty secret is required for redaction");
  return String(message).replaceAll(secret, "[redacted]");
}

export function buildMacKeychainConsentScript({ appName, serviceName, keychainName }) {
  const appPrompt = appleScriptString(`${appName} wants to use`);
  const service = appleScriptString(serviceName);
  const keychain = appleScriptString(keychainName);
  return `
set keychainPassword to system attribute "MDC_NATIVE_UPDATE_KEYCHAIN_PASSWORD"
if keychainPassword is "" then error "The private test Keychain password is missing"
tell application "System Events"
  repeat with attempt from 1 to 180
    if exists process "SecurityAgent" then
      tell process "SecurityAgent"
        if exists window 1 then
          set promptText to (value of every static text of window 1) as text
          if promptText does not contain ${appPrompt} or promptText does not contain ${service} or promptText does not contain ${keychain} then
            error "An unrelated SecurityAgent prompt was shown"
          end if
          if not (exists text field 1 of window 1) or not (exists button "Allow" of window 1) then
            error "The expected Keychain consent controls were not shown"
          end if
          set value of text field 1 of window 1 to keychainPassword
          click button "Allow" of window 1
          return "allowed"
        end if
      end tell
    end if
    delay 0.25
  end repeat
end tell
error "Timed out waiting for exact B's Keychain consent prompt"
`;
}

function settle(promise) {
  return promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
}

async function closeAfterFailure(application, error, close, message) {
  try { await close(application); }
  catch (closeError) { throw new AggregateError([error, closeError], message); }
  throw error;
}

export async function launchWithRequiredConsent({ launch, consent, ready = async () => undefined, close }) {
  const consentAbort = new AbortController();
  const launchOutcome = settle(Promise.resolve().then(launch));
  const consentOutcome = settle(Promise.resolve().then(() => consent(consentAbort.signal)));
  const first = await Promise.race([
    launchOutcome.then(outcome => ({ source: "launch", outcome })),
    consentOutcome.then(outcome => ({ source: "consent", outcome })),
  ]);
  if (first.source === "launch" && !first.outcome.ok) {
    consentAbort.abort();
    await consentOutcome;
    throw first.outcome.error;
  }

  const [launched, authorized] = await Promise.all([launchOutcome, consentOutcome]);
  if (!launched.ok) throw launched.error;
  if (!authorized.ok) await closeAfterFailure(
    launched.value,
    authorized.error,
    close,
    "Keychain consent failed and exact B could not be closed",
  );
  let readyValue;
  try { readyValue = await ready(launched.value); }
  catch (error) {
    await closeAfterFailure(
      launched.value,
      error,
      close,
      "Exact B failed before its first window and could not be closed",
    );
  }
  return { application: launched.value, ready: readyValue };
}
