// Legend: color ramp with numeric labels for the current mode, plus the non-color marks.
import type { ReactNode } from "react";
import { HATCH_LINE, HatchPattern } from "./calendar-hatch";
import { Z_UNAVAILABLE_FILL, type ColorScale } from "./calendar-scales";

const RAMP_W = 240;
const RAMP_H = 10;
const STOPS = 16;

export function CalendarLegend({ scale, idPrefix }: { scale: ColorScale; idPrefix: string }) {
  const gradId = `${idPrefix}-legend-grad-${scale.mode}`;
  const hatchId = `${idPrefix}-legend-hatch`;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <figure className="flex flex-col gap-1">
        <figcaption className="text-muted-foreground">{scale.title}</figcaption>
        <svg
          viewBox={`0 0 ${RAMP_W + 24} ${RAMP_H + 16}`}
          className="text-foreground h-auto w-full max-w-[300px]"
          role="img"
          aria-label={`${scale.title}. Scale marks: ${scale.ticks.map((t) => t.label).join(", ")}`}
        >
          <defs>
            <linearGradient id={gradId}>
              {Array.from({ length: STOPS + 1 }, (_, i) => (
                <stop key={i} offset={`${(i / STOPS) * 100}%`} stopColor={scale.ramp(i / STOPS)} />
              ))}
            </linearGradient>
          </defs>
          <rect x={12} y={0} width={RAMP_W} height={RAMP_H} fill={`url(#${gradId})`} />
          {scale.ticks.map((t) => (
            <g key={t.label} transform={`translate(${12 + t.position * RAMP_W},0)`}>
              <line y1={RAMP_H} y2={RAMP_H + 3} stroke="currentColor" />
              <text y={RAMP_H + 12} textAnchor="middle" fontSize={8} fill="currentColor">
                {t.label}
              </text>
            </g>
          ))}
        </svg>
      </figure>
      <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1" aria-label="Marks">
        <LegendItem label="No satellite data">
          <defs>
            <HatchPattern id={hatchId} />
          </defs>
          <rect x={1} y={1} width={18} height={12} fill={`url(#${hatchId})`} stroke={HATCH_LINE} strokeWidth={0.75} />
        </LegendItem>
        {scale.mode === "anomaly" && (
          <>
            <LegendItem label="z not available">
              <rect x={1} y={1} width={18} height={12} fill={Z_UNAVAILABLE_FILL} />
            </LegendItem>
            <LegendItem label="|z| at least 2">
              <text x={10} y={10} textAnchor="middle" fontSize={9} fill="currentColor">
                {"▲▼"}
              </text>
            </LegendItem>
          </>
        )}
        <LegendItem label="Provisional">
          <rect x={1.5} y={1.5} width={17} height={11} fill="none" stroke="currentColor" strokeWidth={1.2} strokeDasharray="1.5 1.5" />
        </LegendItem>
        <LegendItem label="Partial month">
          <rect x={1} y={1} width={18} height={12} fill="none" stroke="currentColor" strokeWidth={0.5} />
          <path d="M11,1 L19,1 L19,9 Z" fill="currentColor" />
        </LegendItem>
        <LegendItem label="Referenced by analyst">
          <rect x={1.5} y={1.5} width={17} height={11} rx={2} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="3 2" />
        </LegendItem>
        <LegendItem label="Selected">
          <rect x={1.5} y={1.5} width={17} height={11} rx={2} fill="none" stroke="currentColor" strokeWidth={2.5} />
        </LegendItem>
      </ul>
    </div>
  );
}

function LegendItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      <svg viewBox="0 0 20 14" width={20} height={14} aria-hidden="true" className="text-foreground">
        {children}
      </svg>
      <span>{label}</span>
    </li>
  );
}
