import React from "react";
import { IconSun, IconMoon } from "./admin/AdminIcons";

interface ThemeToggleProps {
  theme: "dark" | "light";
  onToggle: () => void;
  id?: string;
  className?: string;
}

export const ThemeToggle: React.FC<ThemeToggleProps> = ({
  theme,
  onToggle,
  id = "theme-toggle-btn",
  className = "",
}) => {
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      id={id}
      className={`proper-theme-toggle ${isDark ? "is-dark" : "is-light"} customer-theme-toggle ${className}`}
      onClick={onToggle}
      role="switch"
      aria-checked={isDark}
      aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
      title={`Switch to ${isDark ? "light" : "dark"} mode`}
    >
      <span className="theme-toggle-track">
        <span className="theme-toggle-slot slot-light" aria-hidden="true" title="Light mode">
          <IconSun
            size={14}
            color={isDark ? "var(--adm-text-muted, #64748b)" : "#d97706"}
            fill={isDark ? "none" : "#f59e0b"}
          />
        </span>
        <span className="theme-toggle-slot slot-dark" aria-hidden="true" title="Dark mode">
          <IconMoon
            size={13}
            color={isDark ? "#60a5fa" : "var(--adm-text-muted, #94a3b8)"}
            fill={isDark ? "#60a5fa" : "none"}
          />
        </span>
        <span className="theme-toggle-thumb" aria-hidden="true">
          {isDark ? (
            <IconMoon size={13} color="#60a5fa" fill="#60a5fa" />
          ) : (
            <IconSun size={13} color="#d97706" fill="#f59e0b" />
          )}
        </span>
      </span>
    </button>
  );
};

export default ThemeToggle;
