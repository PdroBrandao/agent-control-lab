import { systemClock, type Clock } from "./clock.js";
import { executeHarness, type AgentResult, type HarnessInput } from "./harness.js";
import { FakeLLM, type Interpreter } from "./interpreter.js";
import { createConsoleLogger, type Logger } from "./logger.js";
import type { ExecutionLimits } from "./schemas.js";
import { createTools, type ToolClient } from "./tools.js";

export interface RunAgentInput {
  userId: string;
  message: string;
  interpreter?: Interpreter;
  tools?: ToolClient;
  clock?: Clock;
  logger?: Logger;
  limits?: Partial<ExecutionLimits>;
}

export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const clock = input.clock ?? systemClock;
  const request: HarnessInput = {
    userId: input.userId,
    message: input.message,
    interpreter: input.interpreter ?? new FakeLLM(),
    tools: input.tools ?? createTools({ clock }),
    clock,
    logger: input.logger ?? createConsoleLogger(clock),
    limits: input.limits,
  };
  return executeHarness(request);
}
