import {
  FinalResponseSchema,
  STATUS_BY_REASON,
  type OrderView,
  type PaymentView,
  type ReasonCode,
  type ResponseData,
  type ShipmentView,
} from "./schemas.js";

export interface VerifiedFacts {
  orderId?: string | null;
  order?: OrderView;
  payment?: PaymentView;
  shipment?: ShipmentView;
}

export interface BuiltResponse {
  execution_id: string;
  status: (typeof STATUS_BY_REASON)[ReasonCode];
  message: string;
  reason_code: ReasonCode;
  data?: ResponseData;
}

function orderLabel(facts: VerifiedFacts): string {
  return facts.order?.order_id ?? facts.orderId ?? "the order";
}

export function messageFor(reasonCode: ReasonCode, facts: VerifiedFacts): string {
  const id = orderLabel(facts);
  switch (reasonCode) {
    case "ORDER_FOUND":
      return `Order ${id} is ${facts.order?.status}.`;
    case "PAYMENT_FOUND":
      return `Payment for ${id} is ${facts.payment?.status}.`;
    case "SHIPMENT_RELEASED":
      return `Shipment for ${id} was released.`;
    case "SHIPMENT_ALREADY_RELEASED":
      return `Shipment for ${id} was already released.`;
    case "PAYMENT_PENDING":
      return "Payment is pending.";
    case "PAYMENT_NOT_CONFIRMED":
      return `Payment is ${facts.payment?.status ?? "not confirmed"} and does not allow shipment release.`;
    case "ORDER_NOT_FOUND":
      return `Order ${id} was not found.`;
    case "ORDER_NOT_ELIGIBLE":
      return `Order ${id} is ${facts.order?.status} and cannot be released.`;
    case "UNKNOWN_USER":
      return "The user is not recognized.";
    case "PERMISSION_DENIED":
      return "The user is not allowed to release shipments.";
    case "INSUFFICIENT_TIME":
      return "Not enough time remains to release the shipment safely.";
    case "SHIPMENT_REJECTED":
      return "The shipment service rejected the release after rechecking the order and payment.";
    case "ORDER_ID_MISMATCH":
      return "The order id was not present in the request. No tool was called.";
    case "MISSING_ORDER_ID":
      return "An order id in the format ORD-123 is required.";
    case "AMBIGUOUS_REQUEST":
      return "The request is ambiguous. Ask for one action: order, payment, or shipment release.";
    case "UNSUPPORTED_REQUEST":
      return "The request is not supported. Supported actions are order lookup, payment lookup, and shipment release.";
    case "INVALID_LLM_OUTPUT":
      return "The interpreter output was invalid. No tool was called.";
    case "INVALID_TOOL_OUTPUT":
      return "A tool returned an invalid response. The operation was not confirmed.";
    case "INVALID_TOOL_INPUT":
      return "A tool was called with an invalid argument. The operation stopped.";
    case "RETRIES_EXHAUSTED":
      return "The read operation failed after the allowed retries.";
    case "GLOBAL_DEADLINE_EXCEEDED":
      return "The execution deadline was exceeded before the operation could finish.";
    case "TOOL_CALL_LIMIT":
      return "The tool-call limit was reached. The operation stopped.";
    case "SHIPMENT_FAILED":
      return "The shipment call failed before confirmation. It was not retried.";
    case "SHIPMENT_EFFECT_UNKNOWN":
      return "The shipment release was not confirmed. The effect may have been applied. It will not be retried automatically.";
  }
}

export function buildResponse(
  executionId: string,
  reasonCode: ReasonCode,
  facts: VerifiedFacts = {},
): BuiltResponse {
  const data: ResponseData = {};
  if (facts.order) data.order = facts.order;
  if (facts.payment) data.payment = facts.payment;
  if (facts.shipment) data.shipment = facts.shipment;

  return FinalResponseSchema.parse({
    execution_id: executionId,
    status: STATUS_BY_REASON[reasonCode],
    message: messageFor(reasonCode, facts),
    reason_code: reasonCode,
    data: Object.keys(data).length > 0 ? data : undefined,
  });
}
