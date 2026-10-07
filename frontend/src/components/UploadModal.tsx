import React, { useState, useEffect, useRef } from "react";
import type { PortalDocument } from "../types";
import {
  IconFileText,
  IconUploadCloud,
  IconLock,
  IconClose,
  IconAlertCircle,
  IconCheck,
} from "./admin/AdminIcons";

interface UploadModalProps {
  isOpen: boolean;
  doc: PortalDocument | null;
  maxUploadMb: number;
  allowedTypes: string[];
  onClose: () => void;
  onUpload: (file: File) => Promise<void>;
  isUploading: boolean;
  errorMessage: string | null;
  isResubmission?: boolean;
}

export const UploadModal: React.FC<UploadModalProps> = ({
  isOpen,
  doc,
  maxUploadMb,
  allowedTypes,
  onClose,
  onUpload,
  isUploading,
  errorMessage,
  isResubmission = false,
}) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const modalCardRef = useRef<HTMLDivElement | null>(null);

  // Handle ESC key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen && !isUploading) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isUploading, onClose]);

  if (!isOpen || !doc) return null;

  const validateFile = (file: File): boolean => {
    setClientError(null);

    if (file.size === 0) {
      setClientError("The selected file is empty. Please choose a valid document.");
      return false;
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    const normalizedAllowed = allowedTypes.map((t) => t.toLowerCase().replace(/^\./, ""));
    // Ensure pdf, png, jpg, jpeg
    const standardAllowed = ["pdf", "png", "jpg", "jpeg", ...normalizedAllowed];

    if (ext && !standardAllowed.includes(ext)) {
      setClientError(
        `File format .${ext} is not supported. Please upload a PDF, PNG, or JPG document.`
      );
      return false;
    }

    const maxBytes = maxUploadMb * 1024 * 1024;
    if (file.size > maxBytes) {
      setClientError(`File exceeds maximum allowed size of ${maxUploadMb} MB.`);
      return false;
    }

    return true;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    if (file) {
      if (validateFile(file)) {
        setSelectedFile(file);
      } else {
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (isUploading) return;

    const file = e.dataTransfer.files?.[0] || null;
    if (file) {
      if (validateFile(file)) {
        setSelectedFile(file);
      } else {
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      setClientError("Please select a document file to upload.");
      return;
    }
    if (!validateFile(selectedFile)) return;
    await onUpload(selectedFile);
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const activeError = clientError || errorMessage;

  return (
    <div
      className="upload-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isUploading) {
          onClose();
        }
      }}
    >
      <div className="upload-modal-card" ref={modalCardRef}>
        {/* Modal Header */}
        <div className="upload-modal-header">
          <div className="upload-modal-title-group">
            <div className="upload-modal-icon-badge">
              <IconFileText size={20} color="var(--adm-primary, #075E5B)" />
            </div>
            <div>
              <h2 id="upload-modal-title" className="upload-modal-title">
                {isResubmission ? `Resubmit ${doc.label}` : `Upload ${doc.label}`}
              </h2>
              <div className="upload-modal-slot-meta">
                Slot: <span className="doc-card-slot-chip">{doc.doc_type}</span>
              </div>
            </div>
          </div>

          <button
            type="button"
            className="upload-modal-close-btn"
            onClick={onClose}
            disabled={isUploading}
            aria-label="Close upload modal"
            id="close-upload-modal-btn"
          >
            <IconClose size={18} />
          </button>
        </div>

        {/* Modal Guidance Subtitle */}
        <p className="upload-modal-subtitle">
          {isResubmission
            ? "Please provide an unobscured, clear and well-lit copy of your document to replace the previous submission."
            : "Select or drop your file below. Documents are cryptographically encrypted before reaching private storage."}
        </p>

        {/* Error message banner */}
        {activeError && (
          <div className="msg err upload-modal-err" role="alert">
            <IconAlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{activeError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Drag & Drop Zone */}
          <div
            className={`upload-modal-dropzone ${dragOver ? "active" : ""} ${
              selectedFile ? "has-file" : ""
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              if (!isUploading) setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => {
              if (!isUploading) fileInputRef.current?.click();
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !isUploading) {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            id="upload-modal-dropzone"
          >
            <input
              type="file"
              ref={fileInputRef}
              id={`modal-file-input-${doc.doc_type}`}
              style={{ display: "none" }}
              accept=".pdf,.png,.jpg,.jpeg"
              onChange={handleFileChange}
              disabled={isUploading}
            />

            {selectedFile ? (
              <div className="upload-selected-file-view">
                <div className="upload-file-icon-wrap">
                  <IconCheck size={24} color="var(--adm-success, #10b981)" />
                </div>
                <div className="upload-file-details">
                  <span className="upload-file-name">{selectedFile.name}</span>
                  <span className="upload-file-size">
                    {formatFileSize(selectedFile.size)} • Click to change file
                  </span>
                </div>
              </div>
            ) : (
              <div className="upload-dropzone-empty-content">
                <div className="upload-dropzone-cloud-icon">
                  <IconUploadCloud size={32} color="var(--adm-primary, #075E5B)" />
                </div>
                <div className="upload-dropzone-main-text">
                  <strong>Click to choose a file</strong> or drag and drop here
                </div>
                <div className="upload-dropzone-sub-text">
                  Supported formats: PDF, PNG, JPG (up to {maxUploadMb} MB)
                </div>
              </div>
            )}
          </div>

          {/* Security & Encryption Micro-banner */}
          <div className="upload-modal-security-note">
            <IconLock size={15} color="var(--adm-primary, #075E5B)" style={{ flexShrink: 0 }} />
            <span>
              <strong>Bank-Grade AES-256-GCM:</strong> Transmitted encrypted, verified statelessly,
              and scheduled for automatic 7-day deletion.
            </span>
          </div>

          {/* Modal Action Buttons */}
          <div className="upload-modal-footer">
            <button
              type="button"
              className="consent-btn-decline upload-modal-cancel-btn"
              onClick={onClose}
              disabled={isUploading}
              id="upload-modal-cancel"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="customer-access-btn upload-modal-submit-btn"
              disabled={!selectedFile || isUploading}
              id="upload-modal-confirm-btn"
            >
              {isUploading ? (
                <>
                  <div className="processing-spinner" style={{ width: 14, height: 14 }} />
                  <span>Encrypting &amp; Uploading…</span>
                </>
              ) : (
                <>
                  <IconUploadCloud size={16} />
                  <span>Upload &amp; Continue</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
