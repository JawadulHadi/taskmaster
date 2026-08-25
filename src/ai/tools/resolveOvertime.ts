import { z } from "zod";
import { ai } from "../genkit.js";

export const resolveOvertime = ai.defineTool(
  {
    name: "resolve_overtime_violation",
    description:
      "Commits an overtime policy violation. MUST pause for human approval before writing — never auto-approve.",
    inputSchema: z.object({
      employeeId: z.string(),
      overtimeHours: z.number(),
      action: z.enum(["override", "reject_overtime", "manually_adjust"]),
      adjustedHours: z.number().optional(),
    }),
    outputSchema: z.object({
      committed: z.boolean(),
      auditLog: z.string(),
    }),
  },
  async (input, { interrupt, resumed }) => {
    // If this is a restart after human decision, apply it.
    if (resumed?.decision === "approved") {
      // In a real system you would write to Firestore, send notifications, etc.
      return {
        committed: true,
        auditLog: `Overtime for ${input.employeeId} (${input.overtimeHours}h) approved by human.`,
      };
    }

    if (resumed?.decision === "rejected") {
      return {
        committed: false,
        auditLog: `Overtime for ${input.employeeId} rejected by human.`,
      };
    }

    // First call: no resumed data → interrupt and wait.
    interrupt({
      message: `Overtime violation for ${input.employeeId} (${input.overtimeHours}h). Action: ${input.action}.`,
    });

    // This line is unreachable because interrupt throws, but it satisfies TypeScript.
    return { committed: false, auditLog: "pending" };
  },
);
