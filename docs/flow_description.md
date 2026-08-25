# Flow Description

Client sends a command (e.g., "Check overtime for emp_002") to /jobs.
Dispatcher creates a job document in Firestore with status queued and publishes a message containing the jobId to Pub/Sub.
Pub/Sub pushes the message to the Cloud Run worker endpoint /tasks/run.
Worker updates the job status to running and invokes the taskmasterFlow Genkit flow.
Agent decides which tools to call:

- searchPolicies queries MeiliSearch for relevant overtime rules.
- getEmployeeRecord reads the employee from Firestore.
- If an overtime violation is found, resolveOvertime triggers an interrupt.

Interrupt pauses the agent and returns control to the worker, which updates the job status to needs_review and stores the full Genkit response (including conversation history).

Human reviews the request and calls /jobs/:jobId/resume with a decision (approved or rejected).

Worker resumes the Genkit flow using the stored history and the human decision, which is passed to the resolveOvertime tool via restart.

Agent continues and eventually completes, writing the final result back to Firestore with status completed.

## Key Design Decisions

Asynchronous by default: The client never waits for the agent to finish; job state is tracked in Firestore.

Agent‑driven tool selection: The model decides which tools to call and in what order, up to maxTurns: 6.

Human‑in‑the‑loop with interrupts: Genkit's restartable tool pattern allows pausing and resuming without losing context.

Scalable worker: Each Pub/Sub message triggers an independent Cloud Run instance, scaling horizontally with load.