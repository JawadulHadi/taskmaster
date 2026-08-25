import { z } from "zod";
import { ai } from "../genkit.js";
import { policyIndex } from "../../lib/meili.js";

export const searchPolicies = ai.defineTool(
  {
    name: "search_policies",
    description: "Full-text search over the corporate policy rulebook (overtime limits, shift caps, budget ceilings).",
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.array(
      z.object({ ruleCode: z.string(), title: z.string(), thresholdLimit: z.number(), severity: z.string() })
    ),
  },
  async ({ query }) => {
    const res = await policyIndex.search(query, { limit: 3 });
    return res.hits as any;
  }
);
