import { Dashboard } from "@/components/dashboard";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">Fire history on one consistent scale</h1>
      <p className="mt-1 mb-6 max-w-3xl text-muted-foreground">
        MODIS (2000-) and VIIRS (2012-) fire detections, harmonized into MODIS-equivalent fire
        cell-days. Pick an area to see each month since 2000 against its historical normal.
      </p>
      <Dashboard />
    </main>
  );
}
