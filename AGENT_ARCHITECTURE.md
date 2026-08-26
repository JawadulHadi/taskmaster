# Agent Architecture — Taskmaster Genkit ADK Engine

## 1. Overview
The **Taskmaster Agent** is an autonomous, event-driven HR compliance and operations orchestration platform built with the **Genkit & ADK Agentic Loops SDK™**. Designed specifically for the **All Things Agentic Hackathon ("Ready, Set, Agent!")**, the system coordinates asynchronous background processing, large-scale dataset indexing, autonomous tool reasoning via **Gemini 3.5 Flash**, and Human-in-the-Loop (HITL) interrupt management.

---

## 2. Event-Driven Workflow Architecture

```
[ Client Request /jobs ] 
         │
         ▼
[ Firestore Job Record (status: queued) ] ──► [ Pub/Sub Message Broker ]
                                                     │ (Push Webhook)
                                                     ▼
                                         [ Cloud Run Worker /tasks/run ]
                                                     │
                                                     ▼
                                         [ EventEmitter Workflow Engine ]
                                                     │
         ┌───────────────────────────────────────────┼───────────────────────────────────────────┐
         ▼                                           ▼                                           ▼
[ AI Analysis Stage ]                      [ HR Policy Validation ]                   [ Meilisearch Audit Indexing ]
(Gemini 3.5 Flash timesheet parsing)       (Meilisearch + Firestore compliance rules) (Asynchronous audit trail storage)
         │                                           │
         └───────────────────────────────────────────┼───────────────────────────────────────────┘
                                                     ▼
                                     { Compliance Check Outcome }
                                       ├── PASSED ──► [ Status: completed ] ──► [ Firestore Employee Update ]
                                       └── VIOLATION ──► [ HITL Interrupt Pause ] ──► [ Manager Review Dashboard ] ──► /resume
```

### Lifecycle Phases
1. **Ingestion & Dispatch (`JOB_INGESTED`)**: Clients submit HR directives to `/jobs`. The dispatcher persists the job in **Firestore** with `status: queued` and publishes the `jobId` to **Pub/Sub**.
2. **Asynchronous Execution (`AI_ANALYSIS_STARTED`)**: Pub/Sub pushes messages to the Cloud Run worker endpoint (`/tasks/run`). The event-driven engine transitions the job to `running` and invokes **Gemini 3.5 Flash** to extract structured JSON timesheets from unstructured shift notes.
3. **Policy Compliance & Reasoning (`POLICY_VALIDATION_TRIGGERED`)**: The agent invokes tool-calling loops (`searchPolicies`, `getEmployeeRecord`) to evaluate hours against labor regulations and corporate guidelines.
4. **Human-in-the-Loop Interrupt (`HUMAN_REVIEW_INTERRUPT`)**: If overtime limits (e.g. > 10 hours) or labor violations are detected, execution pauses (`status: needs_review`), conversation state is preserved, and supervisor notification alerts are dispatched. Supervisors can resume execution via `POST /jobs/:jobId/resume`.
5. **Audit Indexing (`AUDIT_INDEXING_TRIGGERED`)**: Completed or reviewed tasks are indexed into **Meilisearch** for high-performance enterprise audit searchability.

---

## 3. Gemini Integration & HR Policy Validation

- **Model Selection**: Powered by **Gemini 3.5 Flash**, chosen for its speed, high accuracy in structured JSON extraction, and resilient multi-turn tool calling.
- **Autonomous Tool Execution**:
  - `searchPolicies`: Queries Meilisearch vector/full-text indices for relevant overtime and break regulations.
  - `getEmployeeRecord`: Fetches current employee metadata, historical hours, and department records from Firestore.
  - `resolveOvertime`: Evaluates compliance infractions and triggers HITL pause/resume logic.
- **Zero Hallucination Validation**: Extracted numerical metrics (regular hours, overtime hours, shift differentials) are strictly cross-checked against deterministic TypeScript validation rules in `src/utils/validator.ts`.

---

## 4. Alignment with All Things Agentic Hackathon

| Hackathon Criterion | Taskmaster Implementation |
| :--- | :--- |
| **Ready, Set, Agent!** | Fully autonomous Genkit agent loop (`taskmasterFlow`) with up to 6 reasoning turns. |
| **Run in the Background** | Asynchronous Pub/Sub message queues coupled with Cloud Run worker endpoints (`/tasks/run`). |
| **Handle Heavy Datasets** | Dual-engine indexing combining Meilisearch full-text search with Cloud Firestore document collections. |
| **Automate Complex Workflows** | End-to-end HR compliance auditing with automated rule enforcement and restartable HITL interrupts. |
