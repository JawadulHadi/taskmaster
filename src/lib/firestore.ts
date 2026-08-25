import { Firestore } from "@google-cloud/firestore";

const firestore = new Firestore();
export const jobsCol = firestore.collection("jobs");
export const employeesCol = firestore.collection("employees");

export async function createJob(
  jobId: string,
  command: string,
  tenantId: string,
) {
  await jobsCol.doc(jobId).set({
    jobId,
    command,
    tenantId,
    status: "queued",
    createdAt: new Date().toISOString(),
  });
}

export async function updateJobStatus(
  jobId: string,
  status: string,
  extraData: Record<string, any> = {},
) {
  await jobsCol.doc(jobId).update({
    status,
    updatedAt: new Date().toISOString(),
    ...extraData,
  });
}

export async function getJob(jobId: string) {
  const snap = await jobsCol.doc(jobId).get();
  return snap.exists ? snap.data() : null;
}
