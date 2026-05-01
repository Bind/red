import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, Outlet } from "react-router";
import { Badge } from "@/components/ui/badge";

import { fetchPendingJobs } from "@/lib/api";
import { useAuthSession } from "@/lib/auth";

const HeaderContentContext = createContext<(node: ReactNode | null) => void>(() => {});

export function useHeaderContent() {
  return useContext(HeaderContentContext);
}

export function Layout() {
  const [pendingJobs, setPendingJobs] = useState<number | null>(null);
  const [headerContent, setHeaderContent] = useState<ReactNode | null>(null);
  const { status, me, error } = useAuthSession();

  const setHeader = useCallback((node: ReactNode | null) => {
    setHeaderContent(node);
  }, []);

  useEffect(() => {
    fetchPendingJobs().then((data) => setPendingJobs(data.pending)).catch(() => {});
    const interval = setInterval(() => {
      fetchPendingJobs().then((data) => setPendingJobs(data.pending)).catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-depth sticky top-0 z-10 border-b border-border">
        <div className="mx-auto max-w-5xl px-4">
          <div className="flex h-10 items-center gap-4">
            <Link to="/" className="text-sm font-semibold tracking-tight text-foreground">
              red
            </Link>
            <nav className="flex items-center gap-3 text-xs text-muted-foreground">
              <Link to="/bind/red" className="transition-colors hover:text-foreground">repo</Link>
              <Link to="/triage" className="transition-colors hover:text-foreground">triage</Link>
              <Link to="/status" className="transition-colors hover:text-foreground">status</Link>
              <Link to="/playground/daemons" className="transition-colors hover:text-foreground">playground</Link>
            </nav>
            <div className="ml-auto flex items-center gap-2">
              {pendingJobs !== null && pendingJobs > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {pendingJobs} job{pendingJobs !== 1 ? "s" : ""} pending
                </Badge>
              )}
              {me?.user.email && (
                <span className="font-mono text-xs text-muted-foreground">{me.user.email}</span>
              )}
              {error && <span className="text-xs text-muted-foreground">{error}</span>}
            </div>
          </div>
          {headerContent && <div className="pb-2">{headerContent}</div>}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <HeaderContentContext.Provider value={setHeader}>
          <Outlet />
        </HeaderContentContext.Provider>
      </main>
    </div>
  );
}
