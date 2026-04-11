import { describe, expect, test } from "bun:test";

import { loadConfig } from "../util/config";

describe("loadConfig", () => {
  test("uses dev defaults", () => {
    const config = loadConfig({});

    expect(config.mode).toBe("dev");
    expect(config.hostname).toBe("127.0.0.1");
    expect(config.port).toBe(4090);
    expect(config.openaiModel).toBe("gpt-5-mini");
    expect(config.allowNetwork).toBe(false);
  });

  test("requires strict compose env vars", () => {
    expect(() =>
      loadConfig({
        SMITHERS_LAB_MODE: "compose",
        SMITHERS_LAB_HOST: "0.0.0.0",
        SMITHERS_LAB_PORT: "4090",
      }),
    ).toThrow("Missing required env var: SMITHERS_LAB_DB_PATH");
  });

  test("accepts compose config when provided", () => {
    const config = loadConfig({
      SMITHERS_LAB_MODE: "compose",
      SMITHERS_LAB_HOST: "0.0.0.0",
      SMITHERS_LAB_PORT: "4090",
      SMITHERS_LAB_DB_PATH: "/tmp/smithers.sqlite",
      SMITHERS_LAB_OPENAI_MODEL: "gpt-5-mini",
      SMITHERS_LAB_ALLOW_NETWORK: "true",
    });

    expect(config.mode).toBe("compose");
    expect(config.allowNetwork).toBe(true);
    expect(config.dbPath).toContain("/tmp/smithers.sqlite");
  });
});
