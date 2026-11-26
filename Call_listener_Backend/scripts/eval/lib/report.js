import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const METRIC_ROWS = [
  ["Questions (completed / errors / skipped)", (agg) => [agg.completed, agg.errors, agg.skipped].join(" / ")],
  ["Grounding", (agg) => formatRate(agg.groundingRate)],
  ["Context isolation", (agg) => formatRate(agg.isolationRate)],
  ["Question relevance", (agg) => formatRate(agg.relevanceRate)],
  ["Answer evidence recall (mean)", (agg) => formatRate(agg.meanAnswerEvidenceRecall)],
  ["Prompt evidence recall (mean)", (agg) => formatRate(agg.meanPromptEvidenceRecall)],
  ["Prompt evidence precision (mean)", (agg) => formatRate(agg.meanPromptEvidencePrecision)],
  ["Missing evidence handled", (agg) => formatRate(agg.missingEvidenceHandledRate)],
  ["Language match", (agg) => formatRate(agg.languageMatchRate)],
  ["Length compliance", (agg) => formatRate(agg.lengthComplianceRate)],
  ["Latency p50 (ms)", (agg) => formatNumber(agg.latencyP50Ms, 1)],
  ["Latency p95 (ms)", (agg) => formatNumber(agg.latencyP95Ms, 1)],
  ["Input tokens", (agg) => String(agg.inputTokens)],
  ["Output tokens", (agg) => String(agg.outputTokens)],
  ["Estimated cost (USD)", (agg) => formatNumber(agg.costUsd, 6)],
];

function formatRate(value) {
  if (value === null || value === undefined) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value, digits) {
  if (value === null || value === undefined) return "n/a";
  return value.toFixed(digits);
}

function tableRow(cells) {
  return ["|", cells.join(" | "), "|"].join(" ");
}

/** The per-variant comparison table (metrics as rows, variants as columns). */
export function comparisonTable(report) {
  const names = report.variants;
  const lines = [
    tableRow(["Metric", ...names]),
    tableRow(["---", ...names.map(() => "---")]),
  ];
  for (const [label, format] of METRIC_ROWS) {
    lines.push(tableRow([label, ...names.map((name) => format(report.aggregates[name]))]));
  }
  const cancellation = names.map((name) => (report.cancellation[name]?.passed ? "pass" : "fail"));
  lines.push(tableRow(["Cancellation", ...cancellation]));
  return lines.join("\n");
}

function costNote(report) {
  if (report.live) {
    return [
      "Live OpenRouter run. Spent $", report.spentUsd.toFixed(6), " of a $", String(report.maxUsd),
      " cap (worst-case estimate $", report.estimatedWorstCaseUsd.toFixed(6), ").",
    ].join("");
  }
  return [
    "Fake provider: nothing was sent and nothing was spent. Token and cost columns show what these prompts would cost ",
    "at the configured prices (ceil(chars / 4) tokens). Latency is local pipeline overhead only, not model latency.",
  ].join("");
}

function fixtureList(report) {
  if (!report.fixtures.length) return "n/a";
  return report.fixtures.map((entry) => ["`", entry.file, "`"].join("")).join(", ");
}

export function renderMarkdown(report) {
  const lines = [
    "# Live-suggestion evaluation",
    "",
    `Generated ${report.generatedAt} by harness v${report.harnessVersion}.`,
    "",
    `- Provider: ${report.provider}; model: \`${report.model}\``,
    `- Prices (USD per million tokens): input ${report.prices.inputUsdPerMillion}, output ${report.prices.outputUsdPerMillion}; output cap ${report.maxOutputTokens} tokens`,
    `- Fixtures: ${fixtureList(report)}`,
    `- ${costNote(report)}`,
  ];
  if (report.stoppedReason) {
    lines.push(`- Stopped early: ${report.stoppedReason}; the remaining calls were skipped.`);
  }
  lines.push("", "## Comparison", "", comparisonTable(report), "", "## Phase 4 exit gate", "");
  const reason = report.gate.reason ? [" (", report.gate.reason, ")"].join("") : "";
  lines.push(`Overall: **${report.gate.status}**${reason}`, "");
  if (report.gate.gates.length) {
    lines.push(tableRow(["Gate", "Status", "Detail"]), tableRow(["---", "---", "---"]));
    for (const entry of report.gate.gates) lines.push(tableRow([entry.name, entry.status, entry.detail]));
    lines.push("");
  }
  lines.push("## Failing cases", "");
  if (!report.failures.length) {
    lines.push("None.");
  } else {
    lines.push(tableRow(["Variant", "Case", "Question", "Type", "Failed"]), tableRow(["---", "---", "---", "---", "---"]));
    for (const failure of report.failures) {
      lines.push(tableRow([
        failure.variant, failure.caseId, failure.questionId, failure.questionType, failure.failed.join(", "),
      ]));
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Write `<stamp>-<provider>.json` and `.md` under `outDir`; returns both paths. */
export async function writeReport(report, outDir) {
  await mkdir(outDir, { recursive: true });
  const stamp = report.generatedAt.replaceAll(":", "-").replace(/\.\d+Z$/, "Z");
  const base = path.join(outDir, `${stamp}-${report.provider}`);
  const jsonPath = `${base}.json`;
  const markdownPath = `${base}.md`;
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}
