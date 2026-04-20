/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "redc",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "cloudflare",
      providers: {
        hcloud: true,
        cloudflare: true,
      },
    };
  },
  async run() {
    const zoneId = process.env.CLOUDFLARE_ZONE_ID;
    if (!zoneId) throw new Error("CLOUDFLARE_ZONE_ID is required");
    const isProduction = $app.stage === "production";
    const serverName = isProduction ? "redc-server" : "redc-dev-server";
    const sshKeyName = isProduction ? "redc-ssh-key" : "redc-dev-ssh-key";
    const dnsName = isProduction ? "red.computer" : "*.preview.red.computer";
    const dnsRecordName = isProduction ? "redc-dns" : "redc-preview-wildcard";
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

    const firewall = new hcloud.Firewall("redc-firewall", {
      rules: [
        { description: "Git SSH", direction: "in", protocol: "tcp", port: "22", sourceIps: ["0.0.0.0/0", "::/0"] },
        { description: "HTTP", direction: "in", protocol: "tcp", port: "80", sourceIps: ["0.0.0.0/0", "::/0"] },
        { description: "HTTPS", direction: "in", protocol: "tcp", port: "443", sourceIps: ["0.0.0.0/0", "::/0"] },
        { description: "Admin SSH", direction: "in", protocol: "tcp", port: "2222", sourceIps: ["0.0.0.0/0", "::/0"] },
      ],
    });

    // Prefer the packer-baked redc-base snapshot when available; fall back
    // to stock Ubuntu + cloud-init bootstrap. When the snapshot is in use,
    // all of docker / dotenvx / sshd:2222 / /opt/redc are already baked in,
    // so userData shrinks to a no-op marker (cloud-init is happier with a
    // non-empty script).
    const baseImage = process.env.REDC_BASE_SNAPSHOT_ID ?? "ubuntu-24.04";
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
          `mkdir -p ${isProduction ? "/opt/redc" : "/opt/redc-previews"}`,
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

    return {
      serverIp: server.ipv4Address,
      dnsRecord: dns.name,
    };
  },
});
