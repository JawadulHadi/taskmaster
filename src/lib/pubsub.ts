import { PubSub } from "@google-cloud/pubsub";

const pubsub = new PubSub();
const TOPIC = process.env.PUBSUB_TOPIC || "taskmaster-jobs";

export async function publishJob(jobId: string, tenantId: string) {
  await pubsub
    .topic(TOPIC)
    .publishMessage({ json: { jobId, tenantId } });
}
