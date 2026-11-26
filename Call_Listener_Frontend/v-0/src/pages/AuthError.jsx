// FILE: src/pages/AuthError.jsx
import React, { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useUI } from "@/ui/UIContext.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import Button from "@/components/ui/Button.jsx";

const SERVER_TITLE = "Can't reach the Call Listener server";

// `reason` comes from the main-process auth gate (services/authFailure.js).
// Renderer offline redirects pass no reason and keep the offline copy.
const COPY = {
  offline: {
    title: "You're offline",
    body: "We can’t reach the network. Check your internet connection and try again.",
    tips: [
      "Ensure Wi-Fi/Ethernet is enabled.",
      "Toggle airplane mode or reconnect to your router.",
      "If the problem persists, contact your network administrator or ISP.",
    ],
  },
  server_unreachable: {
    title: SERVER_TITLE,
    body: "Your network is working, but the Call Listener server did not respond. It may be temporarily down, or blocked by a firewall, VPN, or proxy. Try again in a moment.",
    tips: [
      "Wait a minute and retry; the server may be restarting.",
      "If you use a VPN, proxy, or corporate firewall, check that it allows Call Listener.",
    ],
  },
  tls: {
    title: SERVER_TITLE,
    body: "A secure connection to the Call Listener server could not be established (certificate or TLS error).",
    tips: [
      "Check that your computer's date and time are correct.",
      "Antivirus or proxy software that inspects HTTPS traffic can cause this.",
    ],
  },
  http: {
    title: SERVER_TITLE,
    body: "The Call Listener server returned an error while signing in. Try again in a moment.",
    tips: ["If the problem persists, the service may be under maintenance."],
  },
};

export function authErrorCopy(reason) {
  return COPY[reason] || COPY.offline;
}

export default function AuthError() {
  const { setTitle } = useUI();
  const navigate = useNavigate();
  const reason = new URLSearchParams(useLocation().search).get("reason");
  const copy = authErrorCopy(reason);

  useEffect(() => setTitle("Authentication"), [setTitle]);

  return (
    <div className="h-full grid place-items-center">
      <Card className="w-full h-full">
        <CardHeader>{copy.title}</CardHeader>
        <CardBody className="flex flex-col justify-center items-center">
          <p className="text-xl text-[var(--text-2)] ">{copy.body}</p>
          <div className="mt-4 flex gap-2">
            <Button
              onClick={() => navigate(localStorage.getItem("lastPage") || "/")}
            >
              Retry
            </Button>
            <details className="text-md app-text">
              <summary className="btn btn-ghost">
                {reason && reason !== "offline" ? "Troubleshooting" : "Network tips"}
              </summary>
              <ul className="mt-2 list-disc pl-6 text-[var(--text-2)]">
                {copy.tips.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
            </details>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
