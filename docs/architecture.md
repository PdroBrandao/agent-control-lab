# Architecture

The Order Operations Agent is a fixed policy with one language-understanding step in front of it.

```text
message → Interpreter → Deterministic Harness → Tools → Response Builder
                ↑
        trusted user id enters only at the Harness
```

The deeper control rules are below. Install, scenarios, and the decision matrix live in the [README](../README.md).

## Why the flow is deterministic

Releasing a shipment is a total function of trusted identity and facts the tools have just returned. The next step does not depend on a planner. An open order continues to the payment read. A pending payment stops. A confirmed payment allows one release attempt.

A model that selected tools could skip the payment read, retry a shipment whose result was lost, or name an order the user did not write. Those are policy bugs, and a regression test cannot pin them down if the path is chosen at runtime. The Harness encodes the only legal sequence. Intermediate results change whether the flow stops. They do not change which step is legal.

## What belongs to the LLM

The Interpreter receives the user message and returns one proposal:

```json
{ "intent": "release_shipment", "order_id": "ORD-100" }
```

`intent` is a closed set: `get_order`, `get_payment`, `release_shipment`, `clarify`, `unsupported`. The Interpreter is called once. It does not see tool results, and it is not called again after a tool returns.

`FakeLLM` is the default. It is a deterministic heuristic so the policy can run and be tested with no provider. `OpenAIInterpreter` is an optional adapter for an OpenAI-compatible chat endpoint. It is parsed with the same Zod schema. Fields outside that schema, including any claim of role or authorization, are discarded before the Harness proceeds.

The model is useful because the input is unstructured language. That usefulness ends at the proposal.

## What belongs to the Harness

The Harness owns every decision that changes authorization, money-adjacent state, or the end of the run:

- the global deadline and the call budget
- rejection of an interpreter result that fails the schema
- identity, taken from the caller-supplied user id
- role checks: a viewer may read, only an admin may release, an unknown user stops immediately
- binding: the proposed order id must appear as a whole token in the message
- read retries, with backoff, only while time remains
- the eligibility rule: open order, confirmed payment, then release
- a single `release_shipment` attempt
- classification of that attempt as applied, not applied, or unknown
- the `reason_code` that ends the execution

The Response Builder turns that reason code and the verified facts into the user-facing message. The model does not write it. A test can therefore assert the message, the status, and the exact tool sequence.

## How duplicate effects are avoided

Three stops are independent. Any one of them is enough to keep a second release from committing.

1. If `get_order` returns `shipped`, the Harness finishes with `SHIPMENT_ALREADY_RELEASED` and does not call `release_shipment`.
2. Inside one execution the shipment tool is attempted at most once. There is no retry branch on timeout, on a malformed body, or on `EffectNotStartedError`.
3. The tool commits an in-memory release record and the `shipped` status together, on a per-process queue. A later call sees the record and returns `already_released`. The application count stays at one. Two overlapping calls are serialized on that queue, so one commits and the other observes the record.

A lost response does not roll the commit back. The in-memory record does not survive a process restart. That is the boundary of the guarantee. A durable order service would have to provide the same record outside the process. The Harness would still refuse to treat a missing confirmation as permission to call again blindly.

## Why a timeout is not an operation failure

A read has no side effect. If `get_order` or `get_payment` times out, the observation failed and the Harness may retry inside the remaining budget. Exhausting those retries is a failed execution. The shipment was not started.

A shipment call is different. The tool can commit and then hang, or the response can be lost after the commit. At the Harness those cases arrive as a timeout or as a generic error. Neither one proves that the warehouse did nothing. The attempt is recorded with `effect_status: "unknown"` and the execution ends as `uncertain` / `SHIPMENT_EFFECT_UNKNOWN`. It is not retried.

`EffectNotStartedError` is the only signal that the effect is known to be absent. That path ends as `failed` / `SHIPMENT_FAILED`, and it is still not retried inside the same execution. The order stays open, so a later request can try again under the same policy.

A body that fails validation, or that names another order, is also `unknown`. A malformed confirmation is not evidence that the effect is absent. In the simulator, some of those faults return before the commit. The Harness still reports `uncertain`, because it will not infer absence from a payload it cannot trust.

If the time left on the global deadline is shorter than the shipment timeout, the Harness returns `INSUFFICIENT_TIME` and does not start the call. It will not begin an effect it cannot wait to observe.

## When to move to dynamic orchestration

Move when the next action depends on intermediate results the policy cannot enumerate, when a human approval must pause the run and resume after a process restart, or when recovery is itself a workflow with durable state. A graph runtime earns its cost there: branching, checkpointed execution, and long-lived coordination.

This policy does not have that shape. The sequence is fixed, the side effect is at most once, and every stop has a reason code. Placing the same steps in a graph would move the control flow without giving the model any authority it does not already lack. Use dynamic orchestration when the product problem is durable, branching coordination. Keep the Harness when the product problem is a closed policy around one side effect.
