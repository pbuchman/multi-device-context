/** Rule tests may use isolated ports, but never a non-loopback Firebase endpoint. */
export function emulatorAddress(value: string | undefined): { host: "127.0.0.1"; port: number } {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(value ?? "");
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Dedicated loopback emulator required");
  return { host: "127.0.0.1", port };
}
