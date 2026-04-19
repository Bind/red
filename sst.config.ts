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

    if ($app.stage === "production") {
      const sshPublicKey = new hcloud.SshKey("redc-ssh-key", {
        publicKey: process.env.HETZNER_SSH_PUBLIC_KEY!,
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
            "mkdir -p /opt/redc",
          ].join("\n");

      const server = new hcloud.Server("redc-server", {
        serverType: "cax11",
        image: baseImage,
        location: "nbg1",
        sshKeys: [sshPublicKey.id],
        firewallIds: [firewall.id.apply((id) => Number(id))],
        userData,
      });

      const dns = new cloudflare.Record("redc-dns", {
        zoneId,
        name: "red.computer",
        type: "A",
        content: server.ipv4Address,
        ttl: 300,
        proxied: false,
      });

      return {
        serverIp: server.ipv4Address,
        dnsRecord: dns.name,
      };
    }

    // dev stage: we do NOT provision the Hetzner box (provisioned manually).
    // We only manage the wildcard DNS record that points every
    // slug.preview.red.computer at the dev server.
    const devServerIp = process.env.DEV_SERVER_IP;
    if (!devServerIp) {
      throw new Error("DEV_SERVER_IP is required on the dev stage");
    }

    const previewDns = new cloudflare.Record("redc-preview-wildcard", {
      zoneId,
      name: "*.preview.red.computer",
      type: "A",
      content: devServerIp,
      ttl: 60,
      proxied: false,
    });

    return {
      devServerIp,
      previewDns: previewDns.name,
    };
  },
});
