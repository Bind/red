import type { Repo } from "../apps/grs/src/core/api";
import { resolve } from "node:path";

export type SandboxRepoRemote = {
  fetchUrl: string;
  ref: string;
};

export interface SandboxRepo {
  id: string;
  getReadRemote(ref: string): Promise<SandboxRepoRemote>;
}

export class GitHubRepo implements SandboxRepo {
  readonly id: string;

  constructor(
    private readonly options: {
      owner: string;
      name: string;
      token?: string;
    },
  ) {
    this.id = `${options.owner}/${options.name}`;
  }

  async getReadRemote(ref: string): Promise<SandboxRepoRemote> {
    const base = `https://github.com/${this.options.owner}/${this.options.name}.git`;
    const fetchUrl = this.options.token
      ? withBasicAuth(base, "x-access-token", this.options.token)
      : base;
    return { fetchUrl, ref };
  }
}

export class LocalRepo implements SandboxRepo {
  readonly id: string;

  constructor(
    private readonly options: {
      root: string;
      id?: string;
    },
  ) {
    this.id = options.id ?? `local:${resolve(options.root)}`;
  }

  async getReadRemote(ref: string): Promise<SandboxRepoRemote> {
    return {
      fetchUrl: resolve(this.options.root),
      ref,
    };
  }
}

export class GrsRepo implements SandboxRepo {
  constructor(
    private readonly repo: Repo,
    private readonly options: {
      repoId: string;
      actorId: string;
      ttlSeconds?: number;
    },
  ) {}

  get id() {
    return this.options.repoId;
  }

  async getReadRemote(ref: string): Promise<SandboxRepoRemote> {
    const remote = await this.repo.getRemoteUrl({
      actorId: this.options.actorId,
      access: "read",
      ttlSeconds: this.options.ttlSeconds,
    });
    return {
      fetchUrl: remote.fetchUrl,
      ref,
    };
  }
}

function withBasicAuth(url: string, username: string, password: string) {
  const target = new URL(url);
  target.username = username;
  target.password = password;
  return target.toString();
}
