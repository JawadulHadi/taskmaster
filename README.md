<p align="center">
  <img src="/public/repo-banner.svg" alt="Taskmaster Agentic Engine Banner" width="100%" />
</p>

# Taskmaster

[![Genkit](https://img.shields.io/badge/Powered_by-Genkit-orange?style=flat-square&logo=firebase)](https://firebase.google.com/docs/genkit)
[![Gemini 3.6 Flash](https://img.shields.io/badge/Model-Gemini_3.6_Flash-blue?style=flat-square&logo=google)](https://ai.google.dev)
[![Hackathon Track](https://img.shields.io/badge/Hackathon_Track-Taskmaster-purple?style=flat-square)](https://devpost.com)
[![Architecture](https://img.shields.io/badge/Architecture-Event_Driven_Pub/Sub-emerald?style=flat-square)](/docs/ARCHITECTURE.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

- **All Things Agentic Hackathon Submission — Track: Taskmaster**

An enterprise-grade, event-driven HR operations agent and autonomous loop engine built with **Google Genkit**, calling the Gemini API directly. The agent runs asynchronously across Cloud Run and Pub/Sub, handles heavy-duty HR compliance auditing over massive datasets via **Meilisearch** and **Cloud Firestore**, parses unstructured shift logs using **Gemini 3.6 Flash**, and enforces safe guardrails with **Human-in-the-Loop (HITL) interrupts**.

---

## Architecture & Devpost Submission Guide

- **4-Stage Pipeline**: *Dispatch (Pub/Sub)* $\rightarrow$ *Genkit AI Loop (Gemini 3.6 Flash)* $\rightarrow$ *HITL Interrupt (Manager Review)* $\rightarrow$ *Meilisearch Audit Indexing*. Include `/public/repo-banner.svg` or XML diagrams from [`/docs/ARCHITECTURE.md`](/docs/ARCHITECTURE.md) in your Devpost image gallery.
- **Human-in-the-Loop (HITL) Differentiator**: Taskmaster avoids "black box" failure by detecting labor violations (e.g., overtime > 10 hours), safely pausing execution, preserving conversation state, and awaiting supervisor verification (`approved` / `rejected`) before finalizing payroll.

---

## How to Add Employee Records

Employee records can be added and managed in three ways:

1. **Out-of-the-Box Demo Records**: Pre-configured defaults (`emp_001` Alice Chen, `emp_002` John Smith, `emp_003` Maria Garcia) are automatically loaded in memory and Firestore.
2. **Database Seeding (`npm run seed`)**: Run `npm run seed` to populate corporate policies and employee timesheet records into Cloud Firestore and Meilisearch.
3. **API Insertion (`POST /employees` or Firestore)**: Directly upsert employee records with base rates, regular hours, and overtime hours:

   ```json
   {
     "id": "emp_004",
     "name": "Sarah Connor",
     "department": "Security",
     "baseRate": 45.0,
     "regularHours": 160.0,
     "overtimeHours": 12.5,
     "overtimeApproved": false
   }
   ```

---

## Key Features

- **Autonomous Agentic Loops (`Genkit` + `Gemini 3.6 Flash`)** – The AI model dynamically reasons over commands, evaluates tools (`search_policies`, `get_employee_record`, `resolve_overtime`), and iterates up to `maxTurns: 6`.
- **Event-Driven Pub/Sub & Cloud Run Architecture** – Asynchronous job dispatching ensures clients never block. Pub/Sub pushes event payloads to Cloud Run workers for horizontal scalability.
- **Restartable HITL Interrupts** – When overtime thresholds are exceeded, Genkit pauses execution, preserves conversation history, and triggers supervisor review dashboards.
- **Real-Time Control Center UI** – Live web console built with Tailwind CSS displaying active job queues, employee timesheet databases, policy rulebooks, and interactive approval flows.

---

## 🛠️ Quick Start & Local Development

1. **Install Dependencies**

   ```bash
   npm install
   ```

2. **Configure Environment Variables**
   Run `npm run generate-secrets` to automatically generate API keys and bootstrap `.env`.
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

## API Endpoints

- **`POST /jobs`** – Submit an asynchronous HR directive.
- **`GET /jobs`** – List all jobs and execution states.
- **`GET /jobs/:jobId`** – Get single job details and audit trail.
- **`POST /jobs/:jobId/resume`** – Resume a paused HITL job with a manager decision (`approved` / `rejected`).
- **`POST /tasks/run`** – Pub/Sub push webhook endpoint triggering the Cloud Run worker.

---


### Contributing

Built by [Jawad Ul Hadi](https://github.com/JawadulHadi) — Backend Lead / AI Systems Architect.

<div align="center">

**Let's build something resilient together.**

[![Portfolio](https://img.shields.io/badge/Portfolio-0A0A0A?style=flat-square&logo=vercel&logoColor=white)](https://juhbukhari.vercel.app)
[![Résumé](https://img.shields.io/badge/Résumé-4B5563?style=flat-square&logo=data:image/svg%2bxml;base64,PHN2ZyBmaWxsPSIjZmZmIiByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMjMuNjMgMTUuM2MtLjcxLS43NDUtMi4xNjYtMS4xNy00LjIyNC0xLjE3LTEuMSAwLTIuMzc3LjEwNi0zLjc2MS4zNTRhMTkuNDQzIDE5LjQ0MyAwIDAgMS0yLjMwNy0yLjY2MWMtLjUzMi0uNzEtLjk5NC0xLjQ5LTEuNDItMi4yMzYuODE3LTIuNDg0IDEuMjA3LTQuNTA3IDEuMjA3LTUuOTYyIDAtMS42MzItLjYwMy0zLjMzNi0yLjM0Mi0zLjMzNi0uNTMyIDAtMS4wNjUuMzItMS4zNDkuNzgxLS43OCAxLjM4NC0uNDI1IDQuNC45MjMgNy4zODFhNjAuMjc3IDYwLjI3NyAwIDAgMS0xLjcwMyA0LjUwN2MtLjU2OCAxLjM0OS0xLjIwNyAyLjczMy0xLjkxNyA0LjAxQzIuODM0IDE4LjUzLjMxNCAyMC4zNC4wMyAyMS43NThjLS4xMDYuNTMzLjA3MSAxLjAzLjQ2MiAxLjQyLjE0Mi4xMDcuNjM5LjUzMyAxLjQ5LjUzMyAyLjU5IDAgNS4zMjMtNC4xODggNi43MDctNi43MDcgMS4wNjUtLjM1NSAyLjEzLS43MSAzLjE5NC0uOTk0YTM0Ljk2MyAzNC45NjMgMCAwIDEgMy40MDctLjc0NWMyLjczMiAyLjQ0OCA1LjE0NSAyLjgzOSA2LjM1MiAyLjgzOSAxLjQ5IDAgMi4wMjMtLjYwNCAyLjItMS4xLjMyLS42NC4xMDYtMS4zNDktLjIxMy0xLjcwNHptLTEuNDIgMS4wM2MtLjEwNy41MzItLjY0Ljg4Ny0xLjM4NC44ODctLjIxMyAwLS4zOS0uMDM2LS42MDQtLjA3MS0xLjM0OC0uMzItMi42MjYtLjk5NC0zLjkwMy0yLjA1OWExNy43MTcgMTcuNzE3IDAgMCAxIDIuOTgtLjI0OGMuNzQ2IDAgMS4zODUuMDM1IDEuODEuMTQyLjQ5Ny4xMDYgMS4yNzguNDI2IDEuMSAxLjM0OHptLTcuNTI0LTEuNjY4YTM4LjAxIDM4LjAxIDAgMCAwLTIuOTQ1LjY3NCAzOS42OCAzOS42OCAwIDAgMC0yLjUyLjc0NSA0MC4wNSA0MC4wNSAwIDAgMCAxLjIwNy0yLjU1NWMuNDI2LS45OTQuNzgtMi4wMjMgMS4xMzYtMi45ODEuMzU0LjYwMy43NDUgMS4yMDcgMS4xMzUgMS43MzlhNTAuMTI3IDUwLjEyNyAwIDAgMCAxLjk4NyAyLjM3OHpNMTAuMDM4IDEuNDZhLjc2OC43NjggMCAwIDEgLjY3NC0uNDI1Yy43NDUgMCAuODg3Ljg1MS44ODcgMS41MjYgMCAxLjEzNS0uMzU1IDIuODc0LS45NTggNC44NjEtMS4wMy0yLjc2OC0xLjEtNS4wNzQtLjYwMy01Ljk2MnpNNi4xMzQgMTcuOTk3Yy0xLjgxIDIuOTgxLTMuNTQ5IDQuODI2LTQuNjEzIDQuODI2YS44NzIuODcyIDAgMCAxLS41MzItLjE3N2MtLjIxMy0uMjEzLS4zMi0uNDYxLS4yNDktLjc0NS4yMTMtMS4wNjUgMi4yNzEtMi41NTUgNS4zOTQtMy45MDRaIi8%2BPC9zdmc%2B)](https://juhbukhari.vercel.app/resume.pdf)
[![Case Study](https://img.shields.io/badge/Case_Study-7C3AED?style=flat-square&logo=readthedocs&logoColor=white)](https://juhbukhari.vercel.app/case-study)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0A66C2?style=flat-square&logo=data:image/svg%2bxml;base64,PHN2ZyBmaWxsPSIjZmZmIiByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMjAuNDQ3IDIwLjQ1MmgtMy41NTR2LTUuNTY5YzAtMS4zMjgtLjAyNy0zLjAzNy0xLjg1Mi0zLjAzNy0xLjg1MyAwLTIuMTM2IDEuNDQ1LTIuMTM2IDIuOTM5djUuNjY3SDkuMzUxVjloMy40MTR2MS41NjFoLjA0NmMuNDc3LS45IDEuNjM3LTEuODUgMy4zNy0xLjg1IDMuNjAxIDAgNC4yNjcgMi4zNyA0LjI2NyA1LjQ1NXY2LjI4NnpNNS4zMzcgNy40MzNjLTEuMTQ0IDAtMi4wNjMtLjkyNi0yLjA2My0yLjA2NSAwLTEuMTM4LjkyLTIuMDYzIDIuMDYzLTIuMDYzIDEuMTQgMCAyLjA2NC45MjUgMi4wNjQgMi4wNjMgMCAxLjEzOS0uOTI1IDIuMDY1LTIuMDY0IDIuMDY1em0xLjc4MiAxMy4wMTlIMy41NTVWOWgzLjU2NHYxMS40NTJ6TTIyLjIyNSAwSDEuNzcxQy43OTIgMCAwIC43NzQgMCAxLjcyOXYyMC41NDJDMCAyMy4yMjcuNzkyIDI0IDEuNzcxIDI0aDIwLjQ1MUMyMy4yIDI0IDI0IDIzLjIyNyAyNCAyMi4yNzFWMS43MjlDMjQgLjc3NCAyMy4yIDAgMjIuMjIyIDBoLjAwM3oiLz48L3N2Zz4%3D)](https://linkedin.com/in/jawad-ul-hadi)
[![GitLab](https://img.shields.io/badge/GitLab-FC6D26?style=flat-square&logo=gitlab&logoColor=white)](https://gitlab.com/JawadulHadi)
[![Stack Overflow](https://img.shields.io/badge/Stack_Overflow-F58025?style=flat-square&logo=stackoverflow&logoColor=white)](https://stackoverflow.com/users/19086162/jawad-ul-hadi)
[![ORCID](https://img.shields.io/badge/ORCID-A6CE39?style=flat-square&logo=orcid&logoColor=white)](https://orcid.org/0009-0007-1317-4615)
[![Book a call](https://img.shields.io/badge/Book_a_call-006BFF?style=flat-square&logo=calendly&logoColor=white)](https://calendly.com/jawadulhadicc)
[![Email](https://img.shields.io/badge/Email-EA4335?style=flat-square&logo=gmail&logoColor=white)](mailto:jawadulhadicc@gmail.com?subject=Hello%20Jawad&body=Hi%20Jawad%2C%0A%0AI%20came%20across%20your%20profile.)

</div>
