import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ApiError,
  createLoginAttempt,
  fetchLoginAttempt,
  fetchLatestMagicLink,
  fetchMe,
  loginWithTotp,
  redeemLoginAttempt,
  type AuthMeResponse,
  type AuthOnboardingState,
  type LoginAttempt,
  type MagicLinkPreview,
} from "@/lib/api";

export type AuthSessionStatus = "loading" | "signed_out" | "authenticated" | "error";

export type AuthLifecycleState =
  | "loading"
  | "signed_out"
  | "pending_passkey"
  | "pending_recovery_factor"
  | "active"
  | "unknown"
  | "error";

export interface AuthSessionContextValue {
  status: AuthSessionStatus;
  me: AuthMeResponse | null;
  error: string | null;
  refreshSession: () => Promise<void>;
  startLoginAttempt: (email: string, clientId: string) => Promise<LoginAttempt>;
  pollLoginAttempt: (attemptId: string) => Promise<LoginAttempt>;
  redeemLoginGrant: (attemptId: string, loginGrant: string) => Promise<void>;
  peekMagicLink: (email: string) => Promise<MagicLinkPreview | null>;
}

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

const DEV_AUTO_LOGIN_EMAIL = import.meta.env.DEV
  ? (import.meta.env.VITE_DEV_AUTO_LOGIN_EMAIL?.trim().toLowerCase() ?? "")
  : "";
const DEV_AUTO_LOGIN_CODE = import.meta.env.DEV
  ? (import.meta.env.VITE_DEV_AUTO_LOGIN_CODE?.trim() ?? "000000")
  : "";

function shouldUseDevAutoLogin(): boolean {
  if (!import.meta.env.DEV) return false;
  if (!DEV_AUTO_LOGIN_EMAIL) return false;
  if (typeof window === "undefined") return false;
  return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
}

function normalizeOnboardingState(value: unknown): AuthOnboardingState | "unknown" {
  if (value === "pending_passkey" || value === "pending_recovery_factor" || value === "active") {
    return value;
  }
  return "unknown";
}

export function getAuthLifecycleState(
  status: AuthSessionStatus,
  me: AuthMeResponse | null,
): AuthLifecycleState {
  if (status === "loading") return "loading";
  if (status === "error") return "error";
  if (!me) return "signed_out";
  return normalizeOnboardingState(me.user.onboardingState);
}

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthSessionStatus>("loading");
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoLoginAttempted, setAutoLoginAttempted] = useState(false);

  const refreshSession = useCallback(async () => {
    try {
      const next = await fetchMe();
      setMe(next);
      setStatus("authenticated");
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
        setMe(null);
        setStatus("signed_out");
        setError(null);
        return;
      }
      setMe(null);
      setStatus("error");
      setError(err instanceof Error ? err.message : "Unable to load session");
    }
  }, []);

  const startLoginAttempt = useCallback(async (email: string, clientId: string) => {
    return createLoginAttempt(email, clientId);
  }, []);

  const pollLoginAttempt = useCallback(async (attemptId: string) => {
    return fetchLoginAttempt(attemptId);
  }, []);

  const redeemLoginGrant = useCallback(async (attemptId: string, loginGrant: string) => {
    await redeemLoginAttempt({ attemptId, loginGrant });
  }, []);

  const peekMagicLink = useCallback(async (email: string) => {
    return fetchLatestMagicLink(email);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const sync = async () => {
      await refreshSession();
      if (cancelled) return;
    };

    void sync();
    const interval = setInterval(() => {
      void refreshSession();
    }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refreshSession]);

  useEffect(() => {
    if (!shouldUseDevAutoLogin()) return;
    if (status !== "signed_out") return;
    if (autoLoginAttempted) return;

    let cancelled = false;
    setAutoLoginAttempted(true);

    const autoLogin = async () => {
      try {
        await loginWithTotp(DEV_AUTO_LOGIN_EMAIL, DEV_AUTO_LOGIN_CODE);
        if (cancelled) return;
        await refreshSession();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Unable to auto-login local dev session");
      }
    };

    void autoLogin();

    return () => {
      cancelled = true;
    };
  }, [autoLoginAttempted, refreshSession, status]);

  const value = useMemo<AuthSessionContextValue>(
    () => ({
      status,
      me,
      error,
      refreshSession,
      startLoginAttempt,
      pollLoginAttempt,
      redeemLoginGrant,
      peekMagicLink,
    }),
    [status, me, error, refreshSession, startLoginAttempt, pollLoginAttempt, redeemLoginGrant, peekMagicLink],
  );

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}

export function useAuthSession() {
  const context = useContext(AuthSessionContext);
  if (!context) {
    throw new Error("useAuthSession must be used within AuthSessionProvider");
  }
  return context;
}
