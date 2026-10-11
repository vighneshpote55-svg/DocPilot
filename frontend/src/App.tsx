import React from "react";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { Header } from "./components/Header";
import { HomePage } from "./pages/HomePage";
import { ConsentPage } from "./pages/ConsentPage";
import { PortalPage } from "./pages/PortalPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { PrivacyConfirmPage } from "./pages/PrivacyConfirmPage";
import { AdminPage } from "./pages/AdminPage";
import { AdminCustomerDetailPage } from "./pages/AdminCustomerDetailPage";
import { TermsPage } from "./pages/TermsPage";
import { NotFoundPage } from "./pages/NotFoundPage";

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
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/admin/customers" element={<AdminPage initialTab="cases" />} />
          <Route path="/admin/documents" element={<AdminPage initialTab="documents" />} />
          <Route path="/admin/reviews" element={<AdminPage initialTab="reviews" />} />
          <Route path="/admin/reminders" element={<AdminPage initialTab="reminders" />} />
          <Route path="/admin/retention" element={<AdminPage initialTab="retention" />} />
          <Route path="/admin/audit" element={<AdminPage initialTab="audit" />} />
          <Route path="/admin/reports" element={<AdminPage initialTab="reports" />} />
          <Route path="/admin/settings" element={<AdminPage initialTab="settings" />} />
          <Route path="/admin/customers/:id" element={<AdminCustomerDetailPage />} />
          <Route path="*" element={<NotFoundPage />} />
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
