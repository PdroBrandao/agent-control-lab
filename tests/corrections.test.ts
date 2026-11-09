import { describe, expect, it } from "vitest";
import { setup, toolNames } from "./helpers.js";

describe("shipment effect classification", () => {
  it("treats an error after the operation starts as uncertain and does not retry", async () => {
    const { run, tools, clock } = setup({
      faults: [{ tool: "release_shipment", mode: "error_after_start" }],
    });
    const result = await run("Release shipment for ORD-100");

    expect(result).toMatchObject({
      status: "uncertain",
      reason_code: "SHIPMENT_EFFECT_UNKNOWN",
    });
    expect(result.trace.attempts.filter((attempt) => attempt.tool === "release_shipment")).toEqual([
      {
        tool: "release_shipment",
        attempt: 1,
        call_status: "error",
        effect_status: "unknown",
      },
    ]);
    expect(clock.sleeps).toEqual([]);
    expect(toolNames(tools).filter((name) => name === "release_shipment")).toHaveLength(1);
    expect(tools.releaseApplications("ORD-100")).toBe(0);
    expect(result.message).not.toMatch(/was released/i);
  });

  it("keeps the shipped state when an error follows a committed effect", async () => {
    const { run, tools, clock } = setup({
      faults: [{ tool: "release_shipment", mode: "error_after_effect" }],
    });
    const first = await run("Release shipment for ORD-100");

    expect(first.status).toBe("uncertain");
    expect(first.reason_code).toBe("SHIPMENT_EFFECT_UNKNOWN");
    expect(first.trace.attempts.at(-1)?.effect_status).toBe("unknown");
    expect(clock.sleeps).toEqual([]);
    expect(tools.releaseApplications("ORD-100")).toBe(1);
    expect(tools.orderStatus("ORD-100")).toBe("shipped");
    expect(toolNames(tools).filter((name) => name === "release_shipment")).toHaveLength(1);

    const reread = await run("What is the status of order ORD-100?");
    expect(reread.data?.order?.status).toBe("shipped");

    const second = await run("Release shipment for ORD-100");
    expect(second.reason_code).toBe("SHIPMENT_ALREADY_RELEASED");
    expect(tools.releaseApplications("ORD-100")).toBe(1);
    expect(toolNames(tools).filter((name) => name === "release_shipment")).toHaveLength(1);
  });
});

describe("interpreter deadline", () => {
  it("stops a hanging interpreter inside the global deadline and calls no tool", async () => {
    let aborted = false;
    const { run, tools, interpreter } = setup({
      limits: { globalDeadlineMs: 30 },
      scripted: (_message: string, signal?: AbortSignal) =>
        new Promise(() => {
          signal?.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    });

    const result = await run("Release shipment for ORD-100");

    expect(result).toMatchObject({
      status: "failed",
      reason_code: "GLOBAL_DEADLINE_EXCEEDED",
    });
    expect(toolNames(tools)).toEqual([]);
    expect(tools.releaseApplications("ORD-100")).toBe(0);
    expect(interpreter.calls).toHaveLength(1);
    expect(aborted).toBe(true);
  });
});

describe("interpreter order id binding", () => {
  it("allows the flow when the proposed id is the full id in the message", async () => {
    const { run, tools } = setup({
      scripted: { intent: "get_order", order_id: "ORD-100" },
    });
    const result = await run("What is the status of order ORD-100?");

    expect(result).toMatchObject({ status: "completed", reason_code: "ORDER_FOUND" });
    expect(toolNames(tools)).toEqual(["get_order"]);
  });

  it("blocks a different order id before any tool call", async () => {
    const { run, tools } = setup({
      scripted: { intent: "release_shipment", order_id: "ORD-200" },
    });
    const result = await run("Release shipment for ORD-100");

    expect(result).toMatchObject({ status: "blocked", reason_code: "ORDER_ID_MISMATCH" });
    expect(toolNames(tools)).toEqual([]);
    expect(tools.releaseApplications("ORD-100")).toBe(0);
    expect(tools.releaseApplications("ORD-200")).toBe(0);
  });

  it("blocks a partial id match in either direction", async () => {
    const shorter = setup({
      scripted: { intent: "get_order", order_id: "ORD-10" },
    });
    const longer = setup({
      scripted: { intent: "get_order", order_id: "ORD-100" },
    });

    const prefix = await shorter.run("What is the status of order ORD-100?");
    const extension = await longer.run("What is the status of order ORD-10?");

    expect(prefix).toMatchObject({ status: "blocked", reason_code: "ORDER_ID_MISMATCH" });
    expect(extension).toMatchObject({ status: "blocked", reason_code: "ORDER_ID_MISMATCH" });
    expect(toolNames(shorter.tools)).toEqual([]);
    expect(toolNames(longer.tools)).toEqual([]);
  });

  it("blocks a scripted substitution even when the other order could be released", async () => {
    const { run, tools } = setup({
      scripted: {
        intent: "release_shipment",
        order_id: "ORD-100",
        role: "admin",
        authorized: true,
      },
    });
    const result = await run("Release shipment for ORD-200");

    expect(result.reason_code).toBe("ORDER_ID_MISMATCH");
    expect(toolNames(tools)).toEqual([]);
    expect(tools.orderStatus("ORD-100")).toBe("open");
    expect(tools.releaseApplications("ORD-100")).toBe(0);
  });

  it("keeps clarification when the request has no order id", async () => {
    const { run, tools } = setup();
    const result = await run("Release the shipment");

    expect(result).toMatchObject({
      status: "clarification_required",
      reason_code: "MISSING_ORDER_ID",
    });
    expect(toolNames(tools)).toEqual([]);
  });
});

describe("tool identity binding", () => {
  it("rejects an order payload for a different order before release", async () => {
    const { run, tools } = setup({
      faults: [{ tool: "get_order", mode: "foreign_order", foreignOrderId: "ORD-999" }],
    });
    const result = await run("Release shipment for ORD-100");

    expect(result).toMatchObject({ status: "failed", reason_code: "INVALID_TOOL_OUTPUT" });
    expect(toolNames(tools)).toEqual(["get_order"]);
    expect(result.data?.order).toBeUndefined();
    expect(tools.releaseApplications("ORD-100")).toBe(0);
  });

  it("rejects a payment payload for a different order before release", async () => {
    const { run, tools } = setup({
      faults: [{ tool: "get_payment", mode: "foreign_order", foreignOrderId: "ORD-999" }],
    });
    const result = await run("Release shipment for ORD-100");

    expect(result.reason_code).toBe("INVALID_TOOL_OUTPUT");
    expect(toolNames(tools)).toEqual(["get_order", "get_payment"]);
    expect(tools.releaseApplications("ORD-100")).toBe(0);
  });

  it("does not accept a shipment confirmation for a different order", async () => {
    const { run, tools } = setup({
      faults: [{ tool: "release_shipment", mode: "foreign_order", foreignOrderId: "ORD-999" }],
    });
    const result = await run("Release shipment for ORD-100");

    expect(result).toMatchObject({
      status: "uncertain",
      reason_code: "SHIPMENT_EFFECT_UNKNOWN",
    });
    expect(result.data?.shipment).toBeUndefined();
    expect(toolNames(tools).filter((name) => name === "release_shipment")).toHaveLength(1);
    expect(tools.releaseApplications("ORD-100")).toBe(0);
    expect(tools.orderStatus("ORD-100")).toBe("open");
  });
});
