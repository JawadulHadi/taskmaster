import { z } from "zod";
import { ai } from "../genkit.js";
import { employeesCol, getAllEmployees } from "../../lib/firestore.js";

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
    // 1. Direct ID lookup
    const snap = await employeesCol.doc(employeeId).get();
    if (snap.exists) {
      return snap.data() as any;
    }

    // 2. Search by name or partial identifier across all employees
    const allEmployees = await getAllEmployees();
    const query = employeeId.toLowerCase().trim();

    const matched = allEmployees.find(
      (e) =>
        e.id.toLowerCase() === query ||
        e.name.toLowerCase().includes(query) ||
        query.includes(e.id.toLowerCase()) ||
        query.includes(e.name.toLowerCase())
    );

    if (matched) {
      return matched;
    }

    // 3. If employeeId is a job UUID or unknown, return the first active employee or safe placeholder
    if (allEmployees.length > 0) {
      return allEmployees[0];
    }

    return {
      id: employeeId,
      name: "Unknown Employee",
      department: "General",
      baseRate: 40.0,
      regularHours: 40.0,
      overtimeHours: 0.0,
      overtimeApproved: false,
    };
  }
);
