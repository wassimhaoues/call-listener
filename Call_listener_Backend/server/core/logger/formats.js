import { format } from "winston";

export const logFormat = format.printf(({ level, message, label, timestamp }) => {
  return `${timestamp} [${label}] ${level.toUpperCase()}: ${message}`;
});

export const devFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  logFormat
);

export const prodFormat = format.combine(
  format.timestamp(),
  format.json()
);
