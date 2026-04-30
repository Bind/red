import { describe, test, expect } from "bun:test";
import { isPrivateUrl, NotificationSender } from "./notify";
import type { Change, NotificationConfig } from "../types";

describe("isPrivateUrl", () => {
  test("blocks localhost", () => {
    expect(isPrivateUrl("http://localhost:8080/hook")).toBe(true);
    expect(isPrivateUrl("http://127.0.0.1:3000/hook")).toBe(true);
    expect(isPrivateUrl("http://0.0.0.0/hook")).toBe(true);
    expect(isPrivateUrl("http://[::1]/hook")).toBe(true);
  });

  test("blocks private IP ranges", () => {
    expect(isPrivateUrl("http://10.0.0.1/hook")).toBe(true);
    expect(isPrivateUrl("http://172.16.0.1/hook")).toBe(true);
    expect(isPrivateUrl("http://172.31.255.255/hook")).toBe(true);
    expect(isPrivateUrl("http://192.168.1.1/hook")).toBe(true);
    expect(isPrivateUrl("http://169.254.1.1/hook")).toBe(true);
  });

  test("blocks internal hostnames", () => {
    expect(isPrivateUrl("http://myhost.local/hook")).toBe(true);
    expect(isPrivateUrl("http://service.internal/hook")).toBe(true);
    expect(isPrivateUrl("http://router.lan/hook")).toBe(true);
  });

  test("blocks non-http schemes", () => {
    expect(isPrivateUrl("ftp://example.com/hook")).toBe(true);
    expect(isPrivateUrl("file:///etc/passwd")).toBe(true);
  });

  test("blocks invalid URLs", () => {
    expect(isPrivateUrl("not a url")).toBe(true);
  });

  test("allows public URLs", () => {
    expect(isPrivateUrl("https://hooks.slack.com/services/xxx")).toBe(false);
    expect(isPrivateUrl("https://webhook.example.com/red")).toBe(false);
    expect(isPrivateUrl("http://203.0.113.1/hook")).toBe(false);
  });

  test("allows public IPs outside private ranges", () => {
    expect(isPrivateUrl("http://172.32.0.1/hook")).toBe(false); // just outside 172.16-31
    expect(isPrivateUrl("http://8.8.8.8/hook")).toBe(false);
  });
});

describe("NotificationSender", () => {
  const sender = new NotificationSender();

  const makeChange = (overrides: Partial<Change> = {}): Change => ({
    id: 1,
    org_id: "default",
    repo: "owner/repo",
    branch: "feature-1",
    base_branch: "main",
    head_sha: "abc123",
    pr_number: null,
    status: "ready_for_review",
    confidence: "needs_review",
    created_by: "human",
    summary: '{"what_changed":"test"}',
    diff_stats: null,
    delivery_id: "del-1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });

  test("returns empty array when no configs match", async () => {
    const configs: NotificationConfig[] = [
      { url: "https://example.com/hook", events: ["critical"] },
    ];
    // change_ready event with needs_review confidence → "critical" subscriber won't match
    const results = await sender.send(configs, makeChange(), "change_ready");
    expect(results).toHaveLength(0);
  });

  test("blocks private URLs with SSRF error", async () => {
    const configs: NotificationConfig[] = [
      { url: "http://localhost:8080/hook", events: ["all"] },
    ];
    const results = await sender.send(configs, makeChange(), "change_ready");
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("private");
  });

  test("'all' event filter matches everything", async () => {
    const configs: NotificationConfig[] = [
      { url: "http://10.0.0.1/hook", events: ["all"] }, // will be blocked but still matched
    ];
    const results = await sender.send(configs, makeChange(), "change_ready");
    expect(results).toHaveLength(1); // matched, then blocked by SSRF
  });

  test("critical subscriber gets critical events", async () => {
    const configs: NotificationConfig[] = [
      { url: "http://192.168.1.1/hook", events: ["critical"] },
    ];
    const results = await sender.send(
      configs,
      makeChange({ confidence: "critical" }),
      "change_critical"
    );
    expect(results).toHaveLength(1);
  });
});
