import React, { useEffect, useState, useCallback, useRef } from "react";
import { fetchDocumentFile } from "../../api";
import {
  IconX,
  IconDownload,
  IconShieldCheck,
  IconZoomIn,
  IconZoomOut,
  IconRotateCw,
  IconAlertCircle,
  IconRefreshCw,
  IconFileText,
} from "./AdminIcons";

interface SecureDocViewerModalProps {
  isOpen: boolean;
  docId: string | null;
  title?: string;
  filename?: string;
  label?: string;
  allowDownload?: boolean;
  onClose: () => void;
}

export const SecureDocViewerModal: React.FC<SecureDocViewerModalProps> = ({
  isOpen,
  docId,
  title,
  filename,
  label,
  allowDownload = false,
  onClose,
}) => {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(100);
  const [rotation, setRotation] = useState<number>(0);
  const blobUrlRef = useRef<string | null>(null);

  const cleanupUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setBlobUrl(null);
  }, []);

  const loadDocument = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
      setBlobUrl(null);
    }

    try {
      const blob = await fetchDocumentFile(id, false);
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      setBlobUrl(url);
      setMimeType(blob.type || "");
      setLoading(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to decrypt and load document stream.");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen && docId) {
      queueMicrotask(() => {
        loadDocument(docId);
      });
    } else {
      cleanupUrl();
      setZoom(100);
      setRotation(0);
    }
    return () => {
      cleanupUrl();
    };
  }, [isOpen, docId, loadDocument, cleanupUrl]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleDownload = async () => {
    if (!docId) return;
    try {
      const blob = await fetchDocumentFile(docId, true);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "document";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to download document file.");
    }
  };

  if (!isOpen) return null;

  const isImage =
    mimeType.startsWith("image/") ||
    (filename && /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(filename));

  const displayTitle = title || (label && filename ? `${label} - ${filename}` : label || filename || "Secure Document Preview");

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      id="secure-viewer-backdrop"
    >
      <div
        className="modal-box modal-xl secure-viewer-box"
        id="secure-doc-viewer-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Viewer Header */}
        <div className="secure-viewer-header">
          <div className="secure-viewer-header-left">
            <div className="secure-viewer-icon">
              <IconFileText size={20} color="var(--adm-primary)" />
            </div>
            <div>
              <div className="secure-viewer-title-row">
                <h3 className="secure-viewer-title">{displayTitle}</h3>
                <span className="secure-badge">
                  <IconShieldCheck size={12} color="var(--adm-success)" />
                  AES-256-GCM Decrypted
                </span>
              </div>
              {filename && <p className="secure-viewer-subtitle">{filename}</p>}
            </div>
          </div>

          <div className="secure-viewer-header-actions">
            {isImage && !loading && !error && (
              <div className="viewer-toolbar">
                <button
                  type="button"
                  className="viewer-tool-btn"
                  onClick={() => setZoom((z) => Math.max(50, z - 25))}
                  title="Zoom Out"
                  aria-label="Zoom Out"
                >
                  <IconZoomOut size={16} />
                </button>
                <span className="viewer-zoom-label">{zoom}%</span>
                <button
                  type="button"
                  className="viewer-tool-btn"
                  onClick={() => setZoom((z) => Math.min(250, z + 25))}
                  title="Zoom In"
                  aria-label="Zoom In"
                >
                  <IconZoomIn size={16} />
                </button>
                <button
                  type="button"
                  className="viewer-tool-btn"
                  onClick={() => setRotation((r) => (r + 90) % 360)}
                  title="Rotate Clockwise"
                  aria-label="Rotate Clockwise"
                >
                  <IconRotateCw size={16} />
                </button>
              </div>
            )}

            {allowDownload && (
              <button
                type="button"
                className="btn sec viewer-download-btn"
                onClick={handleDownload}
                title="Download original file safely"
              >
                <IconDownload size={14} />
                <span>Download</span>
              </button>
            )}

            <button
              type="button"
              className="modal-close-btn"
              onClick={onClose}
              aria-label="Close document viewer"
              id="close-secure-viewer-btn"
            >
              <IconX size={18} />
            </button>
          </div>
        </div>

        {/* Viewer Content Area */}
        <div className="secure-viewer-body">
          {loading && (
            <div className="viewer-loading-state">
              <div className="spinner" style={{ width: 36, height: 36 }} />
              <p className="viewer-loading-text">
                Decrypting and streaming document securely...
              </p>
              <span className="viewer-loading-subtext">
                Encrypted in private storage • Decrypted in memory • Zero raw disk persistence
              </span>
            </div>
          )}

          {error && !loading && (
            <div className="viewer-error-state">
              <IconAlertCircle size={40} color="var(--adm-danger)" />
              <p className="viewer-error-title">Unable to preview document</p>
              <p className="viewer-error-msg">{error}</p>
              <button
                type="button"
                className="btn sec"
                onClick={() => {
                  if (docId) loadDocument(docId);
                }}
                style={{ marginTop: 12 }}
              >
                <IconRefreshCw size={14} /> Retry Decryption
              </button>
            </div>
          )}

          {!loading && !error && blobUrl && (
            <div className="viewer-render-area">
              {isImage ? (
                <div className="viewer-image-wrapper">
                  <img
                    src={blobUrl}
                    alt={displayTitle}
                    className="viewer-image"
                    style={{
                      transform: `scale(${zoom / 100}) rotate(${rotation}deg)`,
                      transition: "transform 0.15s ease",
                    }}
                  />
                </div>
              ) : (
                <iframe
                  src={blobUrl}
                  title="Decrypted Document Preview"
                  className="viewer-iframe"
                  id="secure-viewer-iframe"
                />
              )}
            </div>
          )}
        </div>

        {/* Viewer Footer */}
        <div className="secure-viewer-footer">
          <div className="secure-footer-notice">
            <IconShieldCheck size={14} color="var(--adm-success)" />
            <span>
              Audited Stream: This view event has been logged to the compliance audit trail. Documents are never cached unencrypted.
            </span>
          </div>
          <button type="button" className="btn sec" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
