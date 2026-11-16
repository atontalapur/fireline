// Gemini on Vertex AI. Auth is Application Default Credentials (the Cloud Run service account in
// production, `gcloud auth application-default login` locally).
import { createVertex } from "@ai-sdk/google-vertex";
import type { LanguageModel } from "ai";

let cached: { key: string; model: LanguageModel } | null = null;

/** The chat model, or null when no Google Cloud project is configured. */
export function getChatModel(): LanguageModel | null {
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_VERTEX_PROJECT;
  if (!project) return null;
  // Gemini 3.x is served from the global endpoint, not a region (see .env.example).
  const location = process.env.GEMINI_LOCATION || "global";
  const modelId = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const key = `${project}|${location}|${modelId}`;
  if (cached?.key !== key) cached = { key, model: createVertex({ project, location })(modelId) };
  return cached.model;
}
