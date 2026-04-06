import { BrowserRouter, Routes, Route } from "react-router";
import { Layout } from "@/components/layout";
import { Dashboard } from "@/routes/dashboard";
import { ChangeDetailPage } from "@/routes/change";
import { Demo } from "@/components/demo";
import { AuthSessionProvider } from "@/lib/auth";
import { MagicLinkPage } from "@/routes/auth-magic-link";

export function App() {
  return (
    <AuthSessionProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="changes/:id" element={<ChangeDetailPage />} />
          <Route path="auth/magic-link" element={<MagicLinkPage />} />
          <Route path="theme" element={<Demo />} />
        </Route>
        </Routes>
      </BrowserRouter>
    </AuthSessionProvider>
  );
}
