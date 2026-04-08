export function basicAuthHeader(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
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
