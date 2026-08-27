import { PubSub } from "@google-cloud/pubsub";

export const PUBSUB_TOPIC = process.env.PUBSUB_TOPIC || "taskmaster-jobs";

let pubsubClient: PubSub | null = null;
let useRealPubSub = false;
let pubsubWarned = false;

if (
  process.env.GOOGLE_APPLICATION_CREDENTIALS &&
  process.env.GOOGLE_CLOUD_PROJECT &&
  process.env.GOOGLE_CLOUD_PROJECT !== "your-project-id"
) {
  try {
    pubsubClient = new PubSub();
    useRealPubSub = true;
  } catch (err) {
    useRealPubSub = false;
  }
}

export function getPubSubClient(): PubSub | null {
  return pubsubClient;
}

type JobSubscriber = (jobId: string, tenantId: string) => Promise<void>;

// Single dispatch path — previously this file also fanned messages out to
// a second, independent "topic handler" list that fed the now-deleted
// AgenticWorkflowEngine, so every local-mode job ran through two pipelines
// concurrently. Only `registerLocalWorker` remains; in production, Cloud
// Run's Pub/Sub push subscription is the equivalent single path via
// POST /tasks/run. See ADR-01.
const localSubscribers: JobSubscriber[] = [];

export function registerLocalWorker(fn: JobSubscriber) {
  localSubscribers.push(fn);
}

function handlePubSubError(err: any) {
  if (!pubsubWarned) {
    console.warn(
      "[Taskmaster] Cloud Pub/Sub unavailable or disabled in current environment; running with local asynchronous dispatcher.",
    );
    pubsubWarned = true;
  }
  useRealPubSub = false;
}

/**
 * Publishes a job dispatch payload. In production this goes to Cloud
 * Pub/Sub, which pushes to POST /tasks/run. In local/mock mode, it
 * dispatches directly to the single registered local worker.
 */
export async function publishJob(jobId: string, tenantId: string) {
  const payload = { jobId, tenantId };

  if (useRealPubSub && pubsubClient) {
    try {
      await pubsubClient.topic(PUBSUB_TOPIC).publishMessage({ json: payload });
      return;
    } catch (err) {
      handlePubSubError(err);
    }
  }

  // Local dispatch — single path, no fan-out.
  setTimeout(async () => {
    for (const sub of localSubscribers) {
      try {
        await sub(jobId, tenantId);
      } catch (err) {
        console.error(`[Taskmaster] Local worker error for job ${jobId}:`, err);
      }
    }
  }, 50);
}

/** Alias kept for the `/api/tasks/validate` route's existing call shape. */
export async function publishMessage(payload: Record<string, any>, _topicName = PUBSUB_TOPIC) {
  const jobId = payload.jobId || payload.taskId;
  const tenantId = payload.tenantId || "tenant_01";
  if (!jobId) throw new Error("publishMessage requires a jobId/taskId");
  return publishJob(jobId, tenantId);
}
