import { format, transports } from "winston";
import { devFormat } from "../formats.js";

/**
 * Console transport for one service logger. Production (containers log to
 * stdout) writes one JSON object per line at `info` and above, with the
 * service name; development keeps the colored, human-readable debug output.
 */
export function createConsoleTransport(serviceName, { production = process.env.NODE_ENV === "production" } = {}) {
  if (production) {
    return new transports.Console({
      level: "info",
      format: format.combine(
        format.splat(),
        format.timestamp(),
        format((info) => ({ ...info, service: serviceName }))(),
        format.json()
      ),
    });
  }
  return new transports.Console({
    level: "debug",
    format: format.combine(format.label({ label: serviceName }), format.splat(), devFormat),
  });
}
