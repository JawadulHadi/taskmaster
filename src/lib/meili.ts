import { Meilisearch } from "meilisearch";

export interface PolicyDocument {
  id: string;
  ruleCode: string;
  title: string;
  thresholdLimit: number;
  severity: string;
  [key: string]: any;
}

// In-memory store fallback with default seeded policies
const inMemoryPolicies: PolicyDocument[] = [
  {
    id: "pol_01",
    ruleCode: "overtime_approval_limit",
    title: "Overtime Approval Limit Ceiling",
    thresholdLimit: 10.0,
    severity: "high",
  },
  {
    id: "pol_02",
    ruleCode: "weekly_max_hours",
    title: "Maximum Weekly Working Hours",
    thresholdLimit: 60.0,
    severity: "critical",
  },
  {
    id: "pol_03",
    ruleCode: "consecutive_workdays_limit",
    title: "Consecutive Workdays Limit",
    thresholdLimit: 6.0,
    severity: "high",
  },
  {
    id: "pol_04",
    ruleCode: "department_overtime_budget",
    title: "Monthly Department Overtime Budget Cap",
    thresholdLimit: 5000.0,
    severity: "medium",
  },
];

let realClient: Meilisearch | null = null;
const host = process.env.MEILI_HOST || process.env.MEILI_URL;

if (host) {
  try {
    realClient = new Meilisearch({
      host,
      apiKey: process.env.MEILI_API_KEY,
    });
  } catch (err) {
    console.warn("[Taskmaster] MeiliSearch client initialization failed, using in-memory store", err);
  }
}

export const policyIndex = {
  async search(query: string, options: { limit?: number } = {}) {
    const limit = options.limit ?? 3;
    if (realClient) {
      try {
        const index = realClient.index("policies");
        return await index.search(query, options);
      } catch (err) {
        console.warn("[Taskmaster] Meilisearch search failed, falling back to in-memory search:", err);
      }
    }

    const q = (query || "").toLowerCase();
    const hits = inMemoryPolicies.filter((p) => {
      if (!q) return true;
      return (
        p.ruleCode.toLowerCase().includes(q) ||
        p.title.toLowerCase().includes(q) ||
        p.severity.toLowerCase().includes(q) ||
        (q.includes("overtime") && p.ruleCode.includes("overtime")) ||
        (q.includes("hour") && (p.ruleCode.includes("hour") || p.ruleCode.includes("overtime")))
      );
    });

    return {
      hits: hits.slice(0, limit),
      query,
      totalHits: hits.length,
    };
  },

  async addDocuments(docs: PolicyDocument[]) {
    for (const doc of docs) {
      const idx = inMemoryPolicies.findIndex((p) => p.id === doc.id);
      if (idx >= 0) {
        inMemoryPolicies[idx] = { ...inMemoryPolicies[idx], ...doc };
      } else {
        inMemoryPolicies.push(doc);
      }
    }

    if (realClient) {
      try {
        const index = realClient.index("policies");
        return await index.addDocuments(docs);
      } catch (err) {
        console.warn("[Taskmaster] Meilisearch addDocuments failed, saved to in-memory store only");
      }
    }
    return { taskUid: Date.now() };
  },

  async getDocuments() {
    return [...inMemoryPolicies];
  },
};

export const meili = realClient ?? (policyIndex as any);
