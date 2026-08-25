# Architecture

## High‑Level Overview

The Taskmaster Agent is a fully asynchronous, event‑driven system built on Google Cloud.

### Components

- **Client**: Any HTTP client that submits a command via `POST /jobs`.
- **Dispatcher**: Express route that writes the job to Firestore and publishes a message to Pub/Sub.
- **Firestore**: Stores job state, employee records, and policy data (via MeiliSearch).
- **Pub/Sub**: Decouples job submission from processing. Push subscription triggers the Cloud Run worker.
- **Worker (Cloud Run)**: Express route `/tasks/run` that receives the Pub/Sub message, invokes the Genkit agent, and updates job status.
- **Genkit Agent**: Runs an AI loop with tools for policy search, employee lookup, and overtime resolution. Can pause for human approval.
- **MeiliSearch**: Fast full‑text search over policy documents.
- **Human Console**: Simple UI or API call to `/jobs/:jobId/resume` to approve/reject overtime.

### XML Component Diagram

```xml
<?xml version="1.0" encoding="UTF-8"?>
<architecture>
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
    <connection to="Genkit Agent" type="invoke" label="taskmasterFlow"/>
    <connection to="Firestore" type="update" label="status=running / needs_review / completed"/>
  </component>
  
  <component name="Genkit Agent" type="ai-flow">
    <connection to="MeiliSearch" type="tool-call" label="searchPolicies"/>
    <connection to="Firestore" type="tool-call" label="getEmployeeRecord"/>
    <connection to="Human Console" type="interrupt" label="resolveOvertime (HITL)"/>
  </component>
  
  <component name="MeiliSearch" type="search-engine">
    <connection to="Firestore" type="read" label="policy index"/>
  </component>
  
  <component name="Human Console" type="ui-or-api">
    <connection to="Cloud Run Worker" type="HTTP POST" label="/jobs/:jobId/resume"/>
  </component>
</architecture>