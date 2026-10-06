import React from "react";

interface SkeletonProps {
  variant?: "text" | "kpi" | "row" | "card";
  count?: number;
  height?: number | string;
  width?: number | string;
  className?: string;
  style?: React.CSSProperties;
}

export const Skeleton: React.FC<SkeletonProps> = ({
  variant = "text",
  count = 1,
  height,
  width,
  className = "",
  style,
}) => {
  const getDefaultHeight = () => {
    switch (variant) {
      case "kpi":
        return 38;
      case "row":
        return 42;
      case "card":
        return 120;
      case "text":
      default:
        return 16;
    }
  };

  const finalHeight = height || getDefaultHeight();

  return (
    <div
      className={`skeleton-container ${className}`}
      role="status"
      aria-label="Loading..."
      aria-busy="true"
      style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", ...style }}
    >
      <span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)" }}>
        Loading content...
      </span>
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className="skeleton-box"
          style={{
            height: finalHeight,
            width: width || "100%",
          }}
        />
      ))}
    </div>
  );
};
