import { z } from "zod";
import { ai } from "../genkit.js";
import { searchPolicies } from "../tools/searchPolicies.js";
import { getEmployeeRecord } from "../tools/getEmployeeRecord.js";
import { resolveOvertime } from "../tools/resolveOvertime.js";

export const taskmasterFlow = ai.defineFlow(
  {
    name: "taskmasterFlow",
    inputSchema: z.object({
      command: z.string(),
      tenantId: z.string(),
    }),
    outputSchema: z.any(), // we return the full response object
  },
  async ({ command, tenantId }) => {
    const response = await ai.generate({
      prompt: command,
      tools: [searchPolicies, getEmployeeRecord, resolveOvertime],
      // Optional: limit turns to avoid infinite loops
      maxTurns: 6,
    });

    // Return the raw Genkit response so the caller can check for interrupts.
    return response;
  },
);
