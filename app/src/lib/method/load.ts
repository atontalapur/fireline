// File access for the method page (#22). Server only.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseValidation, type ValidationLoad } from "@/lib/method/validation";

/** docs/METHOD.md at the repo root. METHOD_DOC_PATH overrides it. */
export function methodDocPath(): string {
  return process.env.METHOD_DOC_PATH ?? path.resolve(process.cwd(), "..", "docs", "METHOD.md");
}

/** METHOD.md text, or null when the file is missing or empty. Synchronous so it prerenders. */
export function readMethodDoc(file: string = methodDocPath()): string | null {
  try {
    const text = readFileSync(/* turbopackIgnore: true */ file, "utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

export async function loadValidation(file: string): Promise<ValidationLoad> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "invalid", error: (e as Error).message };
  }
  return parseValidation(text);
}
