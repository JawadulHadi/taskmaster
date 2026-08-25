# Taskmaster Agent

An event-driven HR operations agent built for the **All Things Agentic Hackathon** (Taskmaster track). The agent runs in the background, processes large datasets via MeiliSearch, and automates complex HR workflows asynchronously—pausing for human approval when needed.

## Features

- **Asynchronous background processing** – jobs are queued in Firestore and processed by a Pub/Sub‑triggered Cloud Run worker.
- **Agentic decision‑making** – the Genkit‑powered agent decides which tools to call (search policies, fetch employee records, resolve overtime) in any order.
- **Human‑in‑the‑loop** – overtime violations trigger an interrupt, pausing the agent until a human approves or rejects the action.
- **Real integrations** – MeiliSearch for fast full‑text search, Firestore for state, Pub/Sub for messaging, Gemini for reasoning.

## Tech Stack

- [Genkit](https://firebase.google.com/docs/genkit) with Google AI (Gemini)
- Google Cloud Firestore, Pub/Sub, Cloud Run
- MeiliSearch
- TypeScript, Express

## Project Structure

```markdown
taskmaster-agent/
├── src/
│   ├── ai/
│   │   ├── genkit.ts                 # Genkit instance + Gemini model
│   │   ├── flows/taskmasterFlow.ts   # Agent loop
│   │   └── tools/
│   │       ├── searchPolicies.ts
│   │       ├── getEmployeeRecord.ts
│   │       └── resolveOvertime.ts    # HITL interrupt
│   ├── lib/
│   │   ├── firestore.ts
│   │   ├── pubsub.ts
│   │   └── meili.ts
│   └── server.ts                     # Express + dispatcher + worker + resume
├── scripts/seed.ts                   # Seed demo data
├── Dockerfile
├── package.json
└── tsconfig.json
```

## Prerequisites

- Node.js 20+
- A Google Cloud project with Firestore and Pub/Sub enabled
- A MeiliSearch instance (local or cloud)
- Gemini API key (from Google AI Studio)
- (Optional) Google Cloud CLI for deployment

## Local Setup

1. **Clone and install**

   ```bash
   npm install
   ```
2. **Set environment variables**Copy `.env.example` to `.env` and fill in the values.
3. **Start MeiliSearch**If using Docker:

   ```bash
   docker run -p 7700:7700 getmeili/meilisearch:v1.6
   ```
4. **Run Firestore emulator** (optional, but recommended for local dev)

   ```bash
   gcloud emulators firestore start --host-port=localhost:8080
   ```

   Then set `FIRESTORE_EMULATOR_HOST=localhost:8080` in your `.env`.
5. **Seed demo data**

   ```bash
   npm run seed
   ```
6. **Start the server**

   ```bash
   npm run dev
   ```

## Usage

### Submit a job

```bash
curl -X POST http://localhost:8080/jobs \
  -H "Content-Type: application/json" \
  -d '{"command": "Check overtime for employee emp_002"}'
```

Response: `202` with `jobId` and `status: "queued"`.

### Simulate Pub/Sub push (local)

If you don’t have Pub/Sub emulator, you can manually trigger the worker endpoint:

```bash
curl -X POST http://localhost:8080/tasks/run \
  -H "Content-Type: application/json" \
  -d '{"message":{"data":"<base64 of {\"jobId\":\"...\",\"tenantId\":\"tenant_01\"}>"}}'
```

### Resume a paused job (HITL)

When the agent hits an overtime violation, it pauses. To approve or reject:

```bash
curl -X POST http://localhost:8080/jobs/<jobId>/resume \
  -H "Content-Type: application/json" \
  -d '{"decision": "approved"}'
```

## Deployment to Cloud Run

1. **Build and push the Docker image**

   ```bash
   gcloud builds submit --tag gcr.io/<project-id>/taskmaster-agent
   ```
2. **Deploy to Cloud Run**

   ```bash
   gcloud run deploy taskmaster-agent \
     --image gcr.io/<project-id>/taskmaster-agent \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --set-env-vars "GEMINI_API_KEY=...,GOOGLE_CLOUD_PROJECT=...,MEILI_URL=...,MEILI_API_KEY=..."
   ```
3. **Create a Pub/Sub topic and push subscription**

   ```bash
   gcloud pubsub topics create taskmaster-jobs
   gcloud pubsub subscriptions create taskmaster-jobs-sub \
     --topic taskmaster-jobs \
     --push-endpoint=https://<cloud-run-url>/tasks/run \
     --push-auth-service-account=<service-account-email>
   ```
4. **Update the dispatcher** to publish to the actual Pub/Sub topic (set `PUBSUB_TOPIC` env var).

## License

MIT
