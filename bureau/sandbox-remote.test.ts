import { describe, expect, test } from "bun:test";
import { remoteContainer } from "./sandbox-remote";

describe("remoteContainer", () => {
  test("compiles to a BureauSandboxProvider with name 'remote-container'", () => {
    const provider = remoteContainer();
    expect(provider.name).toBe("remote-container");
  });

  test("create() throws a typed not-implemented error pointing at #73", async () => {
    const provider = remoteContainer();
    await expect(provider.create({ preserve: false })).rejects.toThrow(/#73/);
  });
});
