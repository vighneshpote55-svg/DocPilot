import React, { useState, useEffect, useRef } from "react";
import { createAdminCustomer, type CreateCustomerInput } from "../../api";
import type { AdminCustomerListItem } from "../../types";
import { useDialogA11y } from "../../utils/a11yUtils";
import {
  IconX,
  IconUserPlus,
  IconCheck,
  IconAlertCircle,
  IconShield,
  IconSearch,
  IconUser,
  IconBuilding,
} from "./AdminIcons";
import { SUPPORTED_DOC_TYPES } from "../../utils/excelImport";

interface AddCustomerDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onCustomerCreated: (customer: AdminCustomerListItem) => void;
  existingEmails?: Set<string>;
}

const PRESETS = [
  {
    id: "kyc",
    label: "Standard KYC",
    docs: ["pan", "aadhaar"],
    description: "PAN + Aadhaar Card",
  },
  {
    id: "salaried",
    label: "Salaried Individual",
    docs: ["pan", "aadhaar", "salary_slip", "bank_statement"],
    description: "KYC + Salary Slip + Bank Statement",
  },
  {
    id: "msme",
    label: "MSME / Business",
    docs: ["pan", "gst_certificate", "udyam", "bank_statement"],
    description: "PAN + GST + Udyam + Bank Statement",
  },
  {
    id: "incorporation",
    label: "Corporate / Pvt Ltd",
    docs: ["certificate_of_incorporation", "pan", "gst_certificate", "bank_statement"],
    description: "Incorp + PAN + GST + Statement",
  },
];

const CATEGORIES = ["All", "Identity", "Financial", "Business", "Address & Other"] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

export const AddCustomerDrawer: React.FC<AddCustomerDrawerProps> = ({
  isOpen,
  onClose,
  onCustomerCreated,
  existingEmails = new Set(),
}) => {
  const [customerType, setCustomerType] = useState<"individual" | "business">("individual");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [selectedDocs, setSelectedDocs] = useState<string[]>(["pan", "aadhaar"]);
  const [activeCategory, setActiveCategory] = useState<string>("All");
  const [sendConsentNow, setSendConsentNow] = useState(true);

  // Filter for doc checklist
  const [docFilter, setDocFilter] = useState("");

  // Validation & Submit State
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [createdCustomer, setCreatedCustomer] = useState<AdminCustomerListItem | null>(null);

  const drawerRef = useRef<HTMLDivElement>(null);
  useDialogA11y(isOpen && !isSubmitting, onClose, drawerRef, {
    initialFocusSelector: "#new-cust-name",
    disableBodyScroll: true,
    closeOnEscape: true,
    trapFocus: true,
  });

  // Reset state when drawer opens
  useEffect(() => {
    if (!isOpen) return;
    queueMicrotask(() => {
      setCustomerType("individual");
      setName("");
      setEmail("");
      setMobile("");
      setSelectedDocs(["pan", "aadhaar"]);
      setActiveCategory("All");
      setSendConsentNow(true);
      setTouched({});
      setErrorMsg(null);
      setCreatedCustomer(null);
      setDocFilter("");
    });
  }, [isOpen]);

  if (!isOpen) return null;

  // Validation logic
  const trimmedName = name.trim();
  const trimmedEmail = email.trim().toLowerCase();
  const nameError = touched.name && !trimmedName ? "Customer name is required" : null;
  const emailError =
    touched.email && !trimmedEmail
      ? "Email address is required"
      : touched.email && !EMAIL_RE.test(trimmedEmail)
      ? "Please enter a valid email address"
      : null;
  const duplicateEmailWarning =
    trimmedEmail && existingEmails.has(trimmedEmail)
      ? "A customer with this email already exists in DocPilot"
      : null;
  const docsError =
    selectedDocs.length === 0 ? "Select at least one required document" : null;

  const isFormValid =
    trimmedName.length >= 2 &&
    EMAIL_RE.test(trimmedEmail) &&
    selectedDocs.length > 0;

  const handleToggleDoc = (key: string) => {
    if (selectedDocs.includes(key)) {
      setSelectedDocs(selectedDocs.filter((x) => x !== key));
    } else {
      setSelectedDocs([...selectedDocs, key]);
    }
  };

  const handleApplyPreset = (docs: string[]) => {
    setSelectedDocs(docs);
  };

  const handleRemoveDoc = (key: string) => {
    setSelectedDocs(selectedDocs.filter((x) => x !== key));
  };

  const handleTypeChange = (type: "individual" | "business") => {
    setCustomerType(type);
    if (type === "individual") {
      setSelectedDocs(["pan", "aadhaar"]);
    } else {
      setSelectedDocs(["pan", "gst_certificate", "udyam", "bank_statement"]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ name: true, email: true });

    if (!isFormValid) {
      setErrorMsg("Please complete all required fields correctly before submitting.");
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    const payload: CreateCustomerInput = {
      name: trimmedName,
      email: trimmedEmail,
      mobile: mobile.trim() || null,
      required_documents: selectedDocs,
      send_consent: sendConsentNow,
    };

    try {
      const result = await createAdminCustomer(payload);
      setCreatedCustomer(result);
      setIsSubmitting(false);
      onCustomerCreated(result);
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : "Failed to create customer case."
      );
      setIsSubmitting(false);
    }
  };

  const handleResetForNext = () => {
    setCustomerType("individual");
    setName("");
    setEmail("");
    setMobile("");
    setSelectedDocs(["pan", "aadhaar"]);
    setActiveCategory("All");
    setSendConsentNow(true);
    setTouched({});
    setErrorMsg(null);
    setCreatedCustomer(null);
    setDocFilter("");
  };

  const filteredDocTypes = SUPPORTED_DOC_TYPES.filter((d) => {
    const matchesCat = activeCategory === "All" || d.category === activeCategory;
    if (!matchesCat) return false;
    if (!docFilter) return true;
    const q = docFilter.toLowerCase();
    return (
      d.label.toLowerCase().includes(q) ||
      d.key.toLowerCase().includes(q) ||
      d.category.toLowerCase().includes(q) ||
      d.description.toLowerCase().includes(q)
    );
  });

  return (
    <div
      className="modal-backdrop add-customer-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-customer-modal-title"
    >
      <div
        ref={drawerRef}
        className="modal-box add-customer-modal"
        id="add-customer-drawer"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="modal-header add-customer-modal-header">
          <div className="modal-header-icon">
            <IconUserPlus size={22} color="var(--adm-primary)" />
          </div>
          <div className="modal-header-text">
            <h2 id="add-customer-modal-title" className="modal-title">
              Add New Customer
            </h2>
            <p className="modal-subtitle">
              Initiate a secure document verification case
            </p>
          </div>
          <button
            type="button"
            className="modal-close-btn drawer-close-btn"
            onClick={onClose}
            aria-label="Close modal"
          >
            <IconX size={18} />
          </button>
        </div>

        {/* Modal Body / Success Card or Form */}
        {createdCustomer ? (
          <div className="modal-body add-customer-modal-body">
            {/* Success State */}
            <div className="intake-success-card">
              <div className="intake-success-icon-wrap">
                <IconCheck size={36} color="var(--adm-success)" />
              </div>
              <h3 className="intake-success-title">Customer Case Created!</h3>
              <p className="intake-success-desc">
                Case registered successfully for <b>{createdCustomer.name}</b>.
              </p>

              <div className="intake-success-details">
                <div className="intake-success-detail-row">
                  <span className="mut">Case Code</span>
                  <span className="intake-code-badge">{createdCustomer.code}</span>
                </div>
                <div className="intake-success-detail-row">
                  <span className="mut">Email Address</span>
                  <span>{createdCustomer.email}</span>
                </div>
                <div className="intake-success-detail-row">
                  <span className="mut">Required Documents</span>
                  <span>{createdCustomer.required_count} items</span>
                </div>
                <div className="intake-success-detail-row">
                  <span className="mut">Consent Status</span>
                  <span className={`tag ${createdCustomer.consent_status}`}>
                    {createdCustomer.consent_status}
                  </span>
                </div>
              </div>

              {sendConsentNow && (
                <div className="intake-consent-notice">
                  <IconShield size={16} color="var(--adm-primary)" />
                  <span>
                    A secure consent authorization link has been scheduled and dispatched to{" "}
                    <b>{createdCustomer.email}</b>.
                  </span>
                </div>
              )}

              <div className="intake-success-actions">
                <button
                  type="button"
                  className="ok"
                  onClick={handleResetForNext}
                  style={{ width: "100%", justifyContent: "center" }}
                >
                  <IconUserPlus size={16} /> Add Another Customer
                </button>
                <button
                  type="button"
                  className="sec"
                  onClick={onClose}
                  style={{ width: "100%", justifyContent: "center" }}
                >
                  Close & View in Customer Table
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Form Wrapping Scrollable Body & Sticky Footer */
          <form onSubmit={handleSubmit} id="add-customer-form" className="add-customer-form-wrapper">
            <div className="modal-body add-customer-modal-body">
              {errorMsg && (
                <div className="msg err" role="alert" style={{ marginBottom: 16 }}>
                  <IconAlertCircle size={16} />
                  <span>{errorMsg}</span>
                </div>
              )}

              {/* 1. Customer Information */}
              <div className="add-cust-section">
                <div className="add-cust-section-title">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="section-num-badge">1</span>
                    <span className="section-title-text">Customer Information</span>
                  </div>
                </div>

                {/* Customer Account Type Toggle */}
                <div className="form-group" style={{ marginBottom: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 700, color: "var(--adm-text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    Account Type
                  </label>
                  <div className="customer-type-toggle">
                    <button
                      type="button"
                      className={`customer-type-btn ${customerType === "individual" ? "active" : ""}`}
                      onClick={() => handleTypeChange("individual")}
                    >
                      <IconUser size={16} />
                      <span>Individual Customer</span>
                    </button>
                    <button
                      type="button"
                      className={`customer-type-btn ${customerType === "business" ? "active" : ""}`}
                      onClick={() => handleTypeChange("business")}
                    >
                      <IconBuilding size={16} />
                      <span>Business / Corporate / MSME</span>
                    </button>
                  </div>
                </div>

                <div className="form-row-2col">
                  <div className="form-group">
                    <label htmlFor="new-cust-name">
                      Full Customer Name <span className="req">*</span>
                    </label>
                    <input
                      id="new-cust-name"
                      type="text"
                      placeholder={customerType === "individual" ? "e.g. Vikram Malhotra" : "e.g. Apex Industries Ltd"}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      onBlur={() => setTouched((p) => ({ ...p, name: true }))}
                      className={nameError ? "input-err" : ""}
                      required
                    />
                    {nameError && <span className="field-err">{nameError}</span>}
                  </div>

                  <div className="form-group">
                    <label htmlFor="new-cust-email">
                      Email Address <span className="req">*</span>
                    </label>
                    <input
                      id="new-cust-email"
                      type="email"
                      placeholder="e.g. customer@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onBlur={() => setTouched((p) => ({ ...p, email: true }))}
                      className={emailError ? "input-err" : ""}
                      required
                    />
                    {emailError && <span className="field-err">{emailError}</span>}
                    {duplicateEmailWarning && !emailError && (
                      <span className="field-warn">
                        <IconAlertCircle size={13} /> {duplicateEmailWarning}
                      </span>
                    )}
                  </div>
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label htmlFor="new-cust-mobile">
                    Mobile Number <span className="mut" style={{ fontWeight: 400 }}>(Optional)</span>
                  </label>
                  <input
                    id="new-cust-mobile"
                    type="tel"
                    placeholder="e.g. +91 98765 43210"
                    value={mobile}
                    onChange={(e) => setMobile(e.target.value)}
                  />
                  <span className="field-hint">
                    Customer receives single-use consent, document upload links, and automated reminders via email.
                  </span>
                </div>
              </div>

              <div className="add-cust-divider" />

              {/* 2. Required Documents */}
              <div className="add-cust-section">
                <div className="add-cust-section-title">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="section-num-badge">2</span>
                    <span className="section-title-text">Required Documents</span>
                    <span className="req">*</span>
                  </div>
                  <span className="doc-count-badge">
                    {selectedDocs.length} selected
                  </span>
                </div>

                {docsError && (
                  <div className="field-err" style={{ marginBottom: 4 }}>
                    {docsError}
                  </div>
                )}

                {/* Preset Chips */}
                <div className="preset-chips-row">
                  <span className="preset-label">Presets:</span>
                  {PRESETS.map((preset) => {
                    const isActive =
                      preset.docs.length === selectedDocs.length &&
                      preset.docs.every((d) => selectedDocs.includes(d));
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className={`preset-chip ${isActive ? "active" : ""}`}
                        onClick={() => handleApplyPreset(preset.docs)}
                        title={preset.description}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="preset-chip clear"
                    onClick={() => setSelectedDocs([])}
                  >
                    Clear All
                  </button>
                </div>

                {/* Selected Documents Chips Summary Bar */}
                {selectedDocs.length > 0 && (
                  <div className="selected-docs-summary-bar">
                    <span style={{ fontWeight: 600, color: "var(--adm-primary)" }}>
                      Selected ({selectedDocs.length}):
                    </span>
                    {selectedDocs.map((docKey) => {
                      const dt = SUPPORTED_DOC_TYPES.find((d) => d.key === docKey);
                      return (
                        <span key={docKey} className="selected-doc-pill">
                          <IconCheck size={12} />
                          <span>{dt?.label || docKey}</span>
                          <button
                            type="button"
                            className="selected-doc-pill-remove"
                            onClick={() => handleRemoveDoc(docKey)}
                            title={`Remove ${dt?.label || docKey}`}
                            aria-label={`Remove ${dt?.label || docKey}`}
                          >
                            <IconX size={12} />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* Category Filter Pills & Search in one responsive toolbar */}
                <div className="doc-filter-toolbar">
                  <div className="doc-category-tabs">
                    {CATEGORIES.map((cat) => {
                      const count =
                        cat === "All"
                          ? SUPPORTED_DOC_TYPES.length
                          : SUPPORTED_DOC_TYPES.filter((d) => d.category === cat).length;
                      return (
                        <button
                          key={cat}
                          type="button"
                          className={`doc-category-tab ${activeCategory === cat ? "active" : ""}`}
                          onClick={() => setActiveCategory(cat)}
                        >
                          {cat} ({count})
                        </button>
                      );
                    })}
                  </div>

                  <div className="doc-search-box">
                    <IconSearch size={14} color="var(--adm-text-muted)" />
                    <input
                      type="search"
                      placeholder="Search documents…"
                      value={docFilter}
                      onChange={(e) => setDocFilter(e.target.value)}
                      id="doc-filter-input"
                    />
                    {docFilter && (
                      <button
                        type="button"
                        className="doc-search-clear"
                        onClick={() => setDocFilter("")}
                        aria-label="Clear document filter"
                      >
                        <IconX size={12} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Document Selection Grid */}
                <div className="doc-selection-grid">
                  {filteredDocTypes.map((dt) => {
                    const isChecked = selectedDocs.includes(dt.key);
                    return (
                      <label
                        key={dt.key}
                        className={`doc-check-card ${isChecked ? "selected" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleToggleDoc(dt.key)}
                        />
                        <div className="doc-card-info">
                          <div className="doc-card-title-row">
                            <span className="doc-card-name">{dt.label}</span>
                            <span className="doc-card-cat">{dt.category}</span>
                          </div>
                          <span className="doc-card-desc">{dt.description}</span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="add-cust-divider" />

              {/* 3. Consent & Notifications */}
              <div className="add-cust-section">
                <div className="add-cust-section-title">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="section-num-badge">3</span>
                    <span className="section-title-text">Consent & Notifications</span>
                  </div>
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className={`intake-toggle-card ${sendConsentNow ? "active" : ""}`} htmlFor="send-consent-toggle">
                    <input
                      type="checkbox"
                      id="send-consent-toggle"
                      checked={sendConsentNow}
                      onChange={(e) => setSendConsentNow(e.target.checked)}
                    />
                    <div className="intake-toggle-content">
                      <div className="intake-toggle-title">
                        Send consent authorization email immediately
                      </div>
                      <div className="intake-toggle-desc">
                        Dispatches the cryptographic single-use consent URL to the customer. When
                        consent is granted, their document upload link activates.
                      </div>
                    </div>
                  </label>
                </div>
              </div>
            </div>

            {/* Sticky Modal Footer */}
            <div className="modal-footer add-customer-modal-footer">
              <button
                type="button"
                className="sec btn-modal-cancel"
                onClick={onClose}
                disabled={isSubmitting}
                id="btn-cancel-add-customer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="ok btn-modal-submit"
                disabled={isSubmitting || !isFormValid}
                id="btn-submit-add-customer"
              >
                {isSubmitting ? (
                  <>
                    <span className="spinner-sm" /> Creating Customer…
                  </>
                ) : (
                  <>
                    <IconUserPlus size={16} /> Create Customer Case ({selectedDocs.length} doc{selectedDocs.length === 1 ? "" : "s"})
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
