import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { createJob, updateJobStatus, getJob } from "./lib/firestore.js";
import { publishJob } from "./lib/pubsub.js";
import { taskmasterFlow } from "./ai/flows/taskmasterFlow.js";
import { resolveOvertime } from "./ai/tools/resolveOvertime.js";
import { ai } from "./ai/genkit.js";

const app = express();
app.use(express.json());

// ── Dispatcher ──
app.post("/jobs", async (req, res) => {
  const { command, tenantId = "tenant_01" } = req.body ?? {};
  if (!command) return res.status(400).json({ error: "command is required" });

  const jobId = randomUUID();
  await createJob(jobId, command, tenantId);
  await publishJob(jobId, tenantId);

  res.status(202).json({ jobId, status: "queued" });
});

// ── Worker ──
app.post("/tasks/run", async (req, res) => {
  const envelope = req.body?.message;
  if (!envelope?.data) return res.status(400).send("bad Pub/Sub envelope");

  const { jobId, tenantId } = JSON.parse(
    Buffer.from(envelope.data, "base64").toString(),
  );

  await updateJobStatus(jobId, "running");
  try {
    const response = await taskmasterFlow({
      command: `Process job ${jobId}`,
      tenantId,
    });

    if (response.finishReason === "interrupted") {
      // Store the entire response (contains messages and interrupts) for later resume.
      await updateJobStatus(jobId, "needs_review", {
        lastResponse: response,
      });
    } else {
      await updateJobStatus(jobId, "completed", {
        result: response.text ?? "Completed",
      });
    }
  } catch (err: any) {
    await updateJobStatus(jobId, "error", { message: err?.message });
  }

  res.status(204).send(); // ack
});

// ── Resume ──
app.post("/jobs/:jobId/resume", async (req, res) => {
  const { jobId } = req.params;
  const { decision } = req.body; // expect { decision: "approved" | "rejected" }

  const job = await getJob(jobId);
  if (!job || job.status !== "needs_review" || !job.lastResponse) {
    return res.status(400).json({ error: "Job not resumable" });
  }

  const lastResponse = job.lastResponse;
  if (!lastResponse.interrupts || lastResponse.interrupts.length === 0) {
    return res.status(400).json({ error: "No interrupts found" });
  }

  // Assume only one interrupt (our tool only triggers one at a time).
  const interrupt = lastResponse.interrupts[0];

  const resumedResponse = await ai.generate({
    tools: [resolveOvertime], // we only need the tool that was interrupted
    messages: lastResponse.messages,
    resume: {
      restart: [resolveOvertime.restart(interrupt, { decision })],
    },
  });

  // Check again for another interrupt (in case the model calls the tool again).
  if (resumedResponse.finishReason === "interrupted") {
    await updateJobStatus(jobId, "needs_review", {
      lastResponse: resumedResponse,
    });
    return res.json({
      status: "needs_review",
      message: "Still waiting for more input",
    });
  }

  await updateJobStatus(jobId, "completed", {
    result: resumedResponse.text ?? "Completed",
  });

  res.json({ status: "completed", result: resumedResponse.text });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`taskmaster-agent listening on ${port}`));
