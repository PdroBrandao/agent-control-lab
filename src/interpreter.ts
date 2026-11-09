import { CallTimeoutError } from "./errors.js";
import type { InterpreterOutput } from "./schemas.js";

export interface Interpreter {
  interpret(message: string, signal?: AbortSignal): Promise<unknown>;
}

const ORDER_ID = /\b(ORD-\d+)\b/gi;

/**
 * Deterministic stand-in for an LLM. It extracts one intent and one order id.
 * It has no authority over identity, payment, or tool results.
 */
export function interpretHeuristically(message: string): InterpreterOutput {
  const ids = [...message.matchAll(ORDER_ID)].map((match) => match[1]!.toUpperCase());
  const unique = [...new Set(ids)];
  if (unique.length > 1) return { intent: "clarify", order_id: null };

  const orderId = unique[0] ?? null;
  const text = message.toLowerCase();
  const wantsRelease =
    /\b(release|dispatch|liberar|liberação|liberacao|envio)\b/.test(text) ||
    /\bship\b/.test(text);
  const wantsPayment = /\b(payment|pagamento|pago)\b/.test(text);
  const wantsOrder = /\b(order|pedido)\b/.test(text);

  if (wantsRelease && wantsPayment) return { intent: "clarify", order_id: null };
  if (wantsRelease) return { intent: "release_shipment", order_id: orderId };
  if (wantsPayment) return { intent: "get_payment", order_id: orderId };
  if (wantsOrder) return { intent: "get_order", order_id: orderId };
  if (orderId) return { intent: "clarify", order_id: null };
  return { intent: "unsupported", order_id: null };
}

export class FakeLLM implements Interpreter {
  readonly calls: string[] = [];

  constructor(
    private readonly scripted?: unknown | ((message: string, signal?: AbortSignal) => unknown),
  ) {}

  async interpret(message: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new CallTimeoutError();
    this.calls.push(message);
    if (typeof this.scripted === "function") return this.scripted(message, signal);
    if (this.scripted !== undefined) return this.scripted;
    return interpretHeuristically(message);
  }
}
