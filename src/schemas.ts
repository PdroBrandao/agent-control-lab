import { z } from "zod";

export const OrderIdSchema = z.string().regex(/^ORD-\d+$/);

export const IntentSchema = z.enum([
  "get_order",
  "get_payment",
  "release_shipment",
  "clarify",
  "unsupported",
]);

export const OrderStatusSchema = z.enum(["open", "shipped", "cancelled"]);
export const PaymentStatusSchema = z.enum([
  "pending",
  "confirmed",
  "failed",
  "refunded",
]);
export const ShipmentStatusSchema = z.enum([
  "released",
  "already_released",
  "rejected",
]);

export const InterpreterOutputSchema = z.object({
  intent: IntentSchema,
  order_id: OrderIdSchema.nullable(),
});

export const OrderViewSchema = z
  .object({
    order_id: OrderIdSchema,
    exists: z.boolean(),
    status: OrderStatusSchema.nullable(),
  })
  .refine((value) => (value.exists ? value.status !== null : value.status === null), {
    message: "order status must be present only when the order exists",
  });

export const PaymentViewSchema = z
  .object({
    order_id: OrderIdSchema,
    exists: z.boolean(),
    status: PaymentStatusSchema.nullable(),
  })
  .refine(
    (value) => (value.exists ? value.status !== null : value.status === null),
    { message: "payment status must be present only when the payment exists" },
  );

export const ShipmentViewSchema = z.object({
  order_id: OrderIdSchema,
  status: ShipmentStatusSchema,
});

export const REASON_CODES = [
  "ORDER_FOUND",
  "PAYMENT_FOUND",
  "SHIPMENT_RELEASED",
  "SHIPMENT_ALREADY_RELEASED",
  "PAYMENT_PENDING",
  "PAYMENT_NOT_CONFIRMED",
  "ORDER_NOT_FOUND",
  "ORDER_NOT_ELIGIBLE",
  "UNKNOWN_USER",
  "PERMISSION_DENIED",
  "INSUFFICIENT_TIME",
  "SHIPMENT_REJECTED",
  "ORDER_ID_MISMATCH",
  "MISSING_ORDER_ID",
  "AMBIGUOUS_REQUEST",
  "UNSUPPORTED_REQUEST",
  "INVALID_LLM_OUTPUT",
  "INVALID_TOOL_OUTPUT",
  "INVALID_TOOL_INPUT",
  "RETRIES_EXHAUSTED",
  "GLOBAL_DEADLINE_EXCEEDED",
  "TOOL_CALL_LIMIT",
  "SHIPMENT_FAILED",
  "SHIPMENT_EFFECT_UNKNOWN",
] as const;

export const ReasonCodeSchema = z.enum(REASON_CODES);

export const STATUS_BY_REASON = {
  ORDER_FOUND: "completed",
  PAYMENT_FOUND: "completed",
  SHIPMENT_RELEASED: "completed",
  SHIPMENT_ALREADY_RELEASED: "completed",
  PAYMENT_PENDING: "blocked",
  PAYMENT_NOT_CONFIRMED: "blocked",
  ORDER_NOT_FOUND: "blocked",
  ORDER_NOT_ELIGIBLE: "blocked",
  UNKNOWN_USER: "blocked",
  PERMISSION_DENIED: "blocked",
  INSUFFICIENT_TIME: "blocked",
  SHIPMENT_REJECTED: "blocked",
  ORDER_ID_MISMATCH: "blocked",
  MISSING_ORDER_ID: "clarification_required",
  AMBIGUOUS_REQUEST: "clarification_required",
  UNSUPPORTED_REQUEST: "unsupported",
  INVALID_LLM_OUTPUT: "failed",
  INVALID_TOOL_OUTPUT: "failed",
  INVALID_TOOL_INPUT: "failed",
  RETRIES_EXHAUSTED: "failed",
  GLOBAL_DEADLINE_EXCEEDED: "failed",
  TOOL_CALL_LIMIT: "failed",
  SHIPMENT_FAILED: "failed",
  SHIPMENT_EFFECT_UNKNOWN: "uncertain",
} as const satisfies Record<(typeof REASON_CODES)[number], string>;

export const ResponseStatusSchema = z.enum([
  "completed",
  "blocked",
  "failed",
  "uncertain",
  "clarification_required",
  "unsupported",
]);

export const ResponseDataSchema = z.object({
  order: OrderViewSchema.optional(),
  payment: PaymentViewSchema.optional(),
  shipment: ShipmentViewSchema.optional(),
});

export const FinalResponseSchema = z.object({
  execution_id: z.string().uuid(),
  status: ResponseStatusSchema,
  message: z.string().min(1),
  reason_code: ReasonCodeSchema,
  data: ResponseDataSchema.optional(),
});

export interface ExecutionLimits {
  maxLlmCalls: number;
  maxLogicalToolCalls: number;
  maxPhysicalAttempts: number;
  readTimeoutMs: number;
  readMaxRetries: number;
  readBackoffMs: readonly number[];
  shipmentTimeoutMs: number;
  globalDeadlineMs: number;
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  maxLlmCalls: 1,
  maxLogicalToolCalls: 3,
  maxPhysicalAttempts: 9,
  readTimeoutMs: 3_000,
  readMaxRetries: 2,
  readBackoffMs: [200, 400],
  shipmentTimeoutMs: 5_000,
  globalDeadlineMs: 15_000,
};

export type Intent = z.infer<typeof IntentSchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
export type ShipmentStatus = z.infer<typeof ShipmentStatusSchema>;
export type ReasonCode = (typeof REASON_CODES)[number];
export type ResponseStatus = z.infer<typeof ResponseStatusSchema>;
export type OrderView = z.infer<typeof OrderViewSchema>;
export type PaymentView = z.infer<typeof PaymentViewSchema>;
export type ShipmentView = z.infer<typeof ShipmentViewSchema>;
export type ResponseData = z.infer<typeof ResponseDataSchema>;
export type InterpreterOutput = z.infer<typeof InterpreterOutputSchema>;
