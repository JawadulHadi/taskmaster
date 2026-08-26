import { Firestore } from "@google-cloud/firestore";

export interface EmployeeRecord {
  id: string;
  name: string;
  department: string;
  baseRate: number;
  regularHours: number;
  overtimeHours: number;
  overtimeApproved: boolean;
}

export interface JobRecord {
  jobId: string;
  command: string;
  tenantId: string;
  status: "queued" | "running" | "needs_review" | "completed" | "error";
  createdAt: string;
  updatedAt?: string;
  result?: string;
  lastResponse?: any;
  message?: string;
  [key: string]: any;
}

// In-memory fallback stores
const inMemoryEmployees = new Map<string, EmployeeRecord>([
  [
    "emp_001",
    {
      id: "emp_001",
      name: "Alice Chen",
      department: "Engineering",
      baseRate: 55.0,
      regularHours: 160.0,
      overtimeHours: 6.0,
      overtimeApproved: true,
    },
  ],
  [
    "emp_002",
    {
      id: "emp_002",
      name: "John Smith",
      department: "Design",
      baseRate: 40.0,
      regularHours: 160.0,
      overtimeHours: 22.0,
      overtimeApproved: false,
    },
  ],
  [
    "emp_003",
    {
      id: "emp_003",
      name: "Maria Garcia",
      department: "Operations",
      baseRate: 35.0,
      regularHours: 160.0,
      overtimeHours: 15.0,
      overtimeApproved: false,
    },
  ],
]);

const inMemoryJobs = new Map<string, JobRecord>();

let firestoreInstance: Firestore | null = null;
let useRealFirestore = false;
let firestoreWarned = false;

// Check if valid GCP credentials or emulator exist
if (
  process.env.FIRESTORE_EMULATOR_HOST ||
  (process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_CLOUD_PROJECT !== "your-project-id")
) {
  try {
    firestoreInstance = new Firestore();
    useRealFirestore = true;
  } catch (err) {
    useRealFirestore = false;
  }
}

function handleFirestoreError(err: any) {
  if (!firestoreWarned) {
    console.warn("[Taskmaster] Cloud Firestore unavailable or disabled in current environment; running with persistent in-memory store.");
    firestoreWarned = true;
  }
  useRealFirestore = false;
}

export const employeesCol = {
  doc(id: string) {
    return {
      async get() {
        if (useRealFirestore && firestoreInstance) {
          try {
            const snap = await firestoreInstance.collection("employees").doc(id).get();
            if (snap.exists) {
              return {
                exists: true,
                data: () => snap.data() as EmployeeRecord,
              };
            }
          } catch (err) {
            handleFirestoreError(err);
          }
        }
        const item = inMemoryEmployees.get(id);
        return {
          exists: !!item,
          data: () => (item ? { ...item } : null),
        };
      },
      async set(data: any) {
        inMemoryEmployees.set(id, { ...data, id });
        if (useRealFirestore && firestoreInstance) {
          try {
            await firestoreInstance.collection("employees").doc(id).set(data);
          } catch (err) {
            handleFirestoreError(err);
          }
        }
      },
      async update(data: any) {
        const current = inMemoryEmployees.get(id);
        if (current) {
          inMemoryEmployees.set(id, { ...current, ...data });
        }
        if (useRealFirestore && firestoreInstance) {
          try {
            await firestoreInstance.collection("employees").doc(id).update(data);
          } catch (err) {
            handleFirestoreError(err);
          }
        }
      },
    };
  },
};

export const jobsCol = {
  doc(id: string) {
    return {
      async get() {
        if (useRealFirestore && firestoreInstance) {
          try {
            const snap = await firestoreInstance.collection("jobs").doc(id).get();
            if (snap.exists) {
              return {
                exists: true,
                data: () => snap.data() as JobRecord,
              };
            }
          } catch (err) {
            handleFirestoreError(err);
          }
        }
        const item = inMemoryJobs.get(id);
        return {
          exists: !!item,
          data: () => (item ? { ...item } : null),
        };
      },
      async set(data: any) {
        inMemoryJobs.set(id, { ...data, jobId: id });
        if (useRealFirestore && firestoreInstance) {
          try {
            await firestoreInstance.collection("jobs").doc(id).set(data);
          } catch (err) {
            handleFirestoreError(err);
          }
        }
      },
      async update(data: any) {
        const current = inMemoryJobs.get(id) || {
          jobId: id,
          command: "",
          tenantId: "tenant_01",
          status: "queued" as const,
          createdAt: new Date().toISOString(),
        };
        inMemoryJobs.set(id, { ...current, ...data });
        if (useRealFirestore && firestoreInstance) {
          try {
            await firestoreInstance.collection("jobs").doc(id).update(data);
          } catch (err) {
            handleFirestoreError(err);
          }
        }
      },
    };
  },
};

export async function createJob(
  jobId: string,
  command: string,
  tenantId: string,
) {
  const jobData: JobRecord = {
    jobId,
    command,
    tenantId,
    status: "queued",
    createdAt: new Date().toISOString(),
  };

  inMemoryJobs.set(jobId, jobData);

  if (useRealFirestore && firestoreInstance) {
    try {
      await firestoreInstance.collection("jobs").doc(jobId).set(jobData);
    } catch (err) {
      handleFirestoreError(err);
    }
  }
}

export async function updateJobStatus(
  jobId: string,
  status: JobRecord["status"],
  extraData: Record<string, any> = {},
) {
  const updateData = {
    status,
    updatedAt: new Date().toISOString(),
    ...extraData,
  };

  const existing = inMemoryJobs.get(jobId);
  if (existing) {
    inMemoryJobs.set(jobId, { ...existing, ...updateData });
  } else {
    inMemoryJobs.set(jobId, {
      jobId,
      command: extraData.command || "Processing",
      tenantId: extraData.tenantId || "tenant_01",
      createdAt: new Date().toISOString(),
      ...updateData,
    });
  }

  if (useRealFirestore && firestoreInstance) {
    try {
      await firestoreInstance.collection("jobs").doc(jobId).update(updateData);
    } catch (err) {
      handleFirestoreError(err);
    }
  }
}

export async function getJob(jobId: string): Promise<JobRecord | null> {
  if (useRealFirestore && firestoreInstance) {
    try {
      const snap = await firestoreInstance.collection("jobs").doc(jobId).get();
      if (snap.exists) {
        return snap.data() as JobRecord;
      }
    } catch (err) {
      handleFirestoreError(err);
    }
  }
  return inMemoryJobs.get(jobId) || null;
}

export async function getAllJobs(): Promise<JobRecord[]> {
  return Array.from(inMemoryJobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export async function getAllEmployees(): Promise<EmployeeRecord[]> {
  return Array.from(inMemoryEmployees.values());
}
