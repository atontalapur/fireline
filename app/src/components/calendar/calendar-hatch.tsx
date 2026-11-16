// Gray hatch used for "no satellite data" months (distinct from a zero count).
export const HATCH_BG = "#e5e7eb";
export const HATCH_LINE = "#6b7280";

export function HatchPattern({ id }: { id: string }) {
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" width={5} height={5} patternTransform="rotate(45)">
      <rect width={5} height={5} fill={HATCH_BG} />
      <line x1={0} y1={0} x2={0} y2={5} stroke={HATCH_LINE} strokeWidth={2} />
    </pattern>
  );
}
