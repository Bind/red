packer {
  required_plugins {
    hcloud = {
      source  = "github.com/hetznercloud/hcloud"
      version = "~> 1.6"
    }
  }
}

variable "hcloud_token" {
  type      = string
  sensitive = true
  default   = env("HCLOUD_TOKEN")
}

variable "server_type" {
  type    = string
  default = "cax11"
}

variable "location" {
  type    = string
  default = "nbg1"
}

variable "base_image" {
  type    = string
  default = "ubuntu-24.04"
}

variable "snapshot_name" {
  type    = string
  # Override on CLI. Defaults include the current date for cheap uniqueness.
  default = "redc-base-{{timestamp}}"
}

variable "snapshot_labels" {
  type = map(string)
  default = {
    role       = "redc-base"
    managed-by = "packer"
  }
}

source "hcloud" "redc_base" {
  token             = var.hcloud_token
  image             = var.base_image
  location          = var.location
  server_type       = var.server_type
  snapshot_name     = var.snapshot_name
  snapshot_labels   = var.snapshot_labels
  ssh_username      = "root"
  temporary_key_pair_type = "ed25519"
}

build {
  name    = "redc-base"
  sources = ["source.hcloud.redc_base"]

  provisioner "shell" {
    scripts = [
      "${path.root}/provisioners/01-apt.sh",
      "${path.root}/provisioners/02-sshd.sh",
      "${path.root}/provisioners/03-docker.sh",
      "${path.root}/provisioners/04-dotenvx.sh",
      "${path.root}/provisioners/05-preload-images.sh",
      "${path.root}/provisioners/06-system.sh",
    ]
    # Provisioners talk to the temporary box on the stock sshd port 22 — the
    # port-move script flips sshd to 2222 AFTER provisioning wraps up.
    environment_vars = [
      "DEBIAN_FRONTEND=noninteractive",
    ]
  }

  post-processor "manifest" {
    output     = "${path.root}/build.manifest.json"
    strip_path = true
  }
}
