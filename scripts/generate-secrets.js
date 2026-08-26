import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Utility script to generate secure random API keys and bootstrap .env configuration
 * for the Taskmaster Genkit ADK Agentic Loops SDK.
 */
function generateSecrets() {
  console.log("🔐 Generating secure API keys and environment configuration...");

  const meiliApiKey = `masterKey_${randomBytes(16).toString("hex")}`;
  const sessionSecret = randomBytes(32).toString("hex");

  const envContent = `# =====================================================================
# Taskmaster Genkit ADK Agentic Loops SDK™ - Environment Configuration
# Generated automatically by scripts/generate-secrets.js
# =====================================================================

# Google Gemini API Key (Required for Genkit & Gemini 3.5 Flash)
GEMINI_API_KEY=your_gemini_api_key_here

# Meilisearch Audit Indexing Configuration
MEILI_URL=http://localhost:7700
MEILI_API_KEY=${meiliApiKey}

# Google Cloud Pub/Sub Configuration
PUBSUB_TOPIC=taskmaster-jobs
GOOGLE_CLOUD_PROJECT=taskmaster-agent-project

# Session & Security Secret
SESSION_SECRET=${sessionSecret}
`;

  const envPath = path.resolve(process.cwd(), ".env");
  const envExamplePath = path.resolve(process.cwd(), ".env.example");

  fs.writeFileSync(envPath, envContent, "utf8");
  console.log(`✅ Successfully generated and wrote configuration to ${envPath}`);

  if (!fs.existsSync(envExamplePath)) {
    fs.writeFileSync(envExamplePath, envContent, "utf8");
    console.log(`✅ Created reference template at ${envExamplePath}`);
  }

  console.log("\n🔑 Generated Keys Summary:");
  console.log(`- MEILI_API_KEY: ${meiliApiKey}`);
  console.log(`- SESSION_SECRET: ${sessionSecret.substring(0, 10)}...`);
  console.log("\nNext Steps:");
  console.log("1. Add your GEMINI_API_KEY to the .env file or AI Studio Secrets panel.");
  console.log("2. Run 'npm run dev' to start the application.");
}

generateSecrets();
