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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

export const AddCustomerDrawer: React.FC<AddCustomerDrawerProps> = ({
  isOpen,
  onClose,
  onCustomerCreated,
  existingEmails = new Set(),
}) => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [selectedDocs, setSelectedDocs] = useState<string[]>(["pan", "aadhaar"]);
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
    initialFocusSelector: ".drawer-close-btn",
  });

  // Reset state when drawer opens
  useEffect(() => {
    if (!isOpen) return;
    queueMicrotask(() => {
      setName("");
      setEmail("");
      setMobile("");
      setSelectedDocs(["pan", "aadhaar"]);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ name: true, email: true });

    if (!isFormValid) {
      setErrorMsg("Please correct the errors in the form before submitting.");
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
    setName("");
    setEmail("");
    setMobile("");
    setSelectedDocs(["pan", "aadhaar"]);
    setSendConsentNow(true);
    setTouched({});
    setErrorMsg(null);
    setCreatedCustomer(null);
  };

  const filteredDocTypes = SUPPORTED_DOC_TYPES.filter((d) => {
    if (!docFilter) return true;
    const q = docFilter.toLowerCase();
    return (
      d.label.toLowerCase().includes(q) ||
      d.key.toLowerCase().includes(q) ||
      d.category.toLowerCase().includes(q)
    );
  });

  return (
    <div
      className="drawer-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-customer-drawer-title"
    >
      <div
        ref={drawerRef}
        className="drawer-panel"
        id="add-customer-drawer"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drawer Header */}
        <div className="drawer-header">
          <div className="drawer-title-group">
            <div className="drawer-icon-box">
              <IconUserPlus size={22} color="var(--adm-primary)" />
            </div>
            <div>
              <h2 id="add-customer-drawer-title" className="drawer-title">
                Add New Customer
              </h2>
              <p className="drawer-subtitle">
                Initiate a secure KYC / business document verification case
              </p>
            </div>
          </div>
          <button
            type="button"
            className="drawer-close-btn"
            onClick={onClose}
            aria-label="Close drawer"
          >
            <IconX size={18} />
          </button>
        </div>

        {/* Drawer Content */}
        <div className="drawer-body">
          {createdCustomer ? (
            /* Success State */
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
                  <span className="mut">Required Docs</span>
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
          ) : (
            /* Main Form */
            <form onSubmit={handleSubmit} id="add-customer-form">
              {errorMsg && (
                <div className="msg err" role="alert" style={{ marginBottom: 16 }}>
                  <IconAlertCircle size={16} />
                  <span>{errorMsg}</span>
                </div>
              )}

              {/* Name Field */}
              <div className="form-group">
                <label htmlFor="new-cust-name">
                  Full Customer Name <span className="req">*</span>
                </label>
                <input
                  id="new-cust-name"
                  type="text"
                  placeholder="e.g. Vikram Malhotra or Apex Industries Ltd"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setTouched((p) => ({ ...p, name: true }))}
                  className={nameError ? "input-err" : ""}
                  required
                />
                {nameError && <span className="field-err">{nameError}</span>}
              </div>

              {/* Email Field */}
              <div className="form-group">
                <label htmlFor="new-cust-email">
                  Email Address <span className="req">*</span>
                </label>
                <input
                  id="new-cust-email"
                  type="email"
                  placeholder="e.g. vikram.m@example.com"
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
                <span className="field-hint">
                  Used for single-use consent, upload links, and automated reminder emails.
                </span>
              </div>

              {/* Mobile Field */}
              <div className="form-group">
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
                  Supports international or Indian mobile numbers for contact records.
                </span>
              </div>

              <div className="drawer-divider" />

              {/* Document Requirement Section */}
              <div className="form-group">
                <div className="form-section-header">
                  <div>
                    <label style={{ margin: 0 }}>
                      Required Documents <span className="req">*</span>
                    </label>
                    <span className="field-hint" style={{ marginTop: 2 }}>
                      Select the specific identity or financial slots this customer must upload.
                    </span>
                  </div>
                  <span className="doc-count-badge">
                    {selectedDocs.length} selected
                  </span>
                </div>

                {docsError && (
                  <div className="field-err" style={{ marginBottom: 8 }}>
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

                {/* Doc Filter Search */}
                <div className="doc-search-box">
                  <IconSearch size={14} color="var(--adm-text-muted)" />
                  <input
                    type="search"
                    placeholder="Filter 22 supported document types…"
                    value={docFilter}
                    onChange={(e) => setDocFilter(e.target.value)}
                  />
                  {docFilter && (
                    <button
                      type="button"
                      className="doc-search-clear"
                      onClick={() => setDocFilter("")}
                    >
                      <IconX size={12} />
                    </button>
                  )}
                </div>

                {/* Checklist Grid */}
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

              <div className="drawer-divider" />

              {/* Consent Dispatch Toggle */}
              <div className="form-group">
                <label className="intake-toggle-card">
                  <input
                    type="checkbox"
                    checked={sendConsentNow}
                    onChange={(e) => setSendConsentNow(e.target.checked)}
                  />
                  <div>
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

              {/* Drawer Footer Actions */}
              <div className="drawer-footer">
                <button
                  type="submit"
                  className="ok"
                  disabled={isSubmitting || !isFormValid}
                  id="btn-submit-add-customer"
                  style={{ flex: 1, justifyContent: "center", padding: "12px 18px" }}
                >
                  {isSubmitting ? (
                    <>
                      <span className="spinner-sm" /> Creating Customer…
                    </>
                  ) : (
                    <>
                      <IconUserPlus size={16} /> Create Customer Case
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="sec"
                  onClick={onClose}
                  disabled={isSubmitting}
                  style={{ padding: "12px 18px" }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
