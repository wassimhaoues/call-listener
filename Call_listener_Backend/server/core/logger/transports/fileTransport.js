import path from "node:path";
import DailyRotateFile from "winston-daily-rotate-file";

// An explicit dirname and audit file: without them the library derives the
// audit file name with a Windows separator, which on Linux creates files
// named `logs\.<hash>-audit.json` next to the logs directory.
export function createFileTransport(serviceName) {
  return new DailyRotateFile({
    dirname: "logs",
    filename: `${serviceName}-%DATE%.log`,
    auditFile: path.join("logs", `.${serviceName}-audit.json`),
    datePattern: "YYYY-MM-DD",
    maxFiles: "14d",
    zippedArchive: true,
    level: "info"
  });
}
