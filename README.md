# Agent Control Lab

**Do you really need an autonomous agent?**

Engineering predictable, testable, and safe AI systems.

> Autonomy where useful. Control where necessary.

## The Engineering Decision

Not every AI workflow needs autonomous planning.

| Dimension | Deterministic Workflow | LLM + Harness | Dynamic Agent |
|---|---|---|---|
| Predictability | High | High within controlled paths | Variable |
| Flexibility | Low | Moderate | High |
| Operational complexity | Low | Moderate | Potentially high |
| Evaluation complexity | Lower | Moderate | Potentially higher |
| Best fit | Known rules | Natural language + known rules | Unpredictable paths |

*Architectural heuristics, not benchmark results.*

## Who Should Plan?

| Strategy | When to use |
|---|---|
| No Planning | Known sequence and dependencies |
| Plan First | Complex objective with relatively stable steps |
| Step-by-Step | Next action depends on intermediate results |

## Do You Really Need LangGraph?

A framework is not an architectural requirement.

For a small workflow with explicit dependencies, a lightweight deterministic Harness may be sufficient.

Consider graph orchestration when branching, durable execution, recovery, or human-in-the-loop coordination justify the additional abstraction.

## Reference Implementation

**Order Operations Agent — Planned**

- LLM-based intent interpretation
- Deterministic execution Harness
- Role-based access control
- Input and output validation
- Bounded retries and timeouts
- Idempotent side effects
- Structured execution logs
- Automated regression tests

## Engineering Principles

**An LLM tool call is a request. Not permission.**

**Test the behavior, not the narrative.**

## Implementation Status

Under development. Architecture and tests will be documented after implementation and verification.

---

Agent engineering is not about maximizing autonomy.
It's about choosing where autonomy is useful — and where control is non-negotiable.
