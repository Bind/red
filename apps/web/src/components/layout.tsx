import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, Outlet } from "react-router";
import { Badge } from "@/components/ui/badge";

import { fetchPendingJobs } from "@/lib/api";

const HeaderContentContext = createContext<(node: ReactNode | null) => void>(() => {});

export function useHeaderContent() {
  return useContext(HeaderContentContext);
}

export function Layout() {
  const [pendingJobs, setPendingJobs] = useState<number | null>(null);
  const [headerContent, setHeaderContent] = useState<ReactNode | null>(null);

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
      <header className="border-b border-border bg-background">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:py-12">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <Link to="/" className="group">
                <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                  red
                </h1>
              </Link>
            </div>
            {pendingJobs !== null && pendingJobs > 0 && (
              <Badge variant="secondary" className="mt-1">
                {pendingJobs} job{pendingJobs !== 1 ? "s" : ""} pending
              </Badge>
            )}
          </div>
          {headerContent}
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
