# Taskmaster Agent — Hackathon Submission Writeup
**All Things Agentic Hackathon — Track: Taskmaster**

---

## Inspiration

HR-ops overtime review is a paperwork problem pretending to be a policy problem. Someone has to notice a shift log crossed a threshold, look up the right rule, check the employee's history, and decide whether to escalate — every pay period, by hand. It's exactly the kind of multi-step, judgment-adjacent task that gets pitched as "AI-ready," and exactly the kind that's easy to fake: wire up a Gemini call for the text-sounding parts, hardcode the actual decision logic underneath, and call it an agent.

We built Taskmaster to not do that. The design constraint from day one was: if you can't point to the exact line where the model decides what happens next, it's not an agent — it's a workflow with a chatbot bolted on.

## What it does

Taskmaster is an event-driven HR-ops agent that takes a natural-language job command (e.g. "review emp_002's timesheet for overtime violations") and autonomously:

1. **Decides which tools it needs** — searches the live policy rulebook (Meilisearch), pulls the employee's real timesheet record (Firestore), in whatever order the situation calls for. Nothing is scripted; the model picks.
2. **Detects a policy violation** — if overtime hours exceed the configured ceiling, the agent doesn't auto-resolve it.
3. **Actually pauses** — a genuine execution interrupt, not an `if` statement dressed up as one. The job sits in `needs_review` state, a notification goes out, and the agent will not commit anything until a human responds.
4. **Resumes on human decision** — override, reject, or manually adjust — and only then writes the resolution and indexes it for audit.

The whole thing runs asynchronously: `POST /jobs` returns immediately, Pub/Sub carries the job to a Cloud Run worker, and the agent loop executes off the request path.

## How we built it

- **Google Genkit** (TypeScript) — the agent framework itself. `ai.generate({ tools, maxTurns })` *is* the reasoning loop; there's no hand-rolled state machine deciding tool order.
- **Gemini 3.6 Flash**, called directly through Genkit's `@genkit-ai/google-genai` plugin — not through a third-party router, to satisfy the track's model-access requirement.
- **Cloud Run** — dispatcher and worker as one Express service, split by route (`POST /jobs` vs. the Pub/Sub push target `POST /tasks/run`).
- **Pub/Sub** — the job queue between dispatch and execution, with OIDC token verification on the push endpoint so the worker only trusts requests actually signed by the Pub/Sub service account.
- **Firestore** — job status and employee/timesheet records.
- **Meilisearch** — two separate indexes: the policy rulebook the agent searches, and the audit-history trail every completed job writes into.
- **A real interrupt-based HITL gate** — Genkit's tool-interrupt mechanism suspends the run mid-execution; a separate `/jobs/:jobId/resume` endpoint feeds the human's decision back in to continue it.

## Challenges we ran into

**We almost disqualified ourselves in the design phase.** The first architecture sketch used LangGraph with model calls routed through OpenRouter — a clean, well-known agentic pattern, and completely wrong for this track's rules, which require a Google agent framework and a direct Gemini API call. Caught it before writing real code and rebuilt on Genkit instead.

**We built two agents by accident.** Partway through, the repo ended up with the real Genkit tool-calling loop *and* a second, fully deterministic pipeline (an event-emitter chain that always ran the same four validation steps in the same order) both listening for the same job dispatch — meaning every submitted job was silently processed twice, racing to write the same status. Caught in code review, confirmed with a live test (submit once, watch for exactly one status transition), and removed. That fix also surfaced a second problem: deleting the shadow engine had orphaned the audit-indexing step and the task-listing endpoint, so those got rewired to the single real pipeline instead of just deleted.

**Fake-AI is a pattern, not a one-off.** Before this project, we reviewed a different repo (`vapor-db`) that used identical language — "ReAct," "cognitive orchestrator," "vector search" — over zero actual model calls: hardcoded steps, `setTimeout` delays standing in for "thinking," keyword-matching standing in for a vector index. That review is the reason Taskmaster got checked this hard for the same failure mode in its own code, not just its README.

## Accomplishments we're proud of

- A tool-calling loop where `maxTurns: 6` is the only ceiling — the model genuinely decides whether it needs to search policy, look up an employee, both, or neither, and in what order.
- A HITL gate that isn't performative: the agent process actually suspends, and nothing gets written to the system of record until a human resumes it.
- Caught our own dual-engine race condition before it shipped, not after — with a real end-to-end test, not just a code read.

## What's next

- Expand the tool set beyond overtime (shift-swap requests, PTO conflicts) using the same pattern — new tools, same loop, no new engine.
- Add a second write-tool with its own interrupt so the HITL pattern isn't only demonstrated once.
- Load-test the Pub/Sub → Cloud Run path under concurrent job submissions now that there's only one pipeline to reason about.
