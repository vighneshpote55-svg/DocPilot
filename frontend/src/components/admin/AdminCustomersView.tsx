import React, { useState } from "react";
import { Link } from "react-router-dom";
import type { AdminCustomerListItem } from "../../types";
import {
  IconSearch,
  IconRefreshCw,
  IconPlus,
  IconFileSpreadsheet,
  IconEye,
  IconCheck,
  IconUsers,
} from "./AdminIcons";

interface AdminCustomersViewProps {
  customers: AdminCustomerListItem[];
  totalCount: number;
  loading: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSearchSubmit: (e: React.FormEvent) => void;
  caseStatusFilter: string;
  onStatusFilterChange: (status: string) => void;
  page: number;
  pageSize: number;
  onPageChange: (newPage: number) => void;
  onResetFilters: () => void;
  onOpenAddCustomer: () => void;
  onOpenBulkImport: () => void;
  onOpenCustomerDetail: (customerId: number) => void;
}

export const AdminCustomersView: React.FC<AdminCustomersViewProps> = ({
  customers,
  totalCount,
  loading,
  searchQuery,
  onSearchChange,
  onSearchSubmit,
  caseStatusFilter,
  onStatusFilterChange,
  page,
  pageSize,
  onPageChange,
  onResetFilters,
  onOpenAddCustomer,
  onOpenBulkImport,
  onOpenCustomerDetail,
}) => {
  // Local verification status sub-filter
  const [verificationFilter, setVerificationFilter] = useState<string>("");

  // Filter in-memory if verification sub-filter is applied
  const filteredCustomers = customers.filter((c) => {
    if (!verificationFilter) return true;
    if (verificationFilter === "fully_verified") {
      return c.required_count > 0 && c.received_count >= c.required_count;
    }
    if (verificationFilter === "partially_verified") {
      return c.received_count > 0 && c.received_count < c.required_count;
    }
    if (verificationFilter === "none_verified") {
      return c.received_count === 0;
    }
    return true;
  });

  const totalPages = Math.ceil(totalCount / pageSize);

  return (
    <div id="tab-pane-cases" className="customers-view-root">
      {/* Top Header & Intake Action Bar */}
      <div className="customers-header-bar">
        <div>
          <h2 className="view-title">Customers</h2>
          <span className="view-subtitle">
            Manage customer verification cases and document collection
          </span>
        </div>

        <div className="intake-actions-group">
          <button
            type="button"
            className="sec btn-excel-import"
            onClick={onOpenBulkImport}
            id="btn-open-bulk-import"
          >
            <IconFileSpreadsheet size={16} color="var(--adm-success)" />
            <span>Import Excel (.xlsx)</span>
          </button>
          <button
            type="button"
            className="ok btn-add-customer"
            onClick={onOpenAddCustomer}
            id="btn-add-customer"
          >
            <IconPlus size={16} />
            <span>New Customer</span>
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="customers-filter-card">
        <form onSubmit={onSearchSubmit} className="customers-search-form">
          <div className="search-input-wrap">
            <IconSearch size={16} className="search-icon" />
            <input
              type="search"
              placeholder="Search by customer name, email, or code…"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              id="customer-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => onSearchChange("")}
              >
                ×
              </button>
            )}
          </div>

          <select
            value={caseStatusFilter}
            onChange={(e) => onStatusFilterChange(e.target.value)}
            id="customer-status-filter"
            className="filter-select"
          >
            <option value="">All Case Statuses</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="expired">Expired</option>
            <option value="withdrawn">Withdrawn</option>
            <option value="deleted">Deleted (Purged)</option>
          </select>

          <select
            value={verificationFilter}
            onChange={(e) => setVerificationFilter(e.target.value)}
            className="filter-select"
          >
            <option value="">All Verification States</option>
            <option value="fully_verified">All Documents Verified</option>
            <option value="partially_verified">Partially Verified</option>
            <option value="none_verified">Awaiting First Upload</option>
          </select>

          <button type="submit" className="sec search-btn" id="customer-search-btn">
            Search
          </button>

          {(searchQuery || caseStatusFilter || verificationFilter) && (
            <button
              type="button"
              className="sec reset-btn"
              onClick={() => {
                setVerificationFilter("");
                onResetFilters();
              }}
              title="Reset all search and status filters"
            >
              <IconRefreshCw size={13} /> Reset
            </button>
          )}
        </form>
      </div>

      {/* Customers Data Table Card */}
      <div className="card customers-table-card">
        {loading ? (
          <div className="table-loading-state">
            <span className="spinner-lg" />
            <p className="mut" style={{ marginTop: 12 }}>
              Loading customer verification cases…
            </p>
          </div>
        ) : filteredCustomers.length === 0 ? (
          <div className="table-empty-state">
            <div className="empty-icon-wrap">
              <IconUsers size={32} color="var(--adm-text-muted)" />
            </div>
            <h3 className="empty-title">
              {searchQuery || caseStatusFilter || verificationFilter
                ? "No Customer Cases Found"
                : "No customer cases yet"}
            </h3>
            <p className="empty-desc">
              {searchQuery || caseStatusFilter || verificationFilter
                ? "No customer cases matched your current search filters. Try clearing the filter criteria."
                : "Create your first customer case to begin document collection and verification."}
            </p>
            <div className="empty-actions">
              {(searchQuery || caseStatusFilter || verificationFilter) ? (
                <button
                  type="button"
                  className="sec"
                  onClick={() => {
                    setVerificationFilter("");
                    onResetFilters();
                  }}
                >
                  Clear All Filters
                </button>
              ) : (
                <button
                  type="button"
                  className="ok"
                  onClick={onOpenAddCustomer}
                >
                  <IconPlus size={16} /> New Customer
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="table-scroll-container">
              <table className="customers-data-table">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Code</th>
                    <th>Customer Name & Contact</th>
                    <th style={{ width: 120 }}>Case Status</th>
                    <th style={{ width: 110 }}>Consent</th>
                    <th style={{ minWidth: 190 }}>Verification Progress</th>
                    <th style={{ width: 140 }}>Created / Updated</th>
                    <th style={{ width: 130, textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCustomers.map((c) => {
                    const pct =
                      c.required_count > 0
                        ? Math.round((c.received_count / c.required_count) * 100)
                        : 0;
                    const pendingCount =
                      c.pending_count !== undefined
                        ? c.pending_count
                        : Math.max(0, c.required_count - c.received_count);
                    const isFullyVerified = c.received_count >= c.required_count && c.required_count > 0;

                    return (
                      <tr
                        key={c.id}
                        className="customer-table-row"
                        onClick={() => onOpenCustomerDetail(c.id)}
                        style={{ cursor: "pointer" }}
                      >
                        {/* Customer Code */}
                        <td>
                          <span className="customer-code-pill">{c.code}</span>
                        </td>

                        {/* Name & Contact */}
                        <td>
                          <div className="customer-name-group">
                            <span className="customer-name-text">{c.name}</span>
                            <span className="customer-email-text">{c.email}</span>
                            {c.mobile && (
                              <span className="customer-mobile-text">{c.mobile}</span>
                            )}
                          </div>
                        </td>

                        {/* Case Status */}
                        <td>
                          <div className="status-cell-wrap">
                            <span className={`tag ${c.case_status}`}>
                              {c.case_status}
                            </span>
                            {c.data_deleted_at && (
                              <span className="deleted-tag-sm">Files Purged</span>
                            )}
                          </div>
                        </td>

                        {/* Consent Status */}
                        <td>
                          <span className={`tag ${c.consent_status}`}>
                            {c.consent_status}
                          </span>
                        </td>

                        {/* Verification Progress */}
                        <td>
                          <div className="verif-progress-wrap">
                            <div className="verif-stat-line">
                              <span className="verif-stat-text">
                                <b>{c.received_count}</b> of <b>{c.required_count}</b> verified
                              </span>
                              {isFullyVerified ? (
                                <span className="verif-pill complete">
                                  <IconCheck size={11} /> Complete
                                </span>
                              ) : (
                                <span className="verif-pill pending">
                                  {pendingCount} pending
                                </span>
                              )}
                            </div>
                            <div className="mini-bar">
                              <i style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        </td>

                        {/* Timestamps */}
                        <td>
                          <div className="timestamp-group">
                            <span className="timestamp-main">
                              {new Date(c.created_at).toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              })}
                            </span>
                            <span className="timestamp-sub">
                              {new Date(c.created_at).toLocaleTimeString(undefined, {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                        </td>

                        {/* Actions */}
                        <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                          <div className="row-actions-group">
                            <button
                              type="button"
                              className="btn-quick-view"
                              onClick={() => onOpenCustomerDetail(c.id)}
                              title="Quick slide-over view"
                            >
                              <IconEye size={13} /> View
                            </button>
                            <Link
                              to={`/admin/customers/${c.id}`}
                              className="btn-full-view"
                              title="Open full dedicated customer page"
                            >
                              Full Page
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {totalCount > pageSize && (
              <div className="pagination-bar">
                <div className="pagination-info">
                  Showing <b>{page * pageSize + 1}</b>–
                  <b>{Math.min((page + 1) * pageSize, totalCount)}</b> of{" "}
                  <b>{totalCount}</b> customer cases
                </div>
                <div className="pagination-controls">
                  <button
                    type="button"
                    className="sec pagination-btn"
                    disabled={page === 0}
                    onClick={() => onPageChange(Math.max(0, page - 1))}
                  >
                    Previous
                  </button>
                  <span className="pagination-page-indicator">
                    Page {page + 1} of {totalPages || 1}
                  </span>
                  <button
                    type="button"
                    className="sec pagination-btn"
                    disabled={(page + 1) * pageSize >= totalCount}
                    onClick={() => onPageChange(page + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
