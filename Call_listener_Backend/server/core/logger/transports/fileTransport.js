import DailyRotateFile from "winston-daily-rotate-file";

export function createFileTransport(serviceName) {
  return new DailyRotateFile({
    filename: `logs/${serviceName}-%DATE%.log`,
    datePattern: "YYYY-MM-DD",
    maxFiles: "14d",
    zippedArchive: true,
    level: "info"
  });
}
