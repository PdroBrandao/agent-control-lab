import { describe, expect, it } from "vitest";
import { ShipmentViewSchema } from "../src/schemas.js";
import { setup, toolNames } from "./helpers.js";

describe("failure handling", () => {
  it("fails closed when the interpreter output does not match the schema", async () => {
    const invalidIntent = setup({ scripted: { intent: "delete_order", order_id: "ORD-100" } });
    const invalidShape = setup({ scripted: "release it" });
    const thrown = setup({
      scripted: () => {
        throw new Error("interpreter crashed");
      },
    });

    expect((await invalidIntent.run("Release shipment for ORD-100")).reason_code).toBe(
      "INVALID_LLM_OUTPUT",
    );
    expect((await invalidShape.run("Release shipment for ORD-100")).reason_code).toBe(
      "INVALID_LLM_OUTPUT",
    );
    expect((await thrown.run("Release shipment for ORD-100")).reason_code).toBe("INVALID_LLM_OUTPUT");
    expect(toolNames(invalidIntent.tools)).toEqual([]);
    expect(toolNames(invalidShape.tools)).toEqual([]);
    expect(toolNames(thrown.tools)).toEqual([]);
  });

  it("stops when a tool response is invalid and does not release", async () => {
    const { run, tools } = setup({
      faults: [{ tool: "get_payment", mode: "invalid_output" }],
    });
    const result = await run("Release shipment for ORD-100");

    expect(result).toMatchObject({ status: "failed", reason_code: "INVALID_TOOL_OUTPUT" });
    expect(toolNames(tools)).toEqual(["get_order", "get_payment"]);
    expect(tools.releaseApplications("ORD-100")).toBe(0);
    expect(result.trace.attempts.filter((attempt) => attempt.tool === "get_payment")).toHaveLength(1);
  });

  it("recovers a read after two transient errors and then releases", async () => {
    const { run, tools, clock, interpreter } = setup({
      faults: [{ tool: "get_order", mode: "error", times: 2 }],
    });
    const result = await run("Release shipment for ORD-100");

    expect(result.reason_code).toBe("SHIPMENT_RELEASED");
    expect(toolNames(tools)).toEqual([
      "get_order",
      "get_order",
      "get_order",
      "get_payment",
      "release_shipment",
    ]);
    expect(clock.sleeps).toEqual([200, 400]);
    expect(result.trace.logical_calls).toBe(3);
    expect(result.trace.physical_attempts).toBe(5);
    expect(interpreter.calls).toHaveLength(1);
    expect(tools.releaseApplications("ORD-100")).toBe(1);
  });

  it("stops after the read retries are exhausted", async () => {
    const { run, tools, clock } = setup({
      faults: [{ tool: "get_order", mode: "error", times: 3 }],
    });
    const result = await run("What is the status of order ORD-100?");

    expect(result).toMatchObject({ status: "failed", reason_code: "RETRIES_EXHAUSTED" });
    expect(toolNames(tools)).toEqual(["get_order", "get_order", "get_order"]);
    expect(clock.sleeps).toEqual([200, 400]);
    expect(result.trace.physical_attempts).toBe(3);
    expect(tools.releaseApplications("ORD-100")).toBe(0);
  });

  it("retries a read timeout signaled by the tool", async () => {
    const { run, tools, clock } = setup({
      faults: [{ tool: "get_order", mode: "timeout", times: 1 }],
    });
    const result = await run("What is the status of order ORD-100?");

    expect(result.reason_code).toBe("ORDER_FOUND");
    expect(result.trace.attempts.map((attempt) => attempt.call_status)).toEqual(["timeout", "success"]);
    expect(clock.sleeps).toEqual([200]);
    expect(toolNames(tools)).toEqual(["get_order", "get_order"]);
  });

  it("enforces the read timeout when the tool never answers", async () => {
    const { run, tools } = setup({
      faults: [{ tool: "get_order", mode: "hang", times: 1 }],
      limits: { readTimeoutMs: 40 },
    });
    const result = await run("What is the status of order ORD-100?");

    expect(result.reason_code).toBe("ORDER_FOUND");
    expect(result.trace.attempts.map((attempt) => attempt.call_status)).toEqual(["timeout", "success"]);
    expect(toolNames(tools)).toEqual(["get_order", "get_order"]);
  });

  it("stops when the global deadline is exceeded", async () => {
    const { run, tools } = setup({
      faults: [{ tool: "get_order", mode: "advance_clock", advanceMs: 16_000 }],
    });
    const result = await run("Release shipment for ORD-100");

    expect(result).toMatchObject({ status: "failed", reason_code: "GLOBAL_DEADLINE_EXCEEDED" });
    expect(toolNames(tools)).toEqual(["get_order"]);
    expect(tools.releaseApplications("ORD-100")).toBe(0);
  });

  it("does not start a release without enough time left to observe it", async () => {
    const { run, tools } = setup({
      faults: [{ tool: "get_order", mode: "advance_clock", advanceMs: 11_000 }],
    });
    const result = await run("Release shipment for ORD-100");

    expect(result).toMatchObject({ status: "blocked", reason_code: "INSUFFICIENT_TIME" });
    expect(toolNames(tools)).toEqual(["get_order"]);
    expect(tools.releaseApplications("ORD-100")).toBe(0);
  });

  it("does not retry a shipment error that returned before the effect", async () => {
    const { run, tools, clock } = setup({
      faults: [{ tool: "release_shipment", mode: "error" }],
    });
    const result = await run("Release shipment for ORD-100");

    expect(result).toMatchObject({ status: "failed", reason_code: "SHIPMENT_FAILED" });
    expect(toolNames(tools).filter((name) => name === "release_shipment")).toEqual(["release_shipment"]);
    expect(result.trace.attempts.filter((attempt) => attempt.tool === "release_shipment")).toEqual([
      {
        tool: "release_shipment",
        attempt: 1,
        call_status: "error",
        effect_status: "not_applied",
      },
    ]);
    expect(clock.sleeps).toEqual([]);
    expect(tools.releaseApplications("ORD-100")).toBe(0);
    expect(tools.orderStatus("ORD-100")).toBe("open");
  });

  it("treats a shipment timeout before a visible commit as uncertain and does not retry", async () => {
    const { run, tools, clock } = setup({
      faults: [{ tool: "release_shipment", mode: "timeout" }],
    });
    const result = await run("Release shipment for ORD-100");

    expect(result.status).toBe("uncertain");
    expect(result.reason_code).toBe("SHIPMENT_EFFECT_UNKNOWN");
    expect(result.message).not.toMatch(/was released/i);
    expect(toolNames(tools).filter((name) => name === "release_shipment")).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
    expect(tools.releaseApplications("ORD-100")).toBe(0);
  });

  it("keeps an applied shipment effect uncertain when the confirmation never arrives", async () => {
    const { run, tools, clock } = setup({
      faults: [{ tool: "release_shipment", mode: "hang_after_effect" }],
      limits: { shipmentTimeoutMs: 40 },
    });
    const first = await run("Release shipment for ORD-100");

    expect(first.status).toBe("uncertain");
    expect(first.reason_code).toBe("SHIPMENT_EFFECT_UNKNOWN");
    expect(first.message).toBe(
      "The shipment release was not confirmed. The effect may have been applied. It will not be retried automatically.",
    );
    expect(first.trace.attempts.filter((attempt) => attempt.tool === "release_shipment")).toEqual([
      {
        tool: "release_shipment",
        attempt: 1,
        call_status: "timeout",
        effect_status: "unknown",
      },
    ]);
    expect(clock.sleeps).toEqual([]);
    expect(tools.releaseApplications("ORD-100")).toBe(1);
    expect(tools.orderStatus("ORD-100")).toBe("shipped");
    expect(toolNames(tools).filter((name) => name === "release_shipment")).toHaveLength(1);

    const reread = await run("What is the status of order ORD-100?");
    expect(reread).toMatchObject({
      status: "completed",
      reason_code: "ORDER_FOUND",
      data: { order: { order_id: "ORD-100", status: "shipped" } },
    });

    const second = await run("Release shipment for ORD-100");
    expect(second).toMatchObject({
      status: "completed",
      reason_code: "SHIPMENT_ALREADY_RELEASED",
      data: { order: { order_id: "ORD-100", status: "shipped" } },
    });
    expect(second.data?.shipment).toBeUndefined();
    expect(tools.releaseApplications("ORD-100")).toBe(1);
    expect(toolNames(tools).filter((name) => name === "release_shipment")).toHaveLength(1);
  });

  it("rejects an invalid shipment payload without a second attempt", async () => {
    const { run, tools } = setup({
      faults: [{ tool: "release_shipment", mode: "invalid_output" }],
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
    expect(toolNames(tools).filter((name) => name === "release_shipment")).toHaveLength(1);
    expect(tools.releaseApplications("ORD-100")).toBe(0);
  });

  it("stops before release when the logical call limit is reached", async () => {
    const { run, tools } = setup({ limits: { maxLogicalToolCalls: 2 } });
    const result = await run("Release shipment for ORD-100");

    expect(result.reason_code).toBe("TOOL_CALL_LIMIT");
    expect(toolNames(tools)).toEqual(["get_order", "get_payment"]);
    expect(tools.releaseApplications("ORD-100")).toBe(0);
  });

  it("stops a read when the physical attempt limit is reached", async () => {
    const { run, tools } = setup({
      faults: [{ tool: "get_order", mode: "error", times: 5 }],
      limits: { maxPhysicalAttempts: 2 },
    });
    const result = await run("What is the status of order ORD-100?");

    expect(result.reason_code).toBe("TOOL_CALL_LIMIT");
    expect(toolNames(tools)).toEqual(["get_order", "get_order"]);
  });
});

describe("shipment tool idempotency", () => {
  it("rechecks payment inside the tool and rejects without committing", async () => {
    const { tools } = setup();
    tools.setPaymentStatus("ORD-100", "pending");

    const result = ShipmentViewSchema.parse(await tools.releaseShipment("ORD-100"));

    expect(result.status).toBe("rejected");
    expect(tools.releaseApplications("ORD-100")).toBe(0);
    expect(tools.orderStatus("ORD-100")).toBe("open");
  });

  it("rechecks a cancelled order inside the tool", async () => {
    const { tools } = setup();
    tools.setOrderStatus("ORD-100", "cancelled");

    const result = ShipmentViewSchema.parse(await tools.releaseShipment("ORD-100"));

    expect(result.status).toBe("rejected");
    expect(tools.releaseApplications("ORD-100")).toBe(0);
  });

  it("serializes concurrent releases into one effect", async () => {
    const { tools } = setup();
    const results = await Promise.all([
      tools.releaseShipment("ORD-100"),
      tools.releaseShipment("ORD-100"),
    ]);
    const statuses = results.map((result) => ShipmentViewSchema.parse(result).status).sort();

    expect(statuses).toEqual(["already_released", "released"]);
    expect(tools.releaseApplications("ORD-100")).toBe(1);
    expect(toolNames(tools).filter((name) => name === "release_shipment")).toHaveLength(2);
  });
});
