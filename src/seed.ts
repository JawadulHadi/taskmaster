import "dotenv/config";
import { employeesCol } from "./lib/firestore.js";
import { policyIndex } from "./lib/meili.js";

async function seed() {
  await employeesCol.doc("emp_002").set({
    id: "emp_002",
    name: "John Smith",
    department: "Design",
    baseRate: 40.0,
    regularHours: 160.0,
    overtimeHours: 22.0,
    overtimeApproved: false,
  });

  await policyIndex.addDocuments([
    {
      id: "pol_01",
      ruleCode: "overtime_approval_limit",
      title: "Overtime Approval Limit Ceiling",
      thresholdLimit: 10.0,
      severity: "high",
    },
  ]);

  console.log("Seeded Firestore + MeiliSearch.");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
