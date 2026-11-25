// FILE: src/pages/Unsupported.jsx
import React, { useEffect } from "react";
import { useUI } from "@/ui/UIContext.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";

export default function Unsupported() {
  const { setTitle } = useUI();
  useEffect(() => setTitle("Unsupported OS"), [setTitle]);

  return (
    <div className="h-full grid place-items-center">
      <Card className="w-full max-w-lg text-center">
        <CardHeader>Unsupported Operating System</CardHeader>
        <CardBody>
          <p className="text-sm text-[var(--text-2)]">
            This application runs only on <strong>Windows</strong>.<br />
            Please use a Windows computer to continue.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
