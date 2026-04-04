export interface MachineAuthConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  audience: string;
  scopes: string[];
  tokenEndpoint?: string;
  fetchImpl?: (input: RequestInfo | URL | Request, init?: RequestInit) => Promise<Response>;
  refreshWindowSeconds?: number;
}

export interface AccessToken {
  token: string;
  tokenType: "Bearer";
  expiresAt: number;
  scope: string[];
  audience: string;
  clientId: string;
}

export interface MachineAuthClient {
  getAccessToken(): Promise<AccessToken>;
  getAuthorizationHeader(): Promise<string>;
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  audience?: string;
  client_id?: string;
  error?: string;
  error_description?: string;
}

function base64BasicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

function splitScopes(scope: string | undefined, fallback: string[]): string[] {
  return scope?.split(/\s+/).map((item) => item.trim()).filter(Boolean) ?? [...fallback];
}

export function createMachineAuthClient(config: MachineAuthConfig): MachineAuthClient {
  const tokenEndpoint = config.tokenEndpoint ?? new URL("/oauth/token", config.issuer).toString();
  const fetchImpl = config.fetchImpl ?? fetch;
  const refreshWindowSeconds = config.refreshWindowSeconds ?? 30;
  let cachedToken: AccessToken | null = null;
  let inflight: Promise<AccessToken> | null = null;

  const shouldRefresh = (token: AccessToken) => {
    const refreshAt = token.expiresAt - refreshWindowSeconds * 1000;
    return Date.now() >= refreshAt;
  };

  const requestToken = async (): Promise<AccessToken> => {
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("scope", config.scopes.join(" "));
    body.set("audience", config.audience);

    const response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: {
        authorization: base64BasicAuth(config.clientId, config.clientSecret),
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const data = (await response.json()) as TokenResponse;
    if (!response.ok) {
      throw new Error(data.error_description ?? data.error ?? `Token request failed: ${response.status}`);
    }
    if (!data.access_token) {
      throw new Error("Token response missing access_token");
    }

    const expiresIn = Number(data.expires_in ?? 0);
    const expiresAt = Date.now() + Math.max(1, expiresIn) * 1000;

    return {
      token: data.access_token,
      tokenType: (data.token_type ?? "Bearer") as "Bearer",
      expiresAt,
      scope: splitScopes(data.scope, config.scopes),
      audience: data.audience ?? config.audience,
      clientId: data.client_id ?? config.clientId,
    };
  };

  const getAccessToken = async (): Promise<AccessToken> => {
    if (cachedToken && !shouldRefresh(cachedToken)) {
      return cachedToken;
    }
    if (!inflight) {
      inflight = requestToken().finally(() => {
        inflight = null;
      });
    }
    cachedToken = await inflight;
    return cachedToken;
  };

  return {
    getAccessToken,
    async getAuthorizationHeader() {
      const token = await getAccessToken();
      return `Bearer ${token.token}`;
    },
  };
}
