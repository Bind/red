export interface BetterAuthSessionUser {
  id: string;
  email: string;
  onboardingState?: string;
  recoveryReady?: boolean;
  recoveryChallengePending?: boolean;
  authAssurance?: string;
  twoFactorEnabled?: boolean;
}

export interface BetterAuthSessionRecord {
  id: string;
  sessionKind?: string;
  authPurpose?: string;
  secondFactorVerified?: boolean;
}

export interface BetterAuthSessionResult {
  response: {
    session: BetterAuthSessionRecord;
    user: BetterAuthSessionUser;
  } | null;
  headers: Headers;
}

export interface BetterAuthAdapter {
  handle(request: Request): Promise<Response>;
  getSession(request: Request): Promise<BetterAuthSessionResult>;
}

export function createBetterAuthAdapter(auth: {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: { headers: Headers; returnHeaders: true }): Promise<BetterAuthSessionResult>;
  };
}): BetterAuthAdapter {
  return {
    handle(request: Request): Promise<Response> {
      return auth.handler(request);
    },
    getSession(request: Request): Promise<BetterAuthSessionResult> {
      return auth.api.getSession({
        headers: request.headers,
        returnHeaders: true,
      });
    },
  };
}
