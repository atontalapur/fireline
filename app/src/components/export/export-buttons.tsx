"use client";
// CSV downloads (#21). Each button is a native form POST with the request JSON in a hidden
// `request` field, so the browser streams the file to disk using the server's filename.
import { Download } from "lucide-react";
import type { AreaSelection } from "@/lib/contracts";
import { seriesBody } from "@/lib/use-series";
import { Button } from "@/components/ui/button";

const EXPORTS = [
  { action: "/api/analytics.csv", label: "Monthly analytics CSV" },
  { action: "/api/hotspots.csv", label: "Hotspot detections CSV" },
] as const;

export function ExportButtons({ selection }: { selection: AreaSelection }) {
  const request = JSON.stringify(seriesBody(selection));
  return (
    <div className="flex flex-wrap gap-2">
      {EXPORTS.map((e) => (
        <form key={e.action} method="post" action={e.action}>
          <input type="hidden" name="request" value={request} />
          <Button type="submit" variant="outline" size="sm">
            <Download aria-hidden />
            {e.label}
          </Button>
        </form>
      ))}
    </div>
  );
}
