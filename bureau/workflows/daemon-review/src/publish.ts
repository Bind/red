import type { Repo } from "../../../../apps/grs/src/core/api";
import type { FixupRemote } from "./proposals";

export async function fixupRemoteFromRepo(
  repo: Repo,
  actorId: string,
  options: {
    ttlSeconds?: number;
    branchUrl?: (branchName: string) => string | null;
  } = {},
): Promise<FixupRemote> {
  const remote = await repo.getRemoteUrl({
    actorId,
    access: "write",
    ttlSeconds: options.ttlSeconds,
  });
  return {
    fetchUrl: remote.fetchUrl,
    pushUrl: remote.pushUrl,
    branchUrl: options.branchUrl,
  };
}
