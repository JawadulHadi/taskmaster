# Genkit & ADK Agentic Loops SDK™

The **Taskmaster Agentic Loops SDK** is an enterprise-grade framework built on top of **Google Genkit**, **Gemini 3.5 Flash**, **Google Cloud Firestore**, **Pub/Sub**, and **Meilisearch**. It provides a fully asynchronous, event-driven agentic loop architecture designed for compliance-critical HR and operations workflows with built-in Human-in-the-Loop (HITL) interrupt and resume capabilities.

---

## Architecture & Core Modules

```
[ Client Request ] 
       │ (HTTP POST /jobs)
       ▼
[ Dispatcher ] ──(Firestore Job Status: queued)──► [ Pub/Sub Message Broker ]
                                                           │ (Push Webhook)
                                                           ▼
                                               [ Cloud Run Worker /tasks/run ]
                                                           │
                                                           ▼
                                               [ Genkit Agentic Loop ]
                                               (Gemini 3.5 Flash reasoning)
                                                           │
                         ┌─────────────────────────────────┴─────────────────────────────────┐
                         ▼                                                                   ▼
           [ Policy Retrieval Tools ]                                         [ Employee Database ]
           (Meilisearch policy index)                                         (Firestore records)
                         │                                                                   │
                         └─────────────────────────────────┬─────────────────────────────────┘
                                                           ▼
                                              { Overtime Violation Detected? }
                                                ├── YES ──► [ HITL Interrupt Pause ] ──► [ Manager Approval UI ] ──► /resume
                                                └── NO  ──► [ Automatic Approval ] ──► [ Meilisearch Audit Indexing ]
```

---

## Key SDK Features

1. **Autonomous Agentic Loops (`Genkit` + `Gemini 3.5 Flash`)**:
   - The model dynamically evaluates commands, invokes tools (`search_policies`, `get_employee_record`, `resolve_overtime`), and iterates up to `maxTurns: 6`.
2. **Event-Driven Pub/Sub & Cloud Run Orchestration**:
   - Asynchronous job dispatching guarantees zero blocking on client requests. Pub/Sub pushes payloads to Cloud Run workers for horizontal scalability.
3. **Restartable HITL Interrupts**:
   - When policy thresholds (e.g., overtime > 10 hours) are breached, Genkit pauses execution, preserves conversation state, and flags the job as `needs_review` awaiting supervisor confirmation.
4. **Resilient Dual-Engine Search & Persistence**:
   - Seamlessly synchronizes operational state across Firestore and Meilisearch with automatic in-memory fallbacks when external services are unconfigured.

---

## SDK API Reference

### 1. Initializing the Genkit Agent Flow
```typescript
import { ai } from "./ai/genkit.js";
import { taskmasterFlow } from "./ai/flows/taskmasterFlow.js";

// Execute agent loop
const result = await taskmasterFlow({
  command: "Check overtime for employee emp_002 and resolve violations.",
  tenantId: "tenant_01"
});
```

### 2. Dispatching a Job via REST API
```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{"command": "Audit timesheet for employee emp_002", "tenantId": "tenant_01"}'
```

### 3. Resuming a Paused HITL Job
```bash
curl -X POST http://localhost:3000/jobs/<jobId>/resume \
  -H "Content-Type: application/json" \
  -d '{"decision": "approved"}'
```
