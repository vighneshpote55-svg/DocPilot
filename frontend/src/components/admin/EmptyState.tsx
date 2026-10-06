import React from "react";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description: string;
  actions?: React.ReactNode;
  id?: string;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  actions,
  id,
  className = "",
}) => {
  return (
    <div
      id={id}
      className={`enterprise-empty-state ${className}`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        textAlign: "center",
        background: "var(--c-surface)",
        border: "1px dashed var(--c-border)",
        borderRadius: "var(--r-md)",
        margin: "16px 0",
      }}
    >
      {icon && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 48,
            height: 48,
            borderRadius: "50%",
            background: "var(--c-hover)",
            color: "var(--c-primary)",
            marginBottom: 16,
          }}
        >
          {icon}
        </div>
      )}
      <h3
        style={{
          margin: "0 0 8px",
          fontSize: 16,
          fontWeight: 650,
          color: "var(--c-heading)",
        }}
      >
        {title}
      </h3>
      <p
        style={{
          margin: "0 0 20px",
          fontSize: 13.5,
          color: "var(--c-muted)",
          maxWidth: 420,
          lineHeight: 1.5,
        }}
      >
        {description}
      </p>
      {actions && (
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {actions}
        </div>
      )}
    </div>
  );
};
