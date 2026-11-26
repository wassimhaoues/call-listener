#!/usr/bin/env node
/**
 * Offline evaluation of live suggestions: the LangGraph workflow ("graph")
 * against a single-prompt LangChain baseline ("chain") on identical
 * synthetic fixtures. The default fake provider is deterministic and free.
 * See docs/plan/evaluation.md.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { loggers } from "../../server/core/logger/index.js";
import { EvalConfigError, resolveProviderConfig } from "./lib/costGuard.js";
import { FixtureError, loadFixtures } from "./lib/fixtures.js";
import { runEvaluation } from "./lib/harness.js";
import { createFakeReplyGenerator, createLiveReplyGenerator } from "./lib/providers.js";
import { comparisonTable, writeReport } from "./lib/report.js";
import { BACKEND_ROOT, UnsafePathError } from "./lib/safePaths.js";
import { VARIANT_NAMES } from "./lib/variants.js";

// Fixed locations derived from this module's URL. No command-line value ever
// becomes part of a filesystem path.
export const DEFAULT_FIXTURES_DIR = path.join(BACKEND_ROOT, "test", "fixtures", "eval");
export const DEFAULT_OUT_DIR = path.resolve(BACKEND_ROOT, "..", "eval-results");

const USAGE = `Usage: npm run eval -- [options]

  --variant <graph|chain|all>   Variants to run (default: all)
  --provider <fake|openrouter>  Reply provider (default: fake, free and deterministic)
  --live                        Required with --provider openrouter (paid requests)
  --max-usd <n>                 Required with --live: hard spend cap in USD
  --model <id>                  OpenRouter model; must be in OPENROUTER_ALLOWED_MODELS
  --help                        Show this help

Fixtures are read from Call_listener_Backend/test/fixtures/eval and reports
are written to eval-results/ at the repository root.
`;

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      variant: { type: "string", default: "all" },
      provider: { type: "string", default: "fake" },
      live: { type: "boolean", default: false },
      "max-usd": { type: "string" },
      model: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const variantNames = values.variant === "all" ? [...VARIANT_NAMES] : [values.variant];
  for (const name of variantNames) {
    if (!VARIANT_NAMES.includes(name)) throw new EvalConfigError(`Unknown --variant ${name} (use graph, chain, or all)`);
  }
  return { ...values, variantNames };
}

/**
 * Run the CLI. Returns the process exit code: 0 on a completed run, 2 on a
 * configuration, fixture, or cost-cap refusal (before any model call).
 * `fixturesDir` and `outDir` are for tests that call this function directly;
 * the command line cannot change them.
 */
export async function main(argv, {
  env = process.env,
  write = (text) => process.stdout.write(text),
  writeError = (text) => process.stderr.write(text),
  ChatOpenRouterClass,
  now,
  clock,
  fixturesDir = DEFAULT_FIXTURES_DIR,
  outDir = DEFAULT_OUT_DIR,
} = {}) {
  try {
    const options = parseCli(argv);
    if (options.help) {
      write(USAGE);
      return 0;
    }
    const providerConfig = resolveProviderConfig({
      provider: options.provider,
      live: options.live,
      maxUsd: options["max-usd"],
      model: options.model,
    }, env);
    const { cases, files } = await loadFixtures(fixturesDir);
    const generateReply = providerConfig.live
      ? createLiveReplyGenerator(providerConfig, { ChatOpenRouterClass })
      : createFakeReplyGenerator();
    const report = await runEvaluation({
      cases,
      fixtureFiles: files,
      variantNames: options.variantNames,
      providerConfig,
      generateReply,
      now,
      clock,
      write,
    });
    const paths = await writeReport(report, outDir);
    write([
      comparisonTable(report),
      "",
      `Phase 4 gate: ${report.gate.status}; failing answers: ${report.failures.length}`,
      `Report: ${paths.markdownPath}`,
      `Data:   ${paths.jsonPath}`,
      "",
    ].join("\n"));
    return 0;
  } catch (error) {
    const refused = [EvalConfigError, FixtureError, UnsafePathError].some((type) => error instanceof type);
    if (refused || String(error?.code).startsWith("ERR_PARSE_ARGS")) {
      writeError(`eval: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  // Reads Call_listener_Backend/.env for prices and, only for live runs, the key.
  dotenv.config({ quiet: true });
  // promptBuilder logs every prompt build at debug level; keep the CLI output readable.
  for (const logger of Object.values(loggers)) logger.level = "warn";
  process.exitCode = await main(process.argv.slice(2));
}
