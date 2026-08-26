# Architecture Specification — Genkit ADK Agentic Loops SDK™

## High‑Level Overview

The Taskmaster Agent is a fully asynchronous, event‑driven system built on Google Cloud and powered by the **Genkit & ADK Agentic Loops SDK™**.

### Components

- **Client**: Any HTTP client that submits an HR directive via `POST /jobs`.
- **Dispatcher**: Express route that writes the job to Firestore with status `queued` and publishes a message to Pub/Sub.
- **Firestore**: Stores job state, employee records, and time-tracking data.
- **Pub/Sub**: Decouples job submission from processing. Push subscription triggers the Cloud Run worker endpoint `/tasks/run`.
- **Worker (Cloud Run)**: Receives the Pub/Sub message, invokes the Genkit agentic flow (`taskmasterFlow`), and updates job status.
- **Genkit Agent (Gemini 3.5 Flash)**: Executes autonomous reasoning loops with tools for policy search (`searchPolicies`), employee record lookup (`getEmployeeRecord`), and compliance validation. Pauses for human approval when labor violations occur.
- **MeiliSearch**: Fast full‑text search over corporate policy documents and audit logs.
- **Human Console**: Interactive UI and API endpoint `/jobs/:jobId/resume` to approve or reject overtime violations (Human-in-the-Loop).

### XML Component Diagram

```xml
<?xml version="1.0" encoding="UTF-8"?>
<architecture sdk="Genkit ADK Agentic Loops v2.5">
  <component name="Client" type="external">
    <connection to="Dispatcher" protocol="HTTP POST /jobs"/>
  </component>
  
  <component name="Dispatcher" type="express-route">
    <connection to="Firestore" type="write" label="create job (status=queued)"/>
    <connection to="PubSub" type="publish" label="jobId, tenantId"/>
  </component>
  
  <component name="PubSub" type="message-queue">
    <connection to="Cloud Run Worker" type="push" label="HTTP POST /tasks/run"/>
  </component>
  
  <component name="Cloud Run Worker" type="express-route">
    <connection to="Genkit Agent" type="invoke" label="taskmasterFlow (Gemini 3.5 Flash)"/>
    <connection to="Firestore" type="update" label="status=running / needs_review / completed"/>
  </component>
  
  <component name="Genkit Agent" type="ai-flow">
    <connection to="MeiliSearch" type="tool-call" label="searchPolicies"/>
    <connection to="Firestore" type="tool-call" label="getEmployeeRecord"/>
    <connection to="Human Console" type="interrupt" label="resolveOvertime (HITL)"/>
  </component>

  <component name="EventDrivenEngine" type="EventEmitter">
    <connection to="MeiliSearch" type="audit-index" label="indexValidatedTask"/>
  </component>
  
  <component name="MeiliSearch" type="search-engine">
    <connection to="Firestore" type="read" label="policy index &amp; audit history"/>
  </component>
  
  <component name="Human Console" type="ui-or-api">
    <connection to="Cloud Run Worker" type="HTTP POST" label="/jobs/:jobId/resume"/>
  </component>
</architecture>
