import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import { canRead, canRelease, resolveIdentity } from "./auth.js";
import { systemClock, type Clock } from "./clock.js";
import {
  CallTimeoutError,
  EffectNotStartedError,
  InvalidToolInputError,
  isCallTimeout,
} from "./errors.js";
import type { Interpreter } from "./interpreter.js";
import type { Logger } from "./logger.js";
import { buildResponse, type BuiltResponse, type VerifiedFacts } from "./response.js";
import {
  DEFAULT_LIMITS,
  InterpreterOutputSchema,
  OrderViewSchema,
  PaymentViewSchema,
  ShipmentViewSchema,
  type ExecutionLimits,
  type Intent,
  type OrderView,
  type PaymentView,
  type ReasonCode,
  type ShipmentView,
} from "./schemas.js";
import type { ToolClient, ToolName } from "./tools.js";

export interface AttemptRecord {
  tool: ToolName;
  attempt: number;
  call_status: "success" | "error" | "timeout";
  effect_status?: "not_applied" | "applied" | "unknown";
}

export interface ExecutionTrace {
  intent: Intent | null;
  order_id: string | null;
  llm_calls: number;
  logical_calls: number;
  physical_attempts: number;
  attempts: AttemptRecord[];
}

export interface AgentResult extends BuiltResponse {
  trace: ExecutionTrace;
}

export interface HarnessInput {
  userId: string;
  message: string;
  interpreter: Interpreter;
  tools: ToolClient;
  clock?: Clock;
  logger?: Logger;
  limits?: Partial<ExecutionLimits>;
}

function messageMentionsOrder(message: string, orderId: string): boolean {
  const escaped = orderId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(message);
}

function withTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CallTimeoutError());
    }, ms);
  });
  const outcome = work(controller.signal);
  outcome.catch(() => undefined);
  return Promise.race([outcome, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function executeHarness(input: HarnessInput): Promise<AgentResult> {
  const limits: ExecutionLimits = { ...DEFAULT_LIMITS, ...input.limits };
  const clock = input.clock ?? systemClock;
  const logger = input.logger ?? { log() {} };
  const startedAt = clock.now();
  const deadline = startedAt + limits.globalDeadlineMs;
  const executionId = randomUUID();
  const trace: ExecutionTrace = {
    intent: null,
    order_id: null,
    llm_calls: 0,
    logical_calls: 0,
    physical_attempts: 0,
    attempts: [],
  };

  const log = (event: string, fields: Record<string, string | number | boolean | null> = {}) => {
    logger.log({ ts: clock.now(), execution_id: executionId, event, ...fields });
  };

  const finish = (reasonCode: ReasonCode, facts: VerifiedFacts = {}): AgentResult => {
    const response = buildResponse(executionId, reasonCode, facts);
    log("execution_finished", { status: response.status, reason_code: response.reason_code });
    return { ...response, trace };
  };

  const timeBlock = (needsReleaseWindow: boolean): ReasonCode | null => {
    const remaining = deadline - clock.now();
    if (remaining <= 0) return "GLOBAL_DEADLINE_EXCEEDED";
    if (needsReleaseWindow && remaining < limits.shipmentTimeoutMs) return "INSUFFICIENT_TIME";
    return null;
  };

  log("execution_started", { user_id: input.userId });

  if (trace.llm_calls >= limits.maxLlmCalls) return finish("INVALID_LLM_OUTPUT");

  const interpreterBudget = deadline - clock.now();
  if (interpreterBudget <= 0) return finish("GLOBAL_DEADLINE_EXCEEDED");

  trace.llm_calls += 1;
  let raw: unknown;
  try {
    raw = await withTimeout(interpreterBudget, (signal) =>
      input.interpreter.interpret(input.message, signal),
    );
  } catch (error) {
    if (isCallTimeout(error)) return finish("GLOBAL_DEADLINE_EXCEEDED");
    return finish("INVALID_LLM_OUTPUT");
  }

  const parsed = InterpreterOutputSchema.safeParse(raw);
  if (!parsed.success) {
    log("llm_output_rejected", { reason_code: "INVALID_LLM_OUTPUT" });
    return finish("INVALID_LLM_OUTPUT");
  }

  const proposal = parsed.data;
  trace.intent = proposal.intent;
  trace.order_id = proposal.order_id;
  log("llm_completed", { intent: proposal.intent, order_id: proposal.order_id });

  const user = resolveIdentity(input.userId);
  if (!user) {
    log("authorization_decided", { decision: "denied", reason_code: "UNKNOWN_USER" });
    return finish("UNKNOWN_USER");
  }

  if (!canRead(user)) {
    log("authorization_decided", { decision: "denied", role: user.role, reason_code: "PERMISSION_DENIED" });
    return finish("PERMISSION_DENIED");
  }

  log("authorization_decided", {
    decision: proposal.intent === "release_shipment" && !canRelease(user) ? "denied" : "allowed",
    role: user.role,
    intent: proposal.intent,
  });

  if (proposal.intent === "clarify") return finish("AMBIGUOUS_REQUEST");
  if (proposal.intent === "unsupported") return finish("UNSUPPORTED_REQUEST");

  const orderId = proposal.order_id;
  if (orderId && !messageMentionsOrder(input.message, orderId)) {
    log("llm_output_rejected", { reason_code: "ORDER_ID_MISMATCH", order_id: orderId });
    return finish("ORDER_ID_MISMATCH", { orderId });
  }

  if (proposal.intent === "release_shipment" && !canRelease(user)) {
    return finish("PERMISSION_DENIED");
  }

  if (!orderId) return finish("MISSING_ORDER_ID", { orderId });

  const readTool = async <T extends { order_id: string }>(
    tool: ToolName,
    schema: ZodType<T>,
    run: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: ReasonCode }> => {
    if (trace.logical_calls >= limits.maxLogicalToolCalls) {
      return { ok: false, reason: "TOOL_CALL_LIMIT" };
    }
    const blocked = timeBlock(false);
    if (blocked) return { ok: false, reason: blocked };

    trace.logical_calls += 1;
    const maxAttempts = limits.readMaxRetries + 1;

    for (let index = 0; index < maxAttempts; index += 1) {
      if (trace.physical_attempts >= limits.maxPhysicalAttempts) {
        return { ok: false, reason: "TOOL_CALL_LIMIT" };
      }
      const remaining = deadline - clock.now();
      if (remaining <= 0) return { ok: false, reason: "GLOBAL_DEADLINE_EXCEEDED" };

      const timeoutMs = Math.min(limits.readTimeoutMs, remaining);
      const attempt = index + 1;
      trace.physical_attempts += 1;
      log("tool_attempt", { tool, attempt, timeout_ms: timeoutMs });

      try {
        const rawResult = await withTimeout(timeoutMs, run);
        const checked = schema.safeParse(rawResult);
        if (!checked.success || checked.data.order_id !== orderId) {
          trace.attempts.push({ tool, attempt, call_status: "error" });
          log("tool_result", { tool, attempt, call_status: "error", detail: "invalid_output" });
          return { ok: false, reason: "INVALID_TOOL_OUTPUT" };
        }
        trace.attempts.push({ tool, attempt, call_status: "success" });
        log("tool_result", { tool, attempt, call_status: "success" });
        return { ok: true, value: checked.data };
      } catch (error) {
        const callStatus = isCallTimeout(error) ? "timeout" : "error";
        trace.attempts.push({ tool, attempt, call_status: callStatus });
        log("tool_result", { tool, attempt, call_status: callStatus });

        if (error instanceof InvalidToolInputError) return { ok: false, reason: "INVALID_TOOL_INPUT" };

        const retriesLeft = index < maxAttempts - 1;
        if (!retriesLeft) return { ok: false, reason: "RETRIES_EXHAUSTED" };

        const backoff =
          limits.readBackoffMs[index] ?? limits.readBackoffMs[limits.readBackoffMs.length - 1];
        if (backoff === undefined || deadline - clock.now() < backoff) {
          return { ok: false, reason: "GLOBAL_DEADLINE_EXCEEDED" };
        }
        await clock.sleep(backoff);
      }
    }

    return { ok: false, reason: "RETRIES_EXHAUSTED" };
  };

  const releaseOnce = async (facts: VerifiedFacts): Promise<AgentResult> => {
    if (trace.logical_calls >= limits.maxLogicalToolCalls || trace.physical_attempts >= limits.maxPhysicalAttempts) {
      return finish("TOOL_CALL_LIMIT", facts);
    }
    const blocked = timeBlock(true);
    if (blocked) return finish(blocked, facts);

    trace.logical_calls += 1;
    trace.physical_attempts += 1;
    log("tool_attempt", {
      tool: "release_shipment",
      attempt: 1,
      timeout_ms: limits.shipmentTimeoutMs,
    });

    const record = (
      callStatus: AttemptRecord["call_status"],
      effectStatus: AttemptRecord["effect_status"],
    ) => {
      trace.attempts.push({
        tool: "release_shipment",
        attempt: 1,
        call_status: callStatus,
        effect_status: effectStatus,
      });
      log("tool_result", {
        tool: "release_shipment",
        attempt: 1,
        call_status: callStatus,
        effect_status: effectStatus ?? null,
      });
    };

    const unconfirmed = (): AgentResult =>
      finish("SHIPMENT_EFFECT_UNKNOWN", { orderId: facts.orderId, payment: facts.payment });

    try {
      const rawResult = await withTimeout(limits.shipmentTimeoutMs, (signal) =>
        input.tools.releaseShipment(orderId, signal),
      );
      const checked = ShipmentViewSchema.safeParse(rawResult);
      if (!checked.success || checked.data.order_id !== orderId) {
        // A body that does not confirm this order is not evidence the effect is absent.
        record("error", "unknown");
        return unconfirmed();
      }

      const shipment: ShipmentView = checked.data;
      if (shipment.status === "rejected") {
        record("success", "not_applied");
        return finish("SHIPMENT_REJECTED", { ...facts, shipment });
      }

      const shippedOrder: OrderView | undefined = facts.order
        ? { ...facts.order, status: "shipped" }
        : undefined;
      record("success", shipment.status === "released" ? "applied" : "not_applied");
      const reason = shipment.status === "released" ? "SHIPMENT_RELEASED" : "SHIPMENT_ALREADY_RELEASED";
      return finish(reason, { ...facts, order: shippedOrder, shipment });
    } catch (error) {
      if (error instanceof InvalidToolInputError) {
        record("error", "not_applied");
        return finish("INVALID_TOOL_INPUT", facts);
      }
      if (error instanceof EffectNotStartedError) {
        record("error", "not_applied");
        return finish("SHIPMENT_FAILED", facts);
      }
      // Timeout or any other error after the call started. Do not claim not_applied.
      record(isCallTimeout(error) ? "timeout" : "error", "unknown");
      return unconfirmed();
    }
  };

  if (proposal.intent === "get_order") {
    const read = await readTool("get_order", OrderViewSchema, (signal) =>
      input.tools.getOrder(orderId, signal),
    );
    if (!read.ok) return finish(read.reason, { orderId });
    if (!read.value.exists || !read.value.status) return finish("ORDER_NOT_FOUND", { orderId, order: read.value });
    return finish("ORDER_FOUND", { orderId, order: read.value });
  }

  if (proposal.intent === "get_payment") {
    const read = await readTool("get_payment", PaymentViewSchema, (signal) =>
      input.tools.getPayment(orderId, signal),
    );
    if (!read.ok) return finish(read.reason, { orderId });
    if (!read.value.exists || !read.value.status) {
      return finish("ORDER_NOT_FOUND", { orderId, payment: read.value });
    }
    return finish("PAYMENT_FOUND", { orderId, payment: read.value });
  }

  const early = timeBlock(true);
  if (early) return finish(early, { orderId });

  const orderRead = await readTool("get_order", OrderViewSchema, (signal) =>
    input.tools.getOrder(orderId, signal),
  );
  if (!orderRead.ok) return finish(orderRead.reason, { orderId });
  const order = orderRead.value;
  if (!order.exists || !order.status) return finish("ORDER_NOT_FOUND", { orderId, order });
  if (order.status === "shipped") return finish("SHIPMENT_ALREADY_RELEASED", { orderId, order });
  if (order.status !== "open") return finish("ORDER_NOT_ELIGIBLE", { orderId, order });

  const afterOrder = timeBlock(true);
  if (afterOrder) return finish(afterOrder, { orderId, order });

  const paymentRead = await readTool("get_payment", PaymentViewSchema, (signal) =>
    input.tools.getPayment(orderId, signal),
  );
  if (!paymentRead.ok) return finish(paymentRead.reason, { orderId, order });
  const payment: PaymentView = paymentRead.value;
  if (!payment.exists || !payment.status) {
    return finish("PAYMENT_NOT_CONFIRMED", { orderId, order, payment });
  }
  if (payment.status === "pending") return finish("PAYMENT_PENDING", { orderId, order, payment });
  if (payment.status !== "confirmed") {
    return finish("PAYMENT_NOT_CONFIRMED", { orderId, order, payment });
  }

  return releaseOnce({ orderId, order, payment });
}
