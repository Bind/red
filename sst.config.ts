/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "red",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "cloudflare",
      providers: {
        hcloud: true,
        cloudflare: true,
      },
    };
  },
  async run() {
    const { createHash } = await import("node:crypto");
    const zoneId = process.env.CLOUDFLARE_ZONE_ID;
    if (!zoneId) throw new Error("CLOUDFLARE_ZONE_ID is required");
    const cloudflareAccountId =
      process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID;
    const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!cloudflareAccountId) {
      throw new Error("CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_DEFAULT_ACCOUNT_ID is required");
    }
    if (!cloudflareApiToken) {
      throw new Error("CLOUDFLARE_API_TOKEN is required");
    }
    const isProduction = $app.stage === "production";
    const serverName = isProduction ? "red-server" : "red-dev-server";
    const sshKeyName = isProduction ? "red-ssh-key" : "red-dev-ssh-key";
    const dnsName = isProduction ? "red.computer" : "*.preview.red.computer";
    const dnsRecordName = isProduction ? "red-dns" : "red-preview-wildcard";
    const daemonMemoryBucketName = isProduction
      ? "red-daemon-memory"
      : `red-daemon-memory-${$app.stage}`;
    const sshPublicKey = isProduction
      ? process.env.HETZNER_SSH_PUBLIC_KEY
      : process.env.DEV_SSH_PUBLIC_KEY;
    if (!sshPublicKey) {
      throw new Error(
        `${isProduction ? "HETZNER_SSH_PUBLIC_KEY" : "DEV_SSH_PUBLIC_KEY"} is required`,
      );
    }

    const sshKey = new hcloud.SshKey(sshKeyName, {
      publicKey: sshPublicKey,
    });

    const firewall = new hcloud.Firewall("red-firewall", {
      rules: [
        { description: "Git SSH", direction: "in", protocol: "tcp", port: "22", sourceIps: ["0.0.0.0/0", "::/0"] },
        { description: "HTTP", direction: "in", protocol: "tcp", port: "80", sourceIps: ["0.0.0.0/0", "::/0"] },
        { description: "HTTPS", direction: "in", protocol: "tcp", port: "443", sourceIps: ["0.0.0.0/0", "::/0"] },
        { description: "Admin SSH", direction: "in", protocol: "tcp", port: "2222", sourceIps: ["0.0.0.0/0", "::/0"] },
      ],
    });

    // Prefer the packer-baked red-base snapshot when available; fall back
    // to stock Ubuntu + cloud-init bootstrap. When the snapshot is in use,
    // all of docker / dotenvx / sshd:2222 / /opt/red are already baked in,
    // so userData shrinks to a no-op marker (cloud-init is happier with a
    // non-empty script).
    const baseImage = process.env.RED_BASE_SNAPSHOT_ID ?? "ubuntu-24.04";
    const usingBakedImage = baseImage !== "ubuntu-24.04";

    const userData = usingBakedImage
      ? "#!/bin/bash\n: baked image, no bootstrap needed\n"
      : [
          "#!/bin/bash",
          "set -euo pipefail",
          "",
          "sed -i 's/^#\\?Port .*/Port 2222/' /etc/ssh/sshd_config",
          "systemctl restart ssh",
          "",
          "curl -fsSL https://get.docker.com | sh",
          "systemctl enable docker",
          "",
          "curl -fsS https://dotenvx.sh | sh",
          "",
          `mkdir -p ${isProduction ? "/opt/red" : "/opt/red-previews"}`,
        ].join("\n");

    const server = new hcloud.Server(serverName, {
      serverType: "cax11",
      image: baseImage,
      location: "nbg1",
      sshKeys: [sshKey.id],
      firewallIds: [firewall.id.apply((id) => Number(id))],
      userData,
    });

    const dns = new cloudflare.Record(dnsRecordName, {
      zoneId,
      name: dnsName,
      type: "A",
      content: server.ipv4Address,
      ttl: isProduction ? 300 : 60,
      proxied: false,
    });

    const daemonMemoryBucket = new cloudflare.R2Bucket("red-daemon-memory", {
      accountId: cloudflareAccountId,
      name: daemonMemoryBucketName,
      jurisdiction: "default",
      storageClass: "Standard",
    });

    const daemonMemoryPermissionResponse = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/tokens/permission_groups?name=${encodeURIComponent(
        "Workers R2 Storage Bucket Item Write",
      )}&scope=${encodeURIComponent("com.cloudflare.edge.r2.bucket")}`,
      {
        headers: {
          Authorization: `Bearer ${cloudflareApiToken}`,
        },
      },
    );
    if (!daemonMemoryPermissionResponse.ok) {
      throw new Error(
        `failed to resolve R2 bucket permission group: ${daemonMemoryPermissionResponse.status} ${daemonMemoryPermissionResponse.statusText}`,
      );
    }
    const daemonMemoryPermissionPayload = (await daemonMemoryPermissionResponse.json()) as {
      result?: Array<{ id?: string }>;
    };
    const daemonMemoryWriteGroupId = daemonMemoryPermissionPayload.result?.[0]?.id;
    if (!daemonMemoryWriteGroupId) {
      throw new Error("failed to resolve permission group id for Workers R2 Storage Bucket Item Write");
    }

    const daemonMemoryToken = new cloudflare.AccountToken("red-daemon-memory-token", {
      accountId: cloudflareAccountId,
      name: isProduction ? "red-daemon-memory" : `red-daemon-memory-${$app.stage}`,
      policies: [
        {
          effect: "allow",
          permissionGroups: [{ id: daemonMemoryWriteGroupId }],
          resources: daemonMemoryBucket.jurisdiction.apply((jurisdiction) =>
            JSON.stringify({
              [`com.cloudflare.edge.r2.bucket.${cloudflareAccountId}_${jurisdiction}_${daemonMemoryBucketName}`]:
                "*",
            }),
          ),
        },
      ],
      status: "active",
    });

    const daemonMemoryEndpoint = `https://${cloudflareAccountId}.r2.cloudflarestorage.com`;
    const daemonMemorySecretAccessKey = daemonMemoryToken.value.apply((value) =>
      createHash("sha256").update(value).digest("hex"),
    );

    return {
      serverIp: server.ipv4Address,
      dnsRecord: dns.name,
      daemonMemoryBucket: daemonMemoryBucket.name,
      daemonMemoryEndpoint,
      daemonMemoryAccessKeyId: daemonMemoryToken.id,
      daemonMemorySecretAccessKey,
    };
  },
});
