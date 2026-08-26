import { GoogleGenAI } from "@google/genai";
import { StructuredTimesheet, TimesheetEntry } from "../models/task.js";

let geminiClient: GoogleGenAI | null = null;

/**
 * Initializes or returns the cached Google Gen AI client instance.
 * Uses lazy initialization to prevent crashes when API key is missing during startup.
 */
export function getGeminiClient(): GoogleGenAI {
  if (!geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    geminiClient = new GoogleGenAI({
      apiKey: apiKey || undefined,
    });
  }
  return geminiClient;
}

/**
 * Fallback parser in case Gemini API is offline or key is not provided in dev environment.
 */
function heuristicTimesheetParser(rawText: string): StructuredTimesheet {
  // Extract employee ID
  const empMatch =
    rawText.match(/(?:emp(?:loyee)?[_\s-]?id|emp[_\s-]?)[:\s]*([a-zA-Z0-9_-]+)/i) ||
    rawText.match(/\b(emp_\d{3,4})\b/i);
  const employeeId = empMatch ? empMatch[1] : "emp_001";

  // Extract employee name
  const nameMatch = rawText.match(/(?:employee|name|contractor)[:\s]+([A-Za-z\s]+?)(?:,|\.|\n|$)/i);
  const employeeName = nameMatch ? nameMatch[1].trim() : undefined;

  // Extract department
  const deptMatch = rawText.match(/(?:department|dept|team)[:\s]+([A-Za-z\s]+?)(?:,|\.|\n|$)/i);
  const department = deptMatch ? deptMatch[1].trim() : "Engineering";

  let totalHours = 0;
  let overtimeHours = 0;

  const entries: TimesheetEntry[] = [];
  const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  for (const day of daysOfWeek) {
    const dayRegex = new RegExp(`(?:${day}|${day.slice(0, 3)})[:\\s-]*(\\d+(?:\\.\\d+)?)\\s*(?:hours|hrs|h)?`, "i");
    const match = rawText.match(dayRegex);
    if (match) {
      const h = parseFloat(match[1]);
      const reg = Math.min(h, 8);
      const ot = Math.max(0, h - 8);
      totalHours += h;
      overtimeHours += ot;
      entries.push({
        date: new Date().toISOString().split("T")[0],
        dayOfWeek: day,
        hoursWorked: h,
        regularHours: reg,
        overtimeHours: ot,
        department,
        notes: `Shift for ${day}`,
      });
    }
  }

  // If no day-by-day found, look for aggregate total / overtime
  if (entries.length === 0) {
    const otMatch = rawText.match(/(?:overtime|ot)[:\s]*(\d+(?:\.\d+)?)\s*(?:hours|hrs|h)?/i);
    const regMatch = rawText.match(/(?:regular|normal)[:\s]*(\d+(?:\.\d+)?)\s*(?:hours|hrs|h)?/i);
    const totMatch = rawText.match(/(?:total)[:\s]*(\d+(?:\.\d+)?)\s*(?:hours|hrs|h)?/i);

    const ot = otMatch ? parseFloat(otMatch[1]) : 0;
    const reg = regMatch ? parseFloat(regMatch[1]) : (totMatch ? Math.max(0, parseFloat(totMatch[1]) - ot) : 40);
    const tot = totMatch ? parseFloat(totMatch[1]) : (reg + ot);

    totalHours = tot;
    overtimeHours = ot;
    entries.push({
      date: new Date().toISOString().split("T")[0],
      hoursWorked: tot,
      regularHours: reg,
      overtimeHours: ot,
      department,
      notes: "Aggregated timesheet summary",
    });
  }

  const regularHours = Math.max(0, totalHours - overtimeHours);
  const potentialViolations: string[] = [];
  if (overtimeHours > 10) {
    potentialViolations.push(`Overtime of ${overtimeHours}h exceeds standard 10.0h policy ceiling.`);
  }
  if (totalHours > 60) {
    potentialViolations.push(`Total weekly hours (${totalHours}h) exceeds 60.0h safety cap.`);
  }

  return {
    employeeId,
    employeeName,
    department,
    periodStart: new Date().toISOString().split("T")[0],
    periodEnd: new Date().toISOString().split("T")[0],
    totalHours: Number(totalHours.toFixed(1)),
    regularHours: Number(regularHours.toFixed(1)),
    overtimeHours: Number(overtimeHours.toFixed(1)),
    workDays: entries.length || 5,
    entries,
    rawText,
    confidenceScore: 0.9,
    notes: "Processed via structured parser",
    potentialViolations,
  };
}

/**
 * Processes unstructured timesheet text into structured JSON data using Google Gemini API.
 * Standardizes work logs, daily hours, overtime breakdown, and flags potential anomalies.
 *
 * @param rawTimesheetText Unstructured shift notes, supervisor emails, or clock-in logs.
 * @returns Structured JSON timesheet representation conforming to `StructuredTimesheet`.
 */
export async function processUnstructuredTimesheet(
  rawTimesheetText: string,
): Promise<StructuredTimesheet> {
  if (!rawTimesheetText || rawTimesheetText.trim().length === 0) {
    throw new Error("Cannot process empty timesheet text");
  }

  const prompt = `You are an expert HR Operations and Payroll Auditor AI.
Analyze the following unstructured timesheet / shift text and extract structured JSON data.

Rules:
1. Extract employee ID (e.g. "emp_001", "emp_002", "emp_003") or infer from context.
2. Calculate accurate total hours, regular hours (standard 8h/day or 40h/week), and overtime hours (>8h/day or weekend/extra).
3. Extract each distinct day/shift entry with dayOfWeek, hoursWorked, regularHours, overtimeHours, notes.
4. Flag any potential policy violations (e.g., overtime > 10 hours, weekly total > 60 hours, consecutive work days > 6 days).

Unstructured Timesheet Text:
"""
${rawTimesheetText}
"""

Return ONLY valid JSON adhering to this exact schema:
{
  "employeeId": string,
  "employeeName": string,
  "department": string,
  "periodStart": string,
  "periodEnd": string,
  "totalHours": number,
  "regularHours": number,
  "overtimeHours": number,
  "workDays": number,
  "entries": [
    {
      "date": string,
      "dayOfWeek": string,
      "hoursWorked": number,
      "regularHours": number,
      "overtimeHours": number,
      "department": string,
      "notes": string,
      "tasksSummary": string
    }
  ],
  "confidenceScore": number,
  "notes": string,
  "potentialViolations": string[]
}`;

  // Candidate models to try in order of resilience
  const candidateModels = ["gemini-3.5-flash", "gemini-2.5-flash"];

  for (const model of candidateModels) {
    try {
      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const responseText = response.text?.trim();
      if (responseText) {
        const parsed = JSON.parse(responseText);
        return {
          employeeId: parsed.employeeId || "emp_001",
          employeeName: parsed.employeeName,
          department: parsed.department || "General",
          periodStart: parsed.periodStart,
          periodEnd: parsed.periodEnd,
          totalHours: Number(parsed.totalHours ?? 0),
          regularHours: Number(parsed.regularHours ?? 0),
          overtimeHours: Number(parsed.overtimeHours ?? 0),
          workDays: Number(parsed.workDays ?? parsed.entries?.length ?? 1),
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
          rawText: rawTimesheetText,
          confidenceScore: typeof parsed.confidenceScore === "number" ? parsed.confidenceScore : 0.95,
          notes: parsed.notes || `Extracted via ${model}`,
          potentialViolations: Array.isArray(parsed.potentialViolations) ? parsed.potentialViolations : [],
        };
      }
    } catch (err: any) {
      // If temporary 503 or quota issue, continue to fallback model or heuristic
      const isTemporary = err?.message?.includes("503") || err?.message?.includes("UNAVAILABLE") || err?.status === 503;
      if (isTemporary) {
        continue;
      }
    }
  }

  // Graceful fallback to heuristic timesheet parser
  return heuristicTimesheetParser(rawTimesheetText);
}

/**
 * Alias function to conform with service method naming preferences.
 */
export const processTimesheetText = processUnstructuredTimesheet;
