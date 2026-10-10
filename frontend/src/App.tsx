import React from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Header } from "./components/Header";
import { HomePage } from "./pages/HomePage";
import { ConsentPage } from "./pages/ConsentPage";
import { PortalPage } from "./pages/PortalPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { PrivacyConfirmPage } from "./pages/PrivacyConfirmPage";
import { AdminPage } from "./pages/AdminPage";
import { AdminCustomerDetailPage } from "./pages/AdminCustomerDetailPage";

const ScrollToTop: React.FC = () => {
  const { pathname } = useLocation();

  React.useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [pathname]);

  return null;
};

const AppContent: React.FC = () => {
  const location = useLocation();
  const isAdmin = location.pathname.startsWith("/admin");

  return (
    <>
      <ScrollToTop />
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      {!isAdmin && <Header />}
      <main
        style={
          isAdmin
            ? { minHeight: "100vh", padding: 0, width: "100%", maxWidth: "100vw", overflowX: "clip" }
            : { minHeight: "calc(100vh - 70px)", padding: "16px 0", width: "100%", maxWidth: "100vw", overflowX: "clip" }
        }
      >
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/consent/:token" element={<ConsentPage />} />
          <Route path="/portal/:token" element={<PortalPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/privacy/confirm/:token" element={<PrivacyConfirmPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/admin/customers" element={<AdminPage initialTab="cases" />} />
          <Route path="/admin/reviews" element={<AdminPage initialTab="reviews" />} />
          <Route path="/admin/audit" element={<AdminPage initialTab="audit" />} />
          <Route path="/admin/customers/:id" element={<AdminCustomerDetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
};

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
};

export default App;
