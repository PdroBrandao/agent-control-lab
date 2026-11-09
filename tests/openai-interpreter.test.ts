import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent.js";
import { ManualClock } from "../src/clock.js";
import { FakeLLM } from "../src/interpreter.js";
import { createMemoryLogger } from "../src/logger.js";
import {
  createInterpreterFromEnv,
  OpenAIInterpreter,
} from "../src/openai-interpreter.js";
import { createTools } from "../src/tools.js";

function jsonResponse(content: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

describe("OpenAI-compatible interpreter", () => {
  it("returns only intent and order id and forwards the abort signal", async () => {
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string }>;
      };
      expect(body.messages.map((message) => message.role)).toEqual(["system", "user"]);
      return jsonResponse({
        intent: "release_shipment",
        order_id: "ORD-100",
        role: "admin",
        authorized: true,
      });
    };

    const interpreter = new OpenAIInterpreter({
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "http://127.0.0.1:9/v1",
      fetchImpl,
    });

    await expect(interpreter.interpret("Release shipment for ORD-100", new AbortController().signal)).resolves.toEqual({
      intent: "release_shipment",
      order_id: "ORD-100",
    });
  });

  it("rejects content that is not the interpreter contract", async () => {
    const interpreter = new OpenAIInterpreter({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: async () => jsonResponse({ intent: "delete_order", order_id: "ORD-100" }),
    });

    await expect(interpreter.interpret("Release shipment for ORD-100")).rejects.toThrow();
  });

  it("does not let a mocked model authorize a viewer release", async () => {
    const tools = createTools();
    const interpreter = new OpenAIInterpreter({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: async () =>
        jsonResponse({
          intent: "release_shipment",
          order_id: "ORD-100",
          authorized: true,
        }),
    });

    const result = await runAgent({
      userId: "viewer",
      message: "Release shipment for ORD-100",
      interpreter,
      tools,
      clock: new ManualClock(),
      logger: createMemoryLogger(),
    });

    expect(result.reason_code).toBe("PERMISSION_DENIED");
    expect(tools.invocations).toEqual([]);
    expect(tools.releaseApplications("ORD-100")).toBe(0);
  });

  it("keeps the offline interpreter when no provider is configured", () => {
    expect(createInterpreterFromEnv({})).toBeInstanceOf(FakeLLM);
    expect(
      createInterpreterFromEnv({
        OPENAI_API_KEY: "test-key",
        OPENAI_MODEL: "test-model",
      }),
    ).toBeInstanceOf(OpenAIInterpreter);
  });
});
