// FILE: src/pages/AuthError.jsx
import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useUI } from "@/ui/UIContext.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import Button from "@/components/ui/Button.jsx";

export default function AuthError() {
  const { setTitle } = useUI();
  const navigate = useNavigate();

  useEffect(() => setTitle("Authentication"), [setTitle]);

  return (
    <div className="h-full grid place-items-center">
      <Card className="w-full h-full">
        <CardHeader>You're offline</CardHeader>
        <CardBody className="flex flex-col justify-center items-center">
          <p className="text-xl text-[var(--text-2)] ">
            We can’t reach the network. Check your internet connection and try
            again.
          </p>
          <div className="mt-4 flex gap-2">
            <Button
              onClick={() => navigate(localStorage.getItem("lastPage") || "/")}
            >
              Retry
            </Button>
            <details className="text-md app-text">
              <summary className="btn btn-ghost">Network tips</summary>
              <ul className="mt-2 list-disc pl-6 text-[var(--text-2)]">
                <li>Ensure Wi-Fi/Ethernet is enabled.</li>
                <li>Toggle airplane mode or reconnect to your router.</li>
                <li>
                  If the problem persists, contact your network administrator or
                  ISP.
                </li>
              </ul>
            </details>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
