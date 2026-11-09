import { runAgent } from "../src/agent.js";
import { ManualClock } from "../src/clock.js";
import { FakeLLM } from "../src/interpreter.js";
import { createMemoryLogger, type MemoryLogger } from "../src/logger.js";
import type { ExecutionLimits } from "../src/schemas.js";
import { createTools, type Fault, type Tooling } from "../src/tools.js";

export function setup(options?: {
  faults?: Fault[];
  scripted?: unknown | ((message: string, signal?: AbortSignal) => unknown);
  limits?: Partial<ExecutionLimits>;
}) {
  const clock = new ManualClock();
  const tools = createTools({ faults: options?.faults, clock });
  const interpreter = new FakeLLM(options?.scripted);
  const logger: MemoryLogger = createMemoryLogger();
  const run = (message: string, userId = "admin") =>
    runAgent({
      userId,
      message,
      tools,
      interpreter,
      clock,
      logger,
      limits: options?.limits,
    });

  return { clock, tools, interpreter, logger, run };
}

export function toolNames(tools: Tooling): string[] {
  return tools.invocations.map((call) => call.tool);
}
