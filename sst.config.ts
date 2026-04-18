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
    const sshPublicKey = new hcloud.SshKey("redc-ssh-key", {
      publicKey: process.env.HETZNER_SSH_PUBLIC_KEY!,
    });

    const firewall = new hcloud.Firewall("redc-firewall", {
      rules: [
        {
          description: "Git SSH",
          direction: "in",
          protocol: "tcp",
          port: "22",
          sourceIps: ["0.0.0.0/0", "::/0"],
        },
        {
          description: "HTTP",
          direction: "in",
          protocol: "tcp",
          port: "80",
          sourceIps: ["0.0.0.0/0", "::/0"],
        },
        {
          description: "HTTPS",
          direction: "in",
          protocol: "tcp",
          port: "443",
          sourceIps: ["0.0.0.0/0", "::/0"],
        },
        {
          description: "Admin SSH",
          direction: "in",
          protocol: "tcp",
          port: "2222",
          sourceIps: ["0.0.0.0/0", "::/0"],
        },
      ],
    });

    const userData = [
      "#!/bin/bash",
      "set -euo pipefail",
      "",
      "# Move sshd to port 2222",
      "sed -i 's/^#\\?Port .*/Port 2222/' /etc/ssh/sshd_config",
      "systemctl restart ssh",
      "",
      "# Install Docker",
      "curl -fsSL https://get.docker.com | sh",
      "systemctl enable docker",
      "",
      "# Create app directory",
      "mkdir -p /opt/redc",
    ].join("\n");

    const server = new hcloud.Server("redc-server", {
      serverType: "cax11",
      image: "ubuntu-24.04",
      location: "nbg1",
      sshKeys: [sshPublicKey.id],
      firewallIds: [firewall.id.apply((id) => Number(id))],
      userData,
    });

    const dns = new cloudflare.Record("redc-dns", {
      zoneId: process.env.CLOUDFLARE_ZONE_ID!,
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
  },
});
