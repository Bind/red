import { BrowserRouter, Navigate, Routes, Route } from "react-router";
import { Layout } from "@/components/layout";
import { Dashboard } from "@/routes/dashboard";
import { HostedRepoPage } from "@/routes/hosted-repo";
import { HostedRepoCommitPage } from "@/routes/hosted-repo-commit";
import { ChangeDetailPage } from "@/routes/change";
import { TriagePage } from "@/routes/triage";
import { StatusPage } from "@/routes/status";
import { DaemonPlaygroundPage } from "@/routes/daemon-playground";
import { Demo } from "@/components/demo";
import { AuthSessionProvider } from "@/lib/auth";
import { AuthEnrollPage } from "@/routes/auth-enroll";
import { MagicLinkPage } from "@/routes/auth-magic-link";
import { AuthYubikeyPage } from "@/routes/auth-yubikey";

export function App() {
  return (
    <AuthSessionProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="hosted-repo" element={<Navigate to="/bind/red" replace />} />
            <Route path="hosted-repo/commits/:sha" element={<Navigate to="/bind/red" replace />} />
            <Route path="changes/:id" element={<ChangeDetailPage />} />
            <Route path="triage" element={<TriagePage />} />
            <Route path="status" element={<StatusPage />} />
            <Route path="playground/daemons" element={<DaemonPlaygroundPage />} />
            <Route path="auth/enroll" element={<AuthEnrollPage />} />
            <Route path="auth/yubikey" element={<AuthYubikeyPage />} />
            <Route path="auth/magic-link" element={<MagicLinkPage />} />
            <Route path="theme" element={<Demo />} />
            <Route path=":owner/:repo" element={<HostedRepoPage />} />
            <Route path=":owner/:repo/commits/:sha" element={<HostedRepoCommitPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthSessionProvider>
  );
}
