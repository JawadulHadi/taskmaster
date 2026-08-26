import { PubSub, Message } from "@google-cloud/pubsub";

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

type MessageHandler = (payload: any, ack?: () => void) => Promise<void>;
type JobSubscriber = (jobId: string, tenantId: string) => Promise<void>;

const localMessageHandlers: MessageHandler[] = [];
const localSubscribers: JobSubscriber[] = [];

export function registerLocalWorker(fn: JobSubscriber) {
  localSubscribers.push(fn);
}

export function registerTopicHandler(fn: MessageHandler) {
  localMessageHandlers.push(fn);
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
 * Publishes a generic JSON message payload to the configured Pub/Sub topic.
 */
export async function publishMessage(payload: Record<string, any>, topicName = PUBSUB_TOPIC) {
  if (useRealPubSub && pubsubClient) {
    try {
      await pubsubClient.topic(topicName).publishMessage({ json: payload });
      return;
    } catch (err) {
      handlePubSubError(err);
    }
  }

  // Local asynchronous queue dispatch
  setTimeout(async () => {
    // Dispatch to topic handlers
    for (const handler of localMessageHandlers) {
      try {
        await handler(payload, () => {});
      } catch (err) {
        console.error(`[Taskmaster] Local message handler error:`, err);
      }
    }

    // Also dispatch to legacy job subscribers if jobId is present
    if (payload.jobId) {
      for (const sub of localSubscribers) {
        try {
          await sub(payload.jobId, payload.tenantId || "tenant_01");
        } catch (err) {
          console.error(`[Taskmaster] Local worker error for job ${payload.jobId}:`, err);
        }
      }
    }
  }, 50);
}

/**
 * Publishes a job dispatch payload to PubSub.
 */
export async function publishJob(jobId: string, tenantId: string) {
  return publishMessage({ jobId, tenantId }, PUBSUB_TOPIC);
}

/**
 * Subscribes to the configured topic via Cloud Pub/Sub subscription or local event bus.
 */
export function subscribeToTopic(
  topicName = PUBSUB_TOPIC,
  subscriptionName = `${PUBSUB_TOPIC}-sub`,
  onMessage: MessageHandler,
) {
  // Always register for local event dispatch
  registerTopicHandler(onMessage);

  // If real GCP Pub/Sub is active, attach listener
  if (useRealPubSub && pubsubClient) {
    try {
      const subscription = pubsubClient.subscription(subscriptionName);
      subscription.on("message", async (message: Message) => {
        try {
          const rawString = message.data.toString("utf-8");
          let payload: any;
          try {
            payload = JSON.parse(rawString);
          } catch {
            payload = { rawText: rawString };
          }
          await onMessage(payload, () => message.ack());
        } catch (err) {
          console.error(`[PubSub] Error processing subscription message:`, err);
          message.nack();
        }
      });
      console.log(`[Taskmaster] Subscribed to PubSub subscription '${subscriptionName}' on topic '${topicName}'`);
    } catch (err) {
      handlePubSubError(err);
    }
  }
}
