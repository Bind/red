import { BrowserRouter, Routes, Route } from "react-router";
import { Layout } from "@/components/layout";
import { Dashboard } from "@/routes/dashboard";
import { ChangeDetailPage } from "@/routes/change";
import { Demo } from "@/components/demo";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="changes/:id" element={<ChangeDetailPage />} />
          <Route path="theme" element={<Demo />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
