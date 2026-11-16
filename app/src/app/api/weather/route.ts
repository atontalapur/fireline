import { z } from "zod";
import { RegionKey } from "@/lib/contracts";
import { getWeather } from "@/lib/weather/query";

const Query = z.object({
  region: RegionKey,
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM")
    .nullable(),
});

// GET /api/weather?region=<key>&month=YYYY-MM. Month defaults to the latest in the file.
// 404 when weather.parquet is absent (it is optional) or has no rows for the region-month.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsed = Query.safeParse({
    region: params.get("region"),
    month: params.get("month") || null,
  });
  if (!parsed.success) {
    const error = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return Response.json({ error }, { status: 400 });
  }

  const { region, month } = parsed.data;
  try {
    const weather = await getWeather(region, month);
    if (!weather) {
      const what = month ? `${region} ${month}` : region;
      return Response.json({ error: `no weather data for ${what}` }, { status: 404 });
    }
    return Response.json(weather);
  } catch (err) {
    console.error("weather query failed", err);
    return Response.json({ error: "weather query failed" }, { status: 500 });
  }
}
