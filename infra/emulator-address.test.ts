import { describe, expect, it } from "vitest";
import { emulatorAddress } from "./emulator-address.js";

describe("dedicated emulator address", () => {
  it("accepts explicit loopback endpoints including isolated test ports", () => {
    expect(emulatorAddress("127.0.0.1:18080")).toEqual({ host: "127.0.0.1", port: 18080 });
    expect(emulatorAddress("127.0.0.1:28080")).toEqual({ host: "127.0.0.1", port: 28080 });
  });
  it.each([undefined, "", "localhost:18080", "example.com:18080", "192.0.2.1:18080", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:abc"])("rejects non-dedicated endpoint %j", value => {
    expect(() => emulatorAddress(value)).toThrow("Dedicated loopback emulator required");
  });
});
