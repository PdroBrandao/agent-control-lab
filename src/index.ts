import { pathToFileURL } from "node:url";
import { runAgent } from "./agent.js";
import { createConsoleLogger } from "./logger.js";
import { createTools, type Tooling } from "./tools.js";
import type { AgentResult } from "./harness.js";

interface ScenarioResult {
  scenario: string;
  status: AgentResult["status"];
  reason_code: AgentResult["reason_code"];
  message: string;
  tools: string[];
  release_applications: number;
}

function summarize(
  scenario: string,
  result: AgentResult,
  tools: Tooling,
  orderId: string,
  callStart: number,
): ScenarioResult {
  return {
    scenario,
    status: result.status,
    reason_code: result.reason_code,
    message: result.message,
    tools: tools.invocations.slice(callStart).map((call) => call.tool),
    release_applications: tools.releaseApplications(orderId),
  };
}

const SCENARIOS = [
  "release_success",
  "release_duplicate",
  "payment_pending",
  "viewer_denied",
  "missing_order_id",
  "shipment_timeout_effect_unknown",
] as const;

type ScenarioName = (typeof SCENARIOS)[number];

const silentLogger = { log() {} };

function isScenarioName(value: string): value is ScenarioName {
  return (SCENARIOS as readonly string[]).includes(value);
}

const scenarioRunners: Record<ScenarioName, (logger: ReturnType<typeof createConsoleLogger>) => Promise<void>> = {
  async release_success(logger) {
    const tools = createTools();
    const released = await runAgent({
      userId: "admin",
      message: "Release shipment for ORD-100",
      tools,
      logger,
    });
    console.log(JSON.stringify(summarize("release_success", released, tools, "ORD-100", 0)));
  },

  async release_duplicate(logger) {
    const tools = createTools();
    await runAgent({
      userId: "admin",
      message: "Release shipment for ORD-100",
      tools,
      logger: silentLogger,
    });
    const start = tools.invocations.length;
    const duplicate = await runAgent({
      userId: "admin",
      message: "Release shipment for ORD-100",
      tools,
      logger,
    });
    console.log(JSON.stringify(summarize("release_duplicate", duplicate, tools, "ORD-100", start)));
  },

  async payment_pending(logger) {
    const tools = createTools();
    const pending = await runAgent({
      userId: "admin",
      message: "Release shipment for ORD-200",
      tools,
      logger,
    });
    console.log(JSON.stringify(summarize("payment_pending", pending, tools, "ORD-200", 0)));
  },

  async viewer_denied(logger) {
    const tools = createTools();
    const denied = await runAgent({
      userId: "viewer",
      message: "Release shipment for ORD-100",
      tools,
      logger,
    });
    console.log(JSON.stringify(summarize("viewer_denied", denied, tools, "ORD-100", 0)));
  },

  async missing_order_id(logger) {
    const missingId = await runAgent({
      userId: "admin",
      message: "Release the shipment",
      tools: createTools(),
      logger,
    });
    console.log(
      JSON.stringify({
        scenario: "missing_order_id",
        status: missingId.status,
        reason_code: missingId.reason_code,
        message: missingId.message,
        tools: missingId.trace.attempts.map((attempt) => attempt.tool),
      }),
    );
  },

  async shipment_timeout_effect_unknown(logger) {
    const tools = createTools({
      faults: [{ tool: "release_shipment", mode: "hang_after_effect" }],
    });
    const uncertain = await runAgent({
      userId: "admin",
      message: "Release shipment for ORD-100",
      tools,
      logger,
      limits: { shipmentTimeoutMs: 50 },
    });
    console.log(
      JSON.stringify(summarize("shipment_timeout_effect_unknown", uncertain, tools, "ORD-100", 0)),
    );
  },
};

async function main(selected?: string): Promise<void> {
  if (selected !== undefined && !isScenarioName(selected)) {
    console.error(`Unknown scenario: ${selected}`);
    console.error("Available scenarios:");
    for (const name of SCENARIOS) console.error(`  ${name}`);
    process.exitCode = 1;
    return;
  }

  const logger = createConsoleLogger();
  const names: readonly ScenarioName[] = selected === undefined ? SCENARIOS : [selected];
  for (const name of names) {
    await scenarioRunners[name](logger);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv[2]).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
