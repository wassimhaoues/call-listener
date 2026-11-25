import { transports } from "winston";
import { devFormat } from "../formats.js";
import { format } from "winston";

export const consoleTransport = new transports.Console({
  format: format.combine(format.splat(), devFormat),
  level: "debug",
});
