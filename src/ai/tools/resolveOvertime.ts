import { z } from "zod";
import { ai } from "../genkit.js";
import { employeesCol } from "../../lib/firestore.js";

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
    const resumedData = (typeof resumed === "object" && resumed !== null ? resumed : {}) as Record<string, any>;
    if (resumedData.decision === "approved") {
      await employeesCol.doc(input.employeeId).update({
        overtimeApproved: true,
      });
      return {
        committed: true,
        auditLog: `Overtime for ${input.employeeId} (${input.overtimeHours}h) approved by human supervisor.`,
      };
    }

    if (resumedData.decision === "rejected") {
      await employeesCol.doc(input.employeeId).update({
        overtimeApproved: false,
      });
      return {
        committed: false,
        auditLog: `Overtime for ${input.employeeId} rejected by human supervisor.`,
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
