import {
  METRICS,
  figureList,
  formatPlacebo,
  regionColumns,
  type ValidationLoad,
} from "@/lib/method/validation";

type Preset = { key: string; name: string };

export function ValidationView({
  result,
  presets,
  baseUrl,
}: {
  result: ValidationLoad;
  presets: readonly Preset[];
  baseUrl: string | null;
}) {
  if (result.status === "missing")
    return <p className="text-sm text-muted-foreground">Validation metrics are not published yet.</p>;
  if (result.status === "invalid")
    return (
      <p className="text-sm text-muted-foreground">
        Validation metrics could not be read ({result.error}).
      </p>
    );

  const { data, mock } = result;
  const columns = regionColumns(data, presets);
  const figures = columns
    .map((c) => ({ ...c, list: figureList(c.metrics.figures, baseUrl) }))
    .filter((c) => c.list.length > 0);

  return (
    <>
      {mock && (
        <p className="mb-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm" role="note">
          Mock data: these numbers are illustrative placeholders, not results from the pipeline.
        </p>
      )}
      {columns.length === 0 ? (
        <p className="text-sm text-muted-foreground">No regions in validation.json.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="mb-2 text-left text-muted-foreground">
              Harmonization metrics per region, method version {data.method_version}
              {mock ? " (mock data)" : ""}. n/a means the metric could not be computed.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="border-b px-2 py-1.5 text-left font-medium">Metric</th>
                <th scope="col" className="border-b px-2 py-1.5 text-left font-medium">Expected</th>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className="border-b px-2 py-1.5 text-right font-medium">
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {METRICS.map((m) => (
                <tr key={m.key}>
                  <th scope="row" className="border-b px-2 py-1.5 text-left font-normal">{m.label}</th>
                  <td className="border-b px-2 py-1.5 text-muted-foreground">{m.expected}</td>
                  {columns.map((c) => (
                    <td key={c.key} className="border-b px-2 py-1.5 text-right tabular-nums">
                      {m.format(c.metrics[m.key])}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <th scope="row" className="border-b px-2 py-1.5 text-left font-normal">
                  Placebo seam ratios (change-point p)
                </th>
                <td className="border-b px-2 py-1.5 text-muted-foreground">close to 1x, p above 0.05</td>
                {columns.map((c) => (
                  <td key={c.key} className="border-b px-2 py-1.5 text-right tabular-nums">
                    {formatPlacebo(c.metrics.placebo)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {figures.map((c) => (
        <figure key={c.key} className="mt-6">
          <figcaption className="mb-2 font-medium">{c.name}</figcaption>
          <div className="grid gap-4 sm:grid-cols-2">
            {c.list.map((f) => (
              // Remote bucket images of unknown size; next/image would need remotePatterns config.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={f.name}
                src={f.src}
                alt={`${f.label}, ${c.name}`}
                loading="lazy"
                className="w-full rounded-md border"
              />
            ))}
          </div>
        </figure>
      ))}
    </>
  );
}
