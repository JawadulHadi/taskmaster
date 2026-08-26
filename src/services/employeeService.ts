import { employeesCol, getAllEmployees, EmployeeRecord } from "../lib/firestore.js";

export class EmployeeService {
  /**
   * Fetch an employee record by ID or partial name/ID match.
   */
  async getEmployee(employeeId: string): Promise<EmployeeRecord | null> {
    if (!employeeId) return null;
    const snap = await employeesCol.doc(employeeId).get();
    if (snap.exists) {
      return snap.data();
    }

    const all = await getAllEmployees();
    const query = employeeId.toLowerCase().trim();
    const found = all.find(
      (e) =>
        e.id.toLowerCase() === query ||
        e.name.toLowerCase().includes(query) ||
        query.includes(e.id.toLowerCase()) ||
        query.includes(e.name.toLowerCase())
    );

    return found || null;
  }

  /**
   * Fetch all employee records.
   */
  async listEmployees(): Promise<EmployeeRecord[]> {
    return await getAllEmployees();
  }

  /**
   * Add a new employee record.
   */
  async addEmployee(record: EmployeeRecord): Promise<EmployeeRecord> {
    if (!record.id) {
      record.id = `emp_${Date.now()}`;
    }
    await employeesCol.doc(record.id).set(record);
    return record;
  }

  /**
   * Update an existing employee record.
   */
  async updateEmployee(employeeId: string, updates: Partial<EmployeeRecord>): Promise<EmployeeRecord | null> {
    const existing = await this.getEmployee(employeeId);
    if (!existing) {
      return null;
    }
    const targetId = existing.id;
    await employeesCol.doc(targetId).update(updates);
    const updated = await this.getEmployee(targetId);
    return updated;
  }

  /**
   * Validate if an employee ID or record exists in the system.
   */
  async validateEmployeeExists(employeeId: string): Promise<boolean> {
    const emp = await this.getEmployee(employeeId);
    return emp !== null;
  }
}

export const employeeService = new EmployeeService();
export default employeeService;
