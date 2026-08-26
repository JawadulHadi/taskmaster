<p align="center">
  <img src="/public/repo-banner.svg" alt="Taskmaster Agentic Engine Banner" width="100%" />
</p>

# Taskmaster Agent — Genkit & ADK Agentic Loops SDK™

[![Genkit](https://img.shields.io/badge/Powered_by-Genkit-orange?style=flat-square&logo=firebase)](https://firebase.google.com/docs/genkit)
[![Gemini 3.5 Flash](https://img.shields.io/badge/Model-Gemini_3.5_Flash-blue?style=flat-square&logo=google)](https://ai.google.dev)
[![Architecture](https://img.shields.io/badge/Architecture-Event_Driven_Pub/Sub-purple?style=flat-square)](/docs/ARCHITECTURE.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

An enterprise-grade, event-driven HR operations agent and autonomous loop engine built with the **Genkit & ADK Agentic Loops SDK™**. The agent runs asynchronously across Cloud Run and Pub/Sub, processes unstructured timesheet logs via **Gemini 3.5 Flash**, queries corporate policies in **Meilisearch**, validates compliance against **Firestore** employee records, and pauses for **Human-in-the-Loop (HITL)** approvals when labor violations occur.

---

## 🎨 Branding & Assets

- **Official Logo**: `/public/logo.svg`
- **Repository Banner**: `/public/repo-banner.svg`
- **SDK Documentation**: [`/docs/AGENT_SDK.md`](/docs/AGENT_SDK.md)
- **Architecture Spec**: [`/docs/ARCHITECTURE.md`](/docs/ARCHITECTURE.md)
- **End-to-End Flow**: [`/docs/flow_description.md`](/docs/flow_description.md)

---

## 🚀 Key Features

- **Autonomous Agentic Loops (`Genkit` + `Gemini 3.5 Flash`)** – The AI model dynamically reasons over commands, evaluates tools (`search_policies`, `get_employee_record`, `resolve_overtime`), and iterates up to `maxTurns: 6`.
- **Event-Driven Pub/Sub & Cloud Run Architecture** – Asynchronous job dispatching ensures clients never block. Pub/Sub pushes event payloads to Cloud Run workers for horizontal scalability.
- **Restartable HITL Interrupts** – When overtime thresholds (e.g., > 10 hours) are exceeded, Genkit pauses execution, preserves conversation history, and triggers supervisor review dashboards.
- **Real-Time Control Center UI** – Live web console built with Tailwind CSS displaying active job queues, employee timesheet databases, policy rulebooks, and interactive approval flows.

---

## 📂 Project Structure

```markdown
taskmaster-agent/
├── public/
│   ├── logo.svg                      # Unique Genkit ADK Logo
│   └── repo-banner.svg               # Repository Banner
├── src/
│   ├── ai/
│   │   ├── genkit.ts                 # Genkit instance + Gemini 3.5 Flash model
│   │   ├── flows/taskmasterFlow.ts   # Agentic reasoning loop
│   │   └── tools/
│   │       ├── searchPolicies.ts     # Meilisearch policy query tool
│   │       ├── getEmployeeRecord.ts  # Firestore employee lookup tool
│   │       └── resolveOvertime.ts    # HITL interrupt resolution tool
│   ├── lib/
│   │   ├── firestore.ts              # Firestore database client
│   │   ├── pubsub.ts                 # Pub/Sub message broker & local fallback
│   │   └── meili.ts                  # Meilisearch integration
│   ├── services/
│   │   └── gemini.ts                 # Gemini 3.5 Flash unstructured timesheet parser
│   ├── utils/
│   │   └── validator.ts              # HR policy compliance engine
│   ├── index.ts                      # Event-driven workflow engine (EventEmitter)
│   └── server.ts                     # Express server, dispatcher, worker & UI
├── docs/
│   ├── AGENT_SDK.md                  # Genkit ADK SDK documentation
│   ├── ARCHITECTURE.md               # System component diagrams
│   └── flow_description.md           # End-to-end execution flow
├── package.json
└── tsconfig.json
```

---

## 🛠️ Quick Start & Local Development

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment Variables**
   Copy `.env.example` to `.env` and set your `GEMINI_API_KEY` and Google Cloud settings.

3. **Seed Demo Data & Policies**
   ```bash
   npm run seed
   ```

4. **Start the Development Server**
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000` to access the interactive **HR Ops Control Center**.

---

## 📡 API Endpoints

- **`POST /jobs`** – Submit an asynchronous HR directive.
- **`GET /jobs`** – List all jobs and execution states.
- **`GET /jobs/:jobId`** – Get single job details and audit trail.
- **`POST /jobs/:jobId/resume`** – Resume a paused HITL job with a manager decision (`approved` / `rejected`).
- **`POST /tasks/run`** – Pub/Sub push webhook endpoint triggering the Cloud Run worker.

---

## 📄 License

MIT
