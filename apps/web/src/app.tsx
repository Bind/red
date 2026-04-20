import { BrowserRouter, Routes, Route } from "react-router";
import { Layout } from "@/components/layout";
import { HostedRepoPage } from "@/routes/hosted-repo";
import { HostedRepoCommitPage } from "@/routes/hosted-repo-commit";
import { ChangeDetailPage } from "@/routes/change";
import { TriagePage } from "@/routes/triage";
import { Demo } from "@/components/demo";
import { AuthSessionProvider } from "@/lib/auth";
import { MagicLinkPage } from "@/routes/auth-magic-link";

export function App() {
  return (
    <AuthSessionProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HostedRepoPage />} />
            <Route path="hosted-repo/commits/:sha" element={<HostedRepoCommitPage />} />
            <Route path="changes/:id" element={<ChangeDetailPage />} />
            <Route path="triage" element={<TriagePage />} />
            <Route path="auth/magic-link" element={<MagicLinkPage />} />
            <Route path="theme" element={<Demo />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthSessionProvider>
  );
}
