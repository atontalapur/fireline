import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { dataFile, publicDataBaseUrl } from "@/lib/data-dir";
import { REGION_PRESETS } from "@/lib/geo";
import { loadValidation, readMethodDoc } from "@/lib/method/load";
import { MethodDoc } from "./method-doc";
import { ValidationView } from "./validation-table";

export const metadata: Metadata = {
  title: "Method and validation | Fireline",
  description: "How Fireline harmonizes MODIS and VIIRS fire detections, and how well it works per region.",
};

// METHOD.md is read synchronously, so it lands in the static shell at build time (the Docker
// build stage copies docs/). Kept as its own component, not in the page body, so a request-time
// resume of the validation section never re-reads it from the runtime image, which has no docs/.
function MethodDocSection() {
  return <MethodDoc markdown={readMethodDoc()} />;
}

// validation.json and DATA_BUCKET are read per request, so the deployed data dir and bucket
// are used rather than whatever was present at build time.
async function ValidationSection() {
  await connection();
  const result = await loadValidation(dataFile("validation.json"));
  return <ValidationView result={result} presets={REGION_PRESETS} baseUrl={publicDataBaseUrl()} />;
}

export default function MethodPage() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
      <p className="mb-4 text-sm">
        <a href="#validation" className="underline underline-offset-2">
          Jump to the validation table
        </a>
      </p>
      <article>
        <MethodDocSection />
      </article>
      <section id="validation" aria-labelledby="validation-heading" className="mt-10 scroll-mt-4">
        <h2 id="validation-heading" className="mb-3 text-xl font-semibold">
          Validation by region
        </h2>
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading validation metrics...</p>}>
          <ValidationSection />
        </Suspense>
      </section>
    </main>
  );
}
