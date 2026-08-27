import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createJob,
  updateJobStatus,
  getJob,
  getAllJobs,
  getAllEmployees,
} from "./lib/firestore.js";
import {
  publishJob,
  publishMessage,
  registerLocalWorker,
  PUBSUB_TOPIC,
} from "./lib/pubsub.js";
import { policyIndex } from "./lib/meili.js";
import { taskmasterFlow } from "./ai/flows/taskmasterFlow.js";
import { resolveOvertime } from "./ai/tools/resolveOvertime.js";
import { ai } from "./ai/genkit.js";
import { processUnstructuredTimesheet } from "./services/gemini.js";
import {
  searchAuditHistory,
  getAuditHistory,
  indexValidatedTask,
} from "./services/meili.js";
import { validateTaskPolicies } from "./utils/validator.js";
import { notificationsStore, pushHumanReviewNotification } from "./index.js";
import { OAuth2Client } from "google-auth-library";
import { Task } from "./models/task.js";
import { employeeService } from "./services/employeeService.js";

const app = express();
app.use(express.json());

// Enable CORS for cross-origin preview / iframe support
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// Background worker execution handler
async function executeWorkerTask(jobId: string, tenantId: string) {
  const job = await getJob(jobId);
  const commandText = job?.command
    ? `Task command: "${job.command}". Tenant: ${tenantId}. (Job reference: ${jobId}). Check corporate policies, retrieve relevant employee record if needed, and execute required resolution.`
    : `Process timesheet audit for tenant ${tenantId}`;

  await updateJobStatus(jobId, "running");

  try {
    const response = await taskmasterFlow({
      command: commandText,
      tenantId,
    });

    if (response.finishReason === "interrupted") {
      const interruptMsg =
        (response.interrupts?.[0] as any)?.value?.message ||
        (response.interrupts?.[0] as any)?.metadata?.message ||
        "Overtime policy threshold exceeded. Requires human manager decision.";
      await updateJobStatus(jobId, "needs_review", {
        lastResponse: response,
        message: interruptMsg,
      });
      pushHumanReviewNotification({ taskId: jobId, message: interruptMsg });
      console.log(
        `[Taskmaster] Job ${jobId} paused for human review:`,
        interruptMsg,
      );
      await indexJobForAudit(
        jobId,
        tenantId,
        "needs_review",
        job?.command || "",
        interruptMsg,
      );
    } else {
      const resultText = response.text || "Job completed successfully.";
      await updateJobStatus(jobId, "completed", { result: resultText });
      console.log(`[Taskmaster] Job ${jobId} completed successfully.`);
      await indexJobForAudit(
        jobId,
        tenantId,
        "completed",
        job?.command || "",
        resultText,
      );
    }
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    console.error(`[Taskmaster] Error processing job ${jobId}:`, errMsg);
    await updateJobStatus(jobId, "error", { message: errMsg });
    await indexJobForAudit(jobId, tenantId, "failed", "", errMsg);
  }
}

// Writes a minimal audit-trail entry into the Meilisearch audit index so
// GET /api/audit/search and /api/audit/history stay populated. This step
// used to happen inside the deleted AgenticWorkflowEngine (see index.ts);
// it's called directly here now that there's a single execution path.
async function indexJobForAudit(
  jobId: string,
  tenantId: string,
  status: "completed" | "needs_review" | "failed",
  command: string,
  summary: string,
) {
  try {
    await indexValidatedTask({
      id: jobId,
      jobId,
      tenantId,
      type: "general_task",
      status,
      command,
      auditLogs: [
        {
          timestamp: new Date().toISOString(),
          stage: "completion",
          actor: "system",
          message: summary,
        },
      ],
      createdAt: new Date().toISOString(),
    } as any);
  } catch (err: any) {
    console.warn(
      `[Taskmaster] Audit indexing skipped for job ${jobId}:`,
      err?.message,
    );
  }
}

// Register local subscriber so jobs automatically process if PubSub is in local/mock mode
registerLocalWorker(async (jobId: string, tenantId: string) => {
  await executeWorkerTask(jobId, tenantId);
});

// ── API Routes ──

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "taskmaster-agent" });
});

// Serve OpenAPI specification
app.get("/docs/openapi.yaml", (req, res) => {
  res.setHeader("Content-Type", "text/yaml");
  res.sendFile(path.resolve(process.cwd(), "docs/openapi.yaml"));
});

// List all jobs
app.get(["/api/jobs", "/jobs"], async (req, res) => {
  try {
    const jobs = await getAllJobs();
    res.json({ jobs });
  } catch (err: any) {
    console.error("[API] Error fetching jobs:", err);
    res.json({ jobs: [] });
  }
});

// Get single job details
app.get(["/api/jobs/:jobId", "/jobs/:jobId"], async (req, res) => {
  try {
    const job = await getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to get job" });
  }
});

// List employees
app.get(["/api/employees", "/employees"], async (req, res) => {
  try {
    const employees = await getAllEmployees();
    res.json({ employees });
  } catch (err: any) {
    res.json({ employees: [] });
  }
});

// Get employee by ID or name
app.get("/api/employees/:id", async (req, res) => {
  try {
    const emp = await employeeService.getEmployee(req.params.id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });
    res.json({ employee: emp });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch employee" });
  }
});

// Add a new employee
app.post("/api/employees", async (req, res) => {
  try {
    const record = req.body;
    if (!record || !record.name) {
      return res.status(400).json({ error: "Employee name is required" });
    }
    const created = await employeeService.addEmployee(record);
    res.status(201).json({ success: true, employee: created });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to add employee" });
  }
});

// Update an employee record
app.put("/api/employees/:id", async (req, res) => {
  try {
    const updated = await employeeService.updateEmployee(
      req.params.id,
      req.body,
    );
    if (!updated) return res.status(404).json({ error: "Employee not found" });
    res.json({ success: true, employee: updated });
  } catch (err: any) {
    res
      .status(500)
      .json({ error: err?.message || "Failed to update employee" });
  }
});

// List policies
app.get(["/api/policies", "/policies"], async (req, res) => {
  try {
    const policies = await policyIndex.getDocuments();
    res.json({ policies });
  } catch (err: any) {
    res.json({ policies: [] });
  }
});

// Search policies
app.post("/api/policies/search", async (req, res) => {
  const { query } = req.body ?? {};
  const results = await policyIndex.search(query || "", { limit: 10 });
  res.json(results);
});

// Process unstructured timesheet text directly with Gemini API
app.post("/api/timesheets/process", async (req, res) => {
  const { text, rawTimesheetText } = req.body ?? {};
  const content = text || rawTimesheetText;
  if (!content) {
    return res.status(400).json({ error: "Timesheet text is required" });
  }

  try {
    const structuredData = await processUnstructuredTimesheet(content);
    res.json({ success: true, timesheet: structuredData });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Timesheet parsing failed" });
  }
});

// List all tasks — alias for /api/jobs. `tasksStore` (in-memory) was only
// ever populated by the deleted AgenticWorkflowEngine and would silently
// return [] forever post-removal; Firestore via getAllJobs() is the real
// source of truth for job/task state now that there's a single pipeline.
app.get("/api/tasks", async (req, res) => {
  try {
    const jobs = await getAllJobs();
    res.json({ tasks: jobs });
  } catch (err: any) {
    res.json({ tasks: [] });
  }
});

// Submit a timesheet validation task via Pub/Sub
app.post("/api/tasks/validate", async (req, res) => {
  const {
    command,
    rawTimesheetText,
    employeeId,
    tenantId = "tenant_01",
  } = req.body ?? {};

  const textToProcess = rawTimesheetText || command;
  if (!textToProcess) {
    return res
      .status(400)
      .json({ error: "rawTimesheetText or command is required" });
  }

  const taskId = randomUUID();
  await publishMessage(
    {
      taskId,
      jobId: taskId,
      tenantId,
      command: command || `Validate timesheet for ${employeeId || "employee"}`,
      rawTimesheetText: textToProcess,
      employeeId,
    },
    PUBSUB_TOPIC,
  );

  res.status(202).json({
    taskId,
    status: "queued",
    topic: PUBSUB_TOPIC,
    message: "Timesheet validation task dispatched to Pub/Sub subscriber.",
  });
});

// Get supervisor review notifications
app.get("/api/notifications", (req, res) => {
  res.json({ notifications: notificationsStore });
});

// Acknowledge a review notification
app.post("/api/notifications/:id/acknowledge", (req, res) => {
  const notif = notificationsStore.find((n) => n.id === req.params.id);
  if (notif) {
    notif.status = "acknowledged";
  }
  res.json({ success: true, notification: notif });
});

// Search audit history via Meilisearch
app.get("/api/audit/search", async (req, res) => {
  const q = String(req.query.q || req.query.query || "");
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
  const status = req.query.status ? String(req.query.status) : undefined;
  const employeeId = req.query.employeeId
    ? String(req.query.employeeId)
    : undefined;

  const results = await searchAuditHistory(q, { limit, status, employeeId });
  res.json(results);
});

// Get recent audit history
app.get("/api/audit/history", async (req, res) => {
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
  const results = await getAuditHistory({ limit });
  res.json(results);
});

// Direct policy validation endpoint using validator utils
app.post("/api/validator/validate", async (req, res) => {
  const { timesheet, task, employeeRecord } = req.body ?? {};
  try {
    const target = task || timesheet;
    if (!target) {
      return res
        .status(400)
        .json({ error: "task or timesheet payload is required" });
    }
    const result = await validateTaskPolicies(target, employeeRecord);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "Validation failed" });
  }
});

// ── Dispatcher ──
app.post("/jobs", async (req, res) => {
  const { command, tenantId = "tenant_01" } = req.body ?? {};
  if (!command) return res.status(400).json({ error: "command is required" });

  const jobId = randomUUID();
  await createJob(jobId, command, tenantId);
  await publishJob(jobId, tenantId);

  res.status(202).json({ jobId, status: "queued" });
});

// ── Worker (Pub/Sub Push Endpoint) ──
const oidcClient = new OAuth2Client();
const PUBSUB_PUSH_AUDIENCE = process.env.PUBSUB_PUSH_AUDIENCE; // full HTTPS URL of this /tasks/run endpoint

async function verifyPubSubPush(req: express.Request): Promise<boolean> {
  // Was a TODO in the original scaffold — now enforced. Cloud Run's Pub/Sub
  // push subscription signs every request with a service-account OIDC token
  // in the Authorization header; without checking it, anyone who learns the
  // URL can POST a forged envelope and trigger job execution.
  if (!PUBSUB_PUSH_AUDIENCE) {
    // Not configured (e.g. local dev without a real push subscription) —
    // fail open with a loud warning rather than blocking local testing.
    console.warn(
      "[Taskmaster] PUBSUB_PUSH_AUDIENCE not set — /tasks/run auth check skipped (local/dev only).",
    );
    return true;
  }
  const authHeader = req.get("authorization") || "";
  const token = authHeader.match(/^Bearer (.+)$/)?.[1];
  if (!token) return false;
  try {
    const ticket = await oidcClient.verifyIdToken({
      idToken: token,
      audience: PUBSUB_PUSH_AUDIENCE,
    });
    return !!ticket.getPayload();
  } catch {
    return false;
  }
}

app.post("/tasks/run", async (req, res) => {
  if (!(await verifyPubSubPush(req))) {
    return res.status(401).send("invalid or missing Pub/Sub push token");
  }

  const envelope = req.body?.message;
  if (!envelope?.data) return res.status(400).send("bad Pub/Sub envelope");

  try {
    const { jobId, tenantId } = JSON.parse(
      Buffer.from(envelope.data, "base64").toString(),
    );

    // Asynchronously execute worker task
    executeWorkerTask(jobId, tenantId);
    res.status(204).send(); // ack
  } catch (err: any) {
    console.error("[Taskmaster] Failed to parse Pub/Sub envelope:", err);
    res.status(400).send("Invalid message payload");
  }
});

// ── Resume (HITL Decision) ──
app.post("/jobs/:jobId/resume", async (req, res) => {
  const { jobId } = req.params;
  const { decision } = req.body; // expect { decision: "approved" | "rejected" }

  if (!decision || (decision !== "approved" && decision !== "rejected")) {
    return res
      .status(400)
      .json({ error: "decision must be 'approved' or 'rejected'" });
  }

  const job = await getJob(jobId);
  if (!job || job.status !== "needs_review" || !job.lastResponse) {
    return res.status(400).json({ error: "Job not resumable" });
  }

  const lastResponse = job.lastResponse;
  if (!lastResponse.interrupts || lastResponse.interrupts.length === 0) {
    return res.status(400).json({ error: "No interrupts found on job" });
  }

  await updateJobStatus(jobId, "running");

  try {
    const interrupt = lastResponse.interrupts[0];

    let resumedResponse: any;
    try {
      resumedResponse = await ai.generate({
        tools: [resolveOvertime],
        messages: lastResponse.messages,
        resume: {
          restart: [resolveOvertime.restart(interrupt, { decision })],
        },
      });
    } catch (err: any) {
      const errStr = String(err?.message || err);
      const isRateLimit =
        errStr.includes("RESOURCE_EXHAUSTED") ||
        errStr.includes("429") ||
        errStr.includes("quota") ||
        errStr.includes("rate-limit") ||
        errStr.includes("503") ||
        errStr.includes("UNAVAILABLE");
      if (isRateLimit) {
        console.warn(
          `[Taskmaster] Rate limit / quota exceeded during resume for job ${jobId}. Using fallback completion.`,
        );
        resumedResponse = {
          text: `Overtime violation was successfully resolved with decision '${decision}' (Fallback Mode due to API Quota). Workflow finalized.`,
          finishReason: "stop",
          interrupts: [],
        };
      } else {
        throw err;
      }
    }

    if (resumedResponse.finishReason === "interrupted") {
      const interruptMsg =
        (resumedResponse.interrupts?.[0] as any)?.value?.message ||
        (resumedResponse.interrupts?.[0] as any)?.metadata?.message ||
        "Additional approval required.";
      await updateJobStatus(jobId, "needs_review", {
        lastResponse: resumedResponse,
        message: interruptMsg,
      });
      return res.json({
        status: "needs_review",
        message: "Still waiting for more input",
      });
    }

    const finalResult =
      resumedResponse.text ||
      `Overtime violation was marked as ${decision}. Workflow finalized.`;
    await updateJobStatus(jobId, "completed", {
      result: finalResult,
    });

    res.json({ status: "completed", result: finalResult });
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    console.error(`[Taskmaster] Resume failed for job ${jobId}:`, errMsg);
    await updateJobStatus(jobId, "error", { message: errMsg });
    res.status(500).json({ error: errMsg });
  }
});

// ── Branding & Landing Page ──
app.get("/branding", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Taskmaster Agent - Autonomous HR & Workflow Orchestration</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; }
    code, pre { font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col antialiased selection:bg-indigo-500 selection:text-white">
  
  <!-- Navigation Header -->
  <header class="border-b border-slate-900 bg-slate-950/80 backdrop-blur-md sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center shadow-inner overflow-visible">
          <svg class="w-7 h-7 transition-transform duration-300 hover:scale-110 cursor-pointer" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
            <defs>
              <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#6366f1" />
                <stop offset="50%" stop-color="#8b5cf6" />
                <stop offset="100%" stop-color="#ec4899" />
              </linearGradient>
            </defs>
            <circle cx="60" cy="60" r="52" fill="none" stroke="url(#logoGrad)" stroke-width="3" stroke-dasharray="12 6" opacity="0.8">
              <animateTransform attributeName="transform" type="rotate" from="0 60 60" to="360 60 60" dur="20s" repeatCount="indefinite" />
            </circle>
            <polygon points="60,15 99,37 99,83 60,105 21,83 21,37" fill="#090d16" stroke="url(#logoGrad)" stroke-width="4" />
            <circle cx="60" cy="35" r="5" fill="#6366f1" />
            <circle cx="85" cy="75" r="5" fill="#ec4899" />
            <circle cx="35" cy="75" r="5" fill="#8b5cf6" />
            <line x1="60" y1="35" x2="85" y2="75" stroke="#8b5cf6" stroke-width="2.5" opacity="0.7" />
            <line x1="85" y1="75" x2="35" y2="75" stroke="#ec4899" stroke-width="2.5" opacity="0.7" />
            <line x1="35" y1="75" x2="60" y2="35" stroke="#6366f1" stroke-width="2.5" opacity="0.7" />
            <circle cx="60" cy="60" r="10" fill="url(#logoGrad)" />
            <circle cx="60" cy="60" r="4" fill="#ffffff" />
          </svg>
        </div>
        <span class="text-base font-extrabold tracking-tight text-white flex items-center gap-1.5">
          Taskmaster<span class="text-indigo-400">Live</span>
        </span>
      </div>

      <nav class="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
        <a href="#demo" class="hover:text-white transition">Demo</a>
        <a href="#features" class="hover:text-white transition">Features</a>
        <a href="#architecture" class="hover:text-white transition">Dashboard Flow</a>
        <a href="/docs/openapi.yaml" target="_blank" class="hover:text-white transition">OpenAPI Spec</a>
        <a href="https://github.com" target="_blank" class="hover:text-white transition">GitHub</a>
      </nav>

      <div class="flex items-center gap-3">
        <a href="https://github.com/JawadulHadi/taskmaster-agent.git" target="_blank" class="px-3.5 py-1.5 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 rounded-full flex items-center gap-1.5 transition shadow-sm">
          <span class="text-amber-400">★</span> Star on GitHub
        </a>
        <a href="/" class="px-4 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-full transition shadow-lg shadow-indigo-600/20">
          Quick Start
        </a>
      </div>
    </div>
  </header>

  <!-- Hero Section -->
  <main class="flex-1">
    <section class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 pb-16 text-center space-y-8 relative">
      <div class="absolute inset-0 -z-10 flex items-center justify-center opacity-30 pointer-events-none">
        <div class="w-[500px] h-[500px] bg-indigo-600/25 rounded-full blur-[120px]"></div>
        <div class="w-[300px] h-[300px] bg-pink-600/25 rounded-full blur-[100px]"></div>
      </div>

      <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-medium bg-indigo-500/10 text-indigo-300 border border-indigo-500/30">
        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
        Genkit Agentic Workflow &amp; HR Automation
      </div>

      <h1 class="text-4xl sm:text-6xl font-extrabold text-white tracking-tight leading-[1.1]">
        Stop staring at static logs.<br>
        <span class="bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
          Start orchestrating AI workflows in real time.
        </span>
      </h1>

      <p class="max-w-2xl mx-auto text-base sm:text-lg text-slate-400 leading-relaxed">
        Watch your Genkit worker tasks execute live. Monitor employee records, policy vector searches, overtime audits, and human-in-the-loop supervisor approvals—100% secure on Cloud Run.
      </p>

      <div class="flex flex-wrap items-center justify-center gap-4 pt-4">
        <a href="/" class="px-6 py-3 text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl shadow-xl shadow-indigo-600/30 transition flex items-center gap-2">
          <span>⚡</span> Launch Control Center
        </a>
        <a href="https://github.com/JawadulHadi/taskmaster-agent.git" target="_blank" class="px-6 py-3 text-sm font-semibold bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 rounded-xl transition flex items-center gap-2">
          <span>★</span> Star on GitHub
        </a>
      </div>

      <!-- Git Clone Command Box -->
      <div class="max-w-xl mx-auto pt-6">
        <div class="bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex items-center justify-between shadow-xl font-mono text-xs text-slate-300">
          <div class="flex items-center gap-2 overflow-x-auto py-1">
            <span class="text-indigo-400 select-none">$</span>
            <span>git clone https://github.com/JawadulHadi/taskmaster-agent.git</span>
          </div>
          <button onclick="navigator.clipboard.writeText('git clone https://github.com/JawadulHadi/taskmaster-agent.git'); alert('Copied git clone command to clipboard!');" class="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-[11px] transition shrink-0">
            Copy
          </button>
        </div>
      </div>
    </section>

    <!-- Trusted Agents Marquee / Badges -->
    <section id="features" class="border-y border-slate-900 bg-slate-950/60 py-12">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center space-y-8">
        <h3 class="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Powered by industry-standard AI &amp; Cloud Infrastructure
        </h3>
        <div class="flex flex-wrap items-center justify-center gap-4 sm:gap-8">
          <div class="px-4 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs font-mono text-indigo-300 flex items-center gap-2">
            <span>✨</span> Google Genkit
          </div>
          <div class="px-4 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs font-mono text-purple-300 flex items-center gap-2">
            <span>🧠</span> Gemini 3.6 Flash
          </div>
          <div class="px-4 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs font-mono text-pink-300 flex items-center gap-2">
            <span>🔥</span> Cloud Firestore DB
          </div>
          <div class="px-4 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs font-mono text-emerald-300 flex items-center gap-2">
            <span>⚡</span> Google Cloud Pub/Sub
          </div>
        </div>
      </div>
    </section>

    <!-- Dashboard Flow & Architecture Section -->
    <section id="architecture" class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 space-y-16">
      <div class="text-center space-y-3">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-indigo-500/10 text-indigo-300 border border-indigo-500/30">
          Interactive Architecture &amp; Dashboard Flow
        </div>
        <h2 class="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
          Asynchronous Job Dispatch &amp; HITL Pipeline
        </h2>
        <p class="text-sm text-slate-400 max-w-2xl mx-auto">
          Explore core modules or visualize the agentic overtime approval lifecycle in real time.
        </p>
      </div>

      <!-- 3-Column CSS Grid containing clickable icons for Dashboard, HR Operations, and Audit Logs -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <!-- Dashboard Card -->
        <a href="/" class="group bg-slate-900/80 hover:bg-slate-900 border border-slate-800 hover:border-indigo-500/50 rounded-2xl p-6 transition-all shadow-lg hover:shadow-indigo-500/10 flex flex-col justify-between">
          <div class="space-y-4">
            <div class="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-xl text-indigo-400 group-hover:scale-110 transition-transform">
              📊
            </div>
            <div>
              <h3 class="text-base font-bold text-white group-hover:text-indigo-300 transition">Dashboard &amp; Control Center</h3>
              <p class="text-xs text-slate-400 mt-1 leading-relaxed">
                Real-time job queue monitoring, status updates across workers, and human-in-the-loop review overrides.
              </p>
            </div>
          </div>
          <div class="mt-6 flex items-center text-xs font-semibold text-indigo-400 gap-1 group-hover:translate-x-1 transition-transform">
            Launch Dashboard →
          </div>
        </a>

        <!-- HR Operations Card -->
        <a href="/" class="group bg-slate-900/80 hover:bg-slate-900 border border-slate-800 hover:border-purple-500/50 rounded-2xl p-6 transition-all shadow-lg hover:shadow-purple-500/10 flex flex-col justify-between">
          <div class="space-y-4">
            <div class="w-12 h-12 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-xl text-purple-400 group-hover:scale-110 transition-transform">
              👥
            </div>
            <div>
              <h3 class="text-base font-bold text-white group-hover:text-purple-300 transition">HR Operations &amp; Employees</h3>
              <p class="text-xs text-slate-400 mt-1 leading-relaxed">
                Manage employee timesheet records, base rates, department assignments, and overtime approval flags.
              </p>
            </div>
          </div>
          <div class="mt-6 flex items-center text-xs font-semibold text-purple-400 gap-1 group-hover:translate-x-1 transition-transform">
            View Records →
          </div>
        </a>

        <!-- Audit Logs Card -->
        <a href="/" class="group bg-slate-900/80 hover:bg-slate-900 border border-slate-800 hover:border-pink-500/50 rounded-2xl p-6 transition-all shadow-lg hover:shadow-pink-500/10 flex flex-col justify-between">
          <div class="space-y-4">
            <div class="w-12 h-12 rounded-xl bg-pink-500/10 border border-pink-500/30 flex items-center justify-center text-xl text-pink-400 group-hover:scale-110 transition-transform">
              📜
            </div>
            <div>
              <h3 class="text-base font-bold text-white group-hover:text-pink-300 transition">Audit Logs &amp; Policy Rules</h3>
              <p class="text-xs text-slate-400 mt-1 leading-relaxed">
                Query MeiliSearch policy rulebooks, inspect threshold caps, and review autonomous reasoning trace logs.
              </p>
            </div>
          </div>
          <div class="mt-6 flex items-center text-xs font-semibold text-pink-400 gap-1 group-hover:translate-x-1 transition-transform">
            Inspect Policies →
          </div>
        </a>
      </div>

      <!-- Flow Chart Component: Overtime Approval Request Lifecycle -->
      <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-8 space-y-6">
        <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <h3 class="text-lg font-bold text-white">Overtime Approval Lifecycle Flow Chart</h3>
            <p class="text-xs text-slate-400 mt-0.5">End-to-end agentic workflow execution from dispatcher to supervisor resolution.</p>
          </div>
          <span class="px-3 py-1 bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 text-xs font-mono rounded-full">
            Genkit Restartable Flow
          </span>
        </div>

        <!-- Flowchart Steps Grid / Chain -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 relative">
          <!-- Step 1 -->
          <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2 relative">
            <div class="text-[10px] font-mono text-indigo-400 font-semibold">STAGE 01</div>
            <div class="text-sm font-bold text-white">Command Dispatched</div>
            <p class="text-[11px] text-slate-400 leading-normal">Client triggers /jobs with timesheet audit command.</p>
          </div>

          <!-- Step 2 -->
          <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2 relative">
            <div class="text-[10px] font-mono text-purple-400 font-semibold">STAGE 02</div>
            <div class="text-sm font-bold text-white">Worker &amp; Policies</div>
            <p class="text-[11px] text-slate-400 leading-normal">Pub/Sub worker invokes Genkit; agent searches rules &amp; record.</p>
          </div>

          <!-- Step 3 -->
          <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2 relative">
            <div class="text-[10px] font-mono text-amber-400 font-semibold">STAGE 03</div>
            <div class="text-sm font-bold text-white">Threshold Check</div>
            <p class="text-[11px] text-slate-400 leading-normal">If OT &gt; Cap (e.g. 22h &gt; 10h), interrupt is triggered.</p>
          </div>

          <!-- Step 4 -->
          <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2 relative">
            <div class="text-[10px] font-mono text-pink-400 font-semibold">STAGE 04</div>
            <div class="text-sm font-bold text-white">Supervisor Review</div>
            <p class="text-[11px] text-slate-400 leading-normal">Job status set to <code class="text-indigo-300">needs_review</code>. Human supervisor approves/rejects.</p>
          </div>

          <!-- Step 5 -->
          <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2 relative">
            <div class="text-[10px] font-mono text-emerald-400 font-semibold">STAGE 05</div>
            <div class="text-sm font-bold text-white">Flow Resumed</div>
            <p class="text-[11px] text-slate-400 leading-normal">Agent resumes with decision, finalizes status as <code class="text-indigo-300">completed</code>.</p>
          </div>
        </div>
      </div>
    </section>
  </main>

  <!-- Footer -->
  <footer class="border-t border-slate-900 bg-slate-950 py-8 text-center text-xs text-slate-500">
    <div class="max-w-7xl mx-auto px-4 flex flex-col sm:px-6 lg:px-8 sm:flex-row items-center justify-between gap-4">
      <div>Taskmaster Agent Orchestration Platform • Built with Google Genkit &amp; Gemini</div>
      <div class="flex items-center gap-4">
        <a href="/" class="hover:text-slate-300 transition">Control Center</a>
        <a href="/docs/openapi.yaml" target="_blank" class="hover:text-slate-300 transition">OpenAPI Spec</a>
        <a href="https://github.com/JawadulHadi/taskmaster-agent.git" target="_blank" class="hover:text-slate-300 transition">GitHub Repo</a>
      </div>
    </div>
  </footer>
</body>
</html>`);
});

// ── Interactive Web Console (Preview UI) ──
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Taskmaster Agent - HR Ops Control Center</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; }
    code, pre { font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen flex flex-col antialiased">
  <!-- Top Navigation Header -->
  <header class="border-b border-slate-800 bg-slate-950/90 backdrop-blur sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center shadow-inner overflow-visible">
          <svg class="w-8 h-8 transition-transform duration-300 hover:scale-110 hover:opacity-90 cursor-pointer" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
            <defs>
              <linearGradient id="genkitGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#6366f1" />
                <stop offset="50%" stop-color="#8b5cf6" />
                <stop offset="100%" stop-color="#ec4899" />
              </linearGradient>
              <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>
            <circle cx="60" cy="60" r="52" fill="none" stroke="url(#genkitGrad)" stroke-width="3" stroke-dasharray="12 6" opacity="0.8">
              <animateTransform attributeName="transform" type="rotate" from="0 60 60" to="360 60 60" dur="20s" repeatCount="indefinite" />
            </circle>
            <polygon points="60,15 99,37 99,83 60,105 21,83 21,37" fill="#090d16" stroke="url(#genkitGrad)" stroke-width="4" filter="url(#glow)" />
            <circle cx="60" cy="35" r="5" fill="#6366f1" />
            <circle cx="85" cy="75" r="5" fill="#ec4899" />
            <circle cx="35" cy="75" r="5" fill="#8b5cf6" />
            <line x1="60" y1="35" x2="85" y2="75" stroke="#8b5cf6" stroke-width="2.5" opacity="0.7" />
            <line x1="85" y1="75" x2="35" y2="75" stroke="#ec4899" stroke-width="2.5" opacity="0.7" />
            <line x1="35" y1="75" x2="60" y2="35" stroke="#6366f1" stroke-width="2.5" opacity="0.7" />
            <circle cx="60" cy="60" r="10" fill="url(#genkitGrad)">
              <animate attributeName="r" values="8;12;8" dur="3s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.7;1;0.7" dur="3s" repeatCount="indefinite" />
            </circle>
            <circle cx="60" cy="60" r="4" fill="#ffffff" />
          </svg>
        </div>
        <div>
          <div class="flex items-center gap-2">
            <h1 class="text-base font-bold text-white tracking-tight">Taskmaster Agent</h1>
            <span class="px-2 py-0.5 text-[10px] font-mono font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded-full">Genkit</span>
          </div>
          <p class="text-xs text-slate-400">Autonomous HR Compliance &amp; Event-Driven Loop Engine</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping mr-1.5"></span>
          Agentic Loop Active
        </span>
        <a href="/branding" class="px-3 py-1.5 text-xs font-medium bg-slate-900 hover:bg-slate-800 text-indigo-300 rounded-md border border-indigo-500/30 transition flex items-center gap-1.5">
          <span>✨</span> Branding
        </a>
        <button id="refreshBtn" onclick="loadAllData()" class="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md border border-slate-700 transition flex items-center gap-1">
          <span>↻</span> Refresh
        </button>
      </div>
    </div>
  </header>

  <!-- Main Content Layout -->
  <main class="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
    
    <!-- Left Column: Submit Command & Reference Data (5 cols) -->
    <div class="lg:col-span-5 space-y-6">
      
      <!-- Command Dispatcher Card -->
      <div class="bg-slate-950 border border-slate-800 rounded-xl p-5 shadow-sm">
        <h2 class="text-sm font-semibold text-white uppercase tracking-wider text-xs mb-3 flex items-center gap-2">
          <span>🚀</span> Dispatch HR Agent Task
        </h2>
        <p class="text-xs text-slate-400 mb-4">
          Submit an asynchronous natural-language directive for the agent. The agent uses Genkit + Gemini to reason, query policies, inspect employee timesheets, and pause for approval if violations occur.
        </p>

        <form id="jobForm" onsubmit="submitJob(event)" class="space-y-3">
          <div>
            <label class="block text-xs font-medium text-slate-300 mb-1">Command Directive</label>
            <textarea id="commandInput" rows="3" required
              placeholder="e.g. Check overtime for employee emp_002 and resolve policy violations."
              class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 resize-none"></textarea>
          </div>

          <div class="flex items-center justify-between pt-1">
            <div class="text-xs text-slate-400">
              Tenant: <span class="text-slate-300 font-mono">tenant_01</span>
            </div>
            <button type="submit" id="submitBtn"
              class="inline-flex items-center justify-center px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg shadow transition focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">
              Submit Job →
            </button>
          </div>
        </form>

        <!-- Quick Presets -->
        <div class="mt-4 pt-4 border-t border-slate-800/80">
          <div class="text-[11px] font-medium text-slate-400 mb-2 uppercase tracking-wider">Quick Directives:</div>
          <div class="flex flex-col gap-1.5">
            <button onclick="setCommand('Check overtime for employee emp_002 and resolve violations.')"
              class="text-left text-xs bg-slate-900/80 hover:bg-slate-800 text-slate-300 px-2.5 py-1.5 rounded border border-slate-800 transition truncate">
              ⚠️ Audit emp_002 (John Smith — 22h overtime > 10h cap)
            </button>
            <button onclick="setCommand('Inspect timesheet for employee emp_001 and verify compliance.')"
              class="text-left text-xs bg-slate-900/80 hover:bg-slate-800 text-slate-300 px-2.5 py-1.5 rounded border border-slate-800 transition truncate">
              ✅ Audit emp_001 (Alice Chen — 6h approved overtime)
            </button>
            <button onclick="setCommand('Review timesheet and department overtime policy for employee emp_003.')"
              class="text-left text-xs bg-slate-900/80 hover:bg-slate-800 text-slate-300 px-2.5 py-1.5 rounded border border-slate-800 transition truncate">
              📋 Audit emp_003 (Maria Garcia — 15h unapproved)
            </button>
            <button onclick="setCommand('Employee: emp_002. Timesheet text: Mon 10h, Tue 11h, Wed 9h, Thu 10h, Fri 12h, Sat 8h. Total 60h with 20h overtime. Validate compliance.')"
              class="text-left text-xs bg-indigo-950/40 hover:bg-indigo-900/50 text-indigo-300 px-2.5 py-1.5 rounded border border-indigo-800/40 transition truncate">
              ✨ Unstructured Shift Log (Gemini Extraction &amp; Policy Validation)
            </button>
          </div>
        </div>
      </div>

      <!-- Employee Records Overview -->
      <div class="bg-slate-950 border border-slate-800 rounded-xl p-5 shadow-sm">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-xs font-semibold text-white uppercase tracking-wider flex items-center gap-1.5">
            <span>👥</span> Employee Timesheet Database
          </h2>
          <span class="text-[11px] text-slate-500 font-mono">Firestore</span>
        </div>
        <div id="employeesList" class="space-y-2 text-xs">
          <div class="text-slate-500 py-3 text-center">Loading employee records...</div>
        </div>
      </div>

      <!-- Corporate Policies Overview -->
      <div class="bg-slate-950 border border-slate-800 rounded-xl p-5 shadow-sm">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-xs font-semibold text-white uppercase tracking-wider flex items-center gap-1.5">
            <span>📜</span> Corporate Policy Rulebook
          </h2>
          <span class="text-[11px] text-slate-500 font-mono">MeiliSearch</span>
        </div>
        <div id="policiesList" class="space-y-2 text-xs">
          <div class="text-slate-500 py-3 text-center">Loading policies...</div>
        </div>
      </div>

    </div>

    <!-- Right Column: Live Jobs & HITL Review Feed (7 cols) -->
    <div class="lg:col-span-7 space-y-6">
      
      <!-- HITL Action Banner if any job needs review -->
      <div id="hitlContainer" class="hidden"></div>

      <!-- Jobs Execution Feed -->
      <div class="bg-slate-950 border border-slate-800 rounded-xl p-5 shadow-sm">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h2 class="text-sm font-semibold text-white flex items-center gap-2">
              <span>📋</span> Event-Driven Jobs &amp; Execution Queue
            </h2>
            <p class="text-xs text-slate-400">Real-time status updates across Dispatcher, Pub/Sub Worker, and Genkit reasoning</p>
          </div>
        </div>

        <div id="jobsList" class="space-y-3">
          <div class="text-slate-500 py-10 text-center text-xs">No active jobs found. Submit a directive to get started.</div>
        </div>
      </div>

    </div>
  </main>

  <!-- Footer -->
  <footer class="border-t border-slate-800 bg-slate-950 py-3 mt-auto text-center text-xs text-slate-500">
    Taskmaster HR Ops Agent • All Things Agentic Hackathon • Powered by Genkit &amp; Gemini
  </footer>

  <script>
    function setCommand(txt) {
      document.getElementById('commandInput').value = txt;
      document.getElementById('commandInput').focus();
    }

    async function submitJob(e) {
      e.preventDefault();
      const command = document.getElementById('commandInput').value.trim();
      if (!command) return;

      const submitBtn = document.getElementById('submitBtn');
      submitBtn.disabled = true;
      submitBtn.innerText = 'Dispatching...';

      try {
        const res = await fetch('/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, tenantId: 'tenant_01' })
        });
        const data = await res.json();
        document.getElementById('commandInput').value = '';
        await loadAllData();
      } catch (err) {
        alert('Failed to submit job: ' + err.message);
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerText = 'Submit Job →';
      }
    }

    async function resumeJob(jobId, decision) {
      const btn = event.target;
      btn.disabled = true;
      btn.innerText = decision === 'approved' ? 'Approving...' : 'Rejecting...';

      try {
        const res = await fetch('/jobs/' + jobId + '/resume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision })
        });
        await res.json();
        await loadAllData();
      } catch (err) {
        alert('Failed to resume job: ' + err.message);
      }
    }

    function renderStatusBadge(status) {
      switch(status) {
        case 'queued':
          return '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">⏳ Queued</span>';
        case 'running':
          return '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20"><span class="w-1.5 h-1.5 rounded-full bg-blue-400 animate-spin mr-1"></span>Running</span>';
        case 'needs_review':
          return '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-purple-500/20 text-purple-300 border border-purple-500/30 animate-pulse">⏸️ Needs Review (HITL)</span>';
        case 'completed':
          return '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">✅ Completed</span>';
        case 'error':
          return '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">❌ Error</span>';
        default:
          return '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-300">' + status + '</span>';
      }
    }

    async function loadEmployees() {
      try {
        const res = await fetch('/api/employees');
        if (!res.ok) return;
        const data = await res.json();
        const container = document.getElementById('employeesList');
        if (!data.employees || data.employees.length === 0) {
          container.innerHTML = '<div class="text-slate-500">No records found.</div>';
          return;
        }
        container.innerHTML = data.employees.map(emp => \`
          <div class="bg-slate-900 border border-slate-800 rounded-lg p-2.5 flex items-center justify-between">
            <div>
              <div class="font-medium text-slate-200">\${emp.name} <span class="text-slate-500 font-mono text-[10px]">(\${emp.id})</span></div>
              <div class="text-slate-400 text-[11px]">\${emp.department} • $\${emp.baseRate}/hr</div>
            </div>
            <div class="text-right">
              <div class="text-slate-300 font-mono font-medium">\${emp.regularHours}h reg + \${emp.overtimeHours}h OT</div>
              <div class="\${emp.overtimeApproved ? 'text-emerald-400' : 'text-amber-400'} text-[10px]">
                \${emp.overtimeApproved ? '✓ OT Approved' : '⚠️ OT Unapproved'}
              </div>
            </div>
          </div>
        \`).join('');
      } catch (err) {
        console.error('Failed to load employees', err);
      }
    }

    async function loadPolicies() {
      try {
        const res = await fetch('/api/policies');
        if (!res.ok) return;
        const data = await res.json();
        const container = document.getElementById('policiesList');
        if (!data.policies || data.policies.length === 0) {
          container.innerHTML = '<div class="text-slate-500">No policies found.</div>';
          return;
        }
        container.innerHTML = data.policies.map(pol => \`
          <div class="bg-slate-900 border border-slate-800 rounded-lg p-2.5">
            <div class="flex items-center justify-between">
              <span class="font-medium text-slate-200 text-xs">\${pol.title}</span>
              <span class="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">\${pol.severity}</span>
            </div>
            <div class="text-[11px] text-slate-400 mt-1 flex items-center justify-between">
              <code class="text-slate-500 text-[10px]">\${pol.ruleCode}</code>
              <span class="font-mono text-indigo-300">Cap: \${pol.thresholdLimit} hrs</span>
            </div>
          </div>
        \`).join('');
      } catch (err) {
        console.error('Failed to load policies', err);
      }
    }

    async function loadJobs() {
      try {
        const res = await fetch('/api/jobs');
        if (!res.ok) return;
        const data = await res.json();
        const container = document.getElementById('jobsList');
        const hitlContainer = document.getElementById('hitlContainer');
        const jobs = data.jobs || [];

        if (jobs.length === 0) {
          container.innerHTML = '<div class="text-slate-500 py-10 text-center text-xs">No active jobs found. Submit a directive to get started.</div>';
          hitlContainer.classList.add('hidden');
          return;
        }

        // Check for jobs that need review
        const reviewJobs = jobs.filter(j => j.status === 'needs_review');
        if (reviewJobs.length > 0) {
          hitlContainer.classList.remove('hidden');
          hitlContainer.innerHTML = reviewJobs.map(job => \`
            <div class="bg-gradient-to-r from-purple-950/70 to-indigo-950/70 border-2 border-purple-500/50 rounded-xl p-5 shadow-lg space-y-3">
              <div class="flex items-start justify-between">
                <div>
                  <div class="flex items-center gap-2">
                    <span class="text-xl">⚠️</span>
                    <h3 class="text-sm font-semibold text-purple-200 uppercase tracking-wide">Human-in-the-Loop Action Required</h3>
                  </div>
                  <p class="text-xs text-purple-300 mt-1">
                    The agent interrupted autonomous execution because a policy limit violation was detected.
                  </p>
                </div>
                <span class="font-mono text-xs text-purple-400 bg-purple-900/40 px-2 py-0.5 rounded border border-purple-500/30">
                  Job: \${job.jobId.slice(0, 8)}
                </span>
              </div>

              <div class="bg-purple-950/80 border border-purple-800/60 rounded-lg p-3 text-xs text-purple-100 font-mono">
                \${job.message || 'Overtime threshold exceeded. Approve or reject policy override.'}
              </div>

              <div class="flex items-center justify-end gap-3 pt-1">
                <button onclick="resumeJob('\${job.jobId}', 'rejected')"
                  class="px-3.5 py-1.5 bg-rose-600/80 hover:bg-rose-600 text-white text-xs font-medium rounded-lg border border-rose-500 transition shadow">
                  ✕ Reject Overtime
                </button>
                <button onclick="resumeJob('\${job.jobId}', 'approved')"
                  class="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg border border-emerald-500 transition shadow">
                  ✓ Approve Overtime Override
                </button>
              </div>
            </div>
          \`).join('');
        } else {
          hitlContainer.classList.add('hidden');
        }

        container.innerHTML = jobs.map(job => \`
          <div class="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-2.5 transition hover:border-slate-700">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                \${renderStatusBadge(job.status)}
                <span class="text-xs font-mono text-slate-500">\${job.jobId}</span>
              </div>
              <span class="text-[11px] text-slate-500 font-mono">
                \${new Date(job.createdAt).toLocaleTimeString()}
              </span>
            </div>

            <div class="text-xs text-slate-200 font-medium">
              \${job.command}
            </div>

            \${job.message ? \`
              <div class="text-xs bg-slate-950 border border-slate-800 rounded p-2.5 text-amber-300 font-mono">
                \${job.message}
              </div>
            \` : ''}

            \${job.result ? \`
              <div class="text-xs bg-slate-950 border border-slate-800 rounded p-2.5 text-slate-300 font-mono whitespace-pre-wrap">
                \${job.result}
              </div>
            \` : ''}
          </div>
        \`).join('');

      } catch (err) {
        console.error('Failed to load jobs', err);
      }
    }

    async function loadAllData() {
      await Promise.all([loadEmployees(), loadPolicies(), loadJobs()]);
    }

    // Initial load and polling
    loadAllData();
    setInterval(loadJobs, 3000);
  </script>
</body>
</html>`);
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, "localhost", () => {
  console.log(`taskmaster-agent server running on http://localhost:${port}`);
});
