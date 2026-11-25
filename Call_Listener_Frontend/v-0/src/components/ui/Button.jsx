// FILE: src/components/ui/Button.jsx
import React from "react";

export default function Button({
  variant = "primary",
  className = "",
  ...props
}) {
  const base =
    "btn " +
    (variant === "primary"
      ? "btn-primary"
      : variant === "ghost"
      ? "btn-ghost"
      : variant === "danger"
      ? "btn-danger"
      : "btn-ghost");
  return <button className={`${base} ${className}`} {...props} />;
}
