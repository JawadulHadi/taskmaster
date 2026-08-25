import { z } from "zod";
import { ai } from "../genkit.js";
import { employeesCol } from "../../lib/firestore.js";

export const getEmployeeRecord = ai.defineTool(
  {
    name: "get_employee_record",
    description: "Fetch an employee's profile and current pay-period timesheet (regular + overtime hours).",
    inputSchema: z.object({ employeeId: z.string() }),
    outputSchema: z.object({
      id: z.string(),
      name: z.string(),
      department: z.string(),
      baseRate: z.number(),
      regularHours: z.number(),
      overtimeHours: z.number(),
      overtimeApproved: z.boolean(),
    }),
  },
  async ({ employeeId }) => {
    const snap = await employeesCol.doc(employeeId).get();
    if (!snap.exists) throw new Error(`Employee ${employeeId} not found`);
    return snap.data() as any;
  }
);
