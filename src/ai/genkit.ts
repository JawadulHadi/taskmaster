import { genkit } from "genkit";
import { googleAI } from "@genkit-ai/google-genai";

// Direct Gemini API call — NOT OpenRouter. Satisfies hackathon rule:
// "must call Gemini 3.5+ via Gemini API or Vertex AI directly."
export const ai = genkit({
  plugins: [googleAI()], // reads GEMINI_API_KEY from env
  model: googleAI.model("gemini-3.5-flash"),
});
