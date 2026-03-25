import type { Change, NotificationConfig, ConfidenceLevel } from "../types";

export interface NotificationPayload {
  event: "change_ready" | "change_critical" | "change_merged";
  change: {
    id: number;
    repo: string;
    branch: string;
    confidence: ConfidenceLevel | null;
    status: string;
    summary: string | null;
  };
  timestamp: string;
}

/**
 * Send outbound webhook notifications.
 * SSRF protection: blocks requests to private IP ranges.
 */
export class NotificationSender {
  /**
   * Send a notification to all matching webhook URLs.
   * Returns list of results (success/failure per URL).
   */
  async send(
    configs: NotificationConfig[],
    change: Change,
    event: NotificationPayload["event"]
  ): Promise<NotifyResult[]> {
    const matching = configs.filter((c) => shouldNotify(c, change, event));
    if (matching.length === 0) return [];

    const payload: NotificationPayload = {
      event,
      change: {
        id: change.id,
        repo: change.repo,
        branch: change.branch,
        confidence: change.confidence,
        status: change.status,
        summary: change.summary,
      },
      timestamp: new Date().toISOString(),
    };

    const body = JSON.stringify(payload);
    const results: NotifyResult[] = [];

    for (const config of matching) {
      try {
        // SSRF check
        if (isPrivateUrl(config.url)) {
          results.push({
            url: config.url,
            success: false,
            error: "Blocked: private/internal URL",
          });
          continue;
        }

        const res = await fetch(config.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "redc/0.1.0",
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });

        results.push({
          url: config.url,
          success: res.ok,
          status: res.status,
          error: res.ok ? undefined : `HTTP ${res.status}`,
        });
      } catch (err) {
        results.push({
          url: config.url,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }
}

export interface NotifyResult {
  url: string;
  success: boolean;
  status?: number;
  error?: string;
}

function shouldNotify(
  config: NotificationConfig,
  change: Change,
  event: NotificationPayload["event"]
): boolean {
  if (config.events.includes("all")) return true;

  if (event === "change_critical" && config.events.includes("critical")) return true;
  if (event === "change_ready" && config.events.includes("needs_review")) return true;

  // Also notify "critical" subscribers for ready events on critical changes
  if (
    event === "change_ready" &&
    change.confidence === "critical" &&
    config.events.includes("critical")
  ) {
    return true;
  }

  return false;
}

/**
 * SSRF protection: block requests to private/internal IP ranges.
 * Checks the URL hostname against known private ranges.
 */
export function isPrivateUrl(urlStr: string): boolean {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return true; // invalid URLs are blocked
  }

  const hostname = url.hostname.toLowerCase();

  // Block localhost variants (URL parser strips brackets from IPv6)
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname === "0.0.0.0"
  ) {
    return true;
  }

  // Block private IP ranges
  if (isPrivateIP(hostname)) return true;

  // Block common internal hostnames
  if (
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan")
  ) {
    return true;
  }

  // Block non-http(s) schemes
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return true;
  }

  return false;
}

function isPrivateIP(ip: string): boolean {
  // IPv4 private ranges
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p))) {
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 127.0.0.0/8
    if (parts[0] === 127) return true;
    // 0.0.0.0/8
    if (parts[0] === 0) return true;
  }

  return false;
}
