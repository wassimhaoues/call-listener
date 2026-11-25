// FILE: src/components/ui/Card.jsx
import React from "react";

export function Card({ className = "", children }) {
  return <div className={`panel ${className}`}>{children}</div>;
}

export function CardHeader({ className = "", children }) {
  return <div className={`panel-header ${className}`}>{children}</div>;
}

export function CardBody({ className = "", children }) {
  return <div className={`p-4 ${className}`}>{children}</div>;
}
