import type { Clock } from "./clock.js";
import {
  CallTimeoutError,
  EffectNotStartedError,
  InvalidToolInputError,
  TransientToolError,
} from "./errors.js";
import {
  OrderIdSchema,
  type OrderStatus,
  type PaymentStatus,
} from "./schemas.js";

export type ToolName = "get_order" | "get_payment" | "release_shipment";

export type FaultMode =
  | "error"
  | "error_after_start"
  | "error_after_effect"
  | "timeout"
  | "invalid_output"
  | "foreign_order"
  | "hang"
  | "hang_after_effect"
  | "timeout_after_effect"
  | "advance_clock";

export interface Fault {
  tool: ToolName;
  mode: FaultMode;
  /** How many upcoming calls this fault applies to. Defaults to 1. */
  times?: number;
  advanceMs?: number;
  foreignOrderId?: string;
}

export interface ToolInvocation {
  tool: ToolName;
  orderId: string;
}

export interface ToolClient {
  getOrder(orderId: string, signal?: AbortSignal): Promise<unknown>;
  getPayment(orderId: string, signal?: AbortSignal): Promise<unknown>;
  releaseShipment(orderId: string, signal?: AbortSignal): Promise<unknown>;
}

export interface Tooling extends ToolClient {
  invocations: ToolInvocation[];
  releaseApplications(orderId: string): number;
  orderStatus(orderId: string): OrderStatus | null;
  setOrderStatus(orderId: string, status: OrderStatus): void;
  setPaymentStatus(orderId: string, status: PaymentStatus): void;
}

interface ReleaseRecord {
  applications: number;
}

interface OrderRecord {
  status: OrderStatus;
}

interface PaymentRecord {
  status: PaymentStatus;
}

type ReleaseInner =
  | { type: "value"; value: unknown }
  | { type: "timeout" }
  | { type: "hang" }
  | { type: "unconfirmed_error" };

const DEFAULT_SEED: Readonly<
  Record<string, { order: OrderStatus; payment: PaymentStatus }>
> = {
  "ORD-100": { order: "open", payment: "confirmed" },
  "ORD-200": { order: "open", payment: "pending" },
  "ORD-300": { order: "cancelled", payment: "confirmed" },
  "ORD-400": { order: "shipped", payment: "confirmed" },
  "ORD-500": { order: "open", payment: "failed" },
  "ORD-600": { order: "open", payment: "refunded" },
};

export function createTools(options?: {
  faults?: Fault[];
  clock?: Clock;
  seed?: Readonly<Record<string, { order: OrderStatus; payment: PaymentStatus }>>;
}): Tooling {
  const clock = options?.clock ?? { now: () => Date.now(), sleep: async () => undefined };
  const orders = new Map<string, OrderRecord>();
  const payments = new Map<string, PaymentRecord>();
  const releases = new Map<string, ReleaseRecord>();
  const invocations: ToolInvocation[] = [];
  const queues: Record<ToolName, Fault[]> = {
    get_order: [],
    get_payment: [],
    release_shipment: [],
  };

  for (const [orderId, row] of Object.entries(options?.seed ?? DEFAULT_SEED)) {
    orders.set(orderId, { status: row.order });
    payments.set(orderId, { status: row.payment });
  }

  for (const fault of options?.faults ?? []) {
    queues[fault.tool].push({ ...fault });
  }

  let tail: Promise<void> = Promise.resolve();

  function consume(tool: ToolName): Fault | undefined {
    const next = queues[tool][0];
    if (!next) return undefined;
    const left = (next.times ?? 1) - 1;
    if (left <= 0) queues[tool].shift();
    else next.times = left;
    return next;
  }

  function assertId(orderId: string): void {
    if (!OrderIdSchema.safeParse(orderId).success) {
      throw new InvalidToolInputError(orderId);
    }
  }

  function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new CallTimeoutError();
  }

  function applyReadFault(tool: ToolName, fault: Fault | undefined): unknown | undefined {
    if (!fault || fault.mode === "advance_clock") {
      if (fault?.mode === "advance_clock") clock.advance?.(fault.advanceMs ?? 0);
      return undefined;
    }
    if (fault.mode === "error" || fault.mode === "error_after_start") {
      throw new TransientToolError("injected error");
    }
    if (fault.mode === "timeout") throw new CallTimeoutError();
    if (fault.mode === "invalid_output") return { unexpected: true };
    if (fault.mode === "foreign_order") {
      const order_id = fault.foreignOrderId ?? "ORD-999";
      if (tool === "get_payment") return { order_id, exists: true, status: "confirmed" };
      return { order_id, exists: true, status: "open" };
    }
    if (fault.mode === "hang" || fault.mode === "hang_after_effect") {
      return new Promise(() => undefined);
    }
    throw new TransientToolError(`unsupported read fault: ${fault.mode}`);
  }

  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function commitRelease(orderId: string, fault: Fault | undefined): ReleaseInner {
    const existing = releases.get(orderId);
    if (existing) {
      const order = orders.get(orderId);
      if (order?.status === "open") order.status = "shipped";
      return {
        type: "value",
        value: { order_id: orderId, status: "already_released" },
      };
    }

    if (fault?.mode === "error_after_start") {
      throw new Error("shipment failed after the operation started");
    }

    const order = orders.get(orderId);
    const payment = payments.get(orderId);
    if (!order || !payment || order.status !== "open" || payment.status !== "confirmed") {
      return { type: "value", value: { order_id: orderId, status: "rejected" } };
    }

    // The record and the shipped projection commit together. A lost response
    // does not roll the effect back. The in-memory key does not survive restart.
    releases.set(orderId, { applications: 1 });
    order.status = "shipped";

    if (fault?.mode === "hang_after_effect") return { type: "hang" };
    if (fault?.mode === "timeout_after_effect") return { type: "timeout" };
    if (fault?.mode === "error_after_effect") return { type: "unconfirmed_error" };
    return { type: "value", value: { order_id: orderId, status: "released" } };
  }

  return {
    invocations,

    releaseApplications(orderId) {
      return releases.get(orderId)?.applications ?? 0;
    },

    orderStatus(orderId) {
      return orders.get(orderId)?.status ?? null;
    },

    setOrderStatus(orderId, status) {
      const order = orders.get(orderId);
      if (!order) throw new Error(`unknown order: ${orderId}`);
      order.status = status;
    },

    setPaymentStatus(orderId, status) {
      const payment = payments.get(orderId);
      if (!payment) throw new Error(`unknown payment: ${orderId}`);
      payment.status = status;
    },

    async getOrder(orderId, signal) {
      throwIfAborted(signal);
      assertId(orderId);
      invocations.push({ tool: "get_order", orderId });
      const interrupted = applyReadFault("get_order", consume("get_order"));
      if (interrupted !== undefined) return interrupted;
      const order = orders.get(orderId);
      if (!order) return { order_id: orderId, exists: false, status: null };
      return { order_id: orderId, exists: true, status: order.status };
    },

    async getPayment(orderId, signal) {
      throwIfAborted(signal);
      assertId(orderId);
      invocations.push({ tool: "get_payment", orderId });
      const interrupted = applyReadFault("get_payment", consume("get_payment"));
      if (interrupted !== undefined) return interrupted;
      const payment = payments.get(orderId);
      if (!payment) return { order_id: orderId, exists: false, status: null };
      return { order_id: orderId, exists: true, status: payment.status };
    },

    async releaseShipment(orderId, signal) {
      throwIfAborted(signal);
      assertId(orderId);
      invocations.push({ tool: "release_shipment", orderId });
      const fault = consume("release_shipment");

      if (fault?.mode === "error") throw new EffectNotStartedError("injected error before shipment start");
      if (fault?.mode === "timeout") throw new CallTimeoutError();
      if (fault?.mode === "invalid_output") return { order_id: orderId, status: "invalid" };
      if (fault?.mode === "foreign_order") {
        return { order_id: fault.foreignOrderId ?? "ORD-999", status: "released" };
      }
      if (fault?.mode === "hang") return new Promise(() => undefined);

      const inner = await exclusive(async () => commitRelease(orderId, fault));
      if (inner.type === "hang") return new Promise(() => undefined);
      if (inner.type === "timeout") throw new CallTimeoutError();
      if (inner.type === "unconfirmed_error") {
        throw new Error("shipment failed after the effect was applied");
      }
      return inner.value;
    },
  };
}
