export class CallTimeoutError extends Error {
  constructor() {
    super("tool call timed out");
    this.name = "CallTimeoutError";
  }
}

export class TransientToolError extends Error {
  constructor(message = "transient tool failure") {
    super(message);
    this.name = "TransientToolError";
  }
}

export class InvalidToolInputError extends Error {
  constructor(orderId: string) {
    super(`invalid order id: ${orderId}`);
    this.name = "InvalidToolInputError";
  }
}

/** The side effect is known not to have started. A generic error is not this signal. */
export class EffectNotStartedError extends Error {
  constructor(message = "shipment effect did not start") {
    super(message);
    this.name = "EffectNotStartedError";
  }
}

export function isCallTimeout(error: unknown): boolean {
  return error instanceof CallTimeoutError;
}
