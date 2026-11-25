import { createLogger, format } from "winston";
import { createFileTransport } from "./transports/fileTransport.js";
import { consoleTransport } from "./transports/console.js";
import { prodFormat } from "./formats.js";

export function createServiceLogger(serviceName) {
  const logToFile = process.env.LOG_TO_FILE !== "0"; // default on, disable in containers
  const logger = createLogger({
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
    // Keep prod JSON for file transport, but console transport has its own format.
    format:
      process.env.NODE_ENV === "production"
        ? prodFormat
        : format.combine(
            format.label({ label: serviceName }),
            format.splat(),
            format.simple()
          ),
    transports: logToFile
      ? [consoleTransport, createFileTransport(serviceName)]
      : [consoleTransport],
    exitOnError: false,
  });

  return logger;
}
