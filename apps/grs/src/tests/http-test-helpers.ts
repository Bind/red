import { signAccessToken, type RepoAccess } from "../core/auth";

export function basicAuthHeader(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export function buildRepoCredentials(
  secret: string,
  repoId: string,
  actorId: string,
  access: RepoAccess,
  ttlSeconds = 300,
) {
  return {
    username: actorId,
    password: signAccessToken({
      secret,
      actorId,
      repoId,
      access,
      ttlSeconds,
    }),
  };
}

export function buildRemoteUrl(
  publicUrl: string,
  secret: string,
  repoId: string,
  actorId: string,
  access: RepoAccess,
  ttlSeconds = 300,
) {
  const [owner, name] = repoId.split("/", 2);
  if (!owner || !name) throw new Error(`Invalid repoId: ${repoId}`);
  const credentials = buildRepoCredentials(secret, repoId, actorId, access, ttlSeconds);
  const url = new URL(`/${owner}/${name}.git`, publicUrl);
  url.username = credentials.username;
  url.password = credentials.password;
  return {
    ...credentials,
    url: url.toString(),
    fetchUrl: url.toString(),
    pushUrl: url.toString(),
  };
}

export async function fetchJson<T>(url: URL | string, auth?: { username: string; password: string }) {
  const response = await fetch(url, {
    headers: auth
      ? {
          Authorization: basicAuthHeader(auth.username, auth.password),
        }
      : undefined,
  });

  const body = await response.text();
  return {
    response,
    body,
    json: body ? JSON.parse(body) as T : null,
  };
}
