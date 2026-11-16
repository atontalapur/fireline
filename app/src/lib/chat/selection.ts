// Dashboard selection -> the compact context the chat sends with each question.
import type { AreaSelection } from "@/lib/contracts";
import { regionOfCells } from "@/lib/geo";
import { MAX_CHAT_CELLS, type ChatSelection } from "./types";

export function toChatSelection(selection: AreaSelection | null): ChatSelection | null {
  if (!selection) return null;
  const base = { label: selection.label.slice(0, 200), warnings: selection.warnings.slice(0, 20) };
  if (selection.region) {
    return { ...base, region: selection.region, cells: null, cell_count: selection.cells.length, approximate: false };
  }
  if (selection.cells.length <= MAX_CHAT_CELLS) {
    return { ...base, region: null, cells: selection.cells, cell_count: selection.cells.length, approximate: false };
  }
  // Too many cells to send with every question: stand in the preset that contains the area, if any.
  const { region, outside, mixed } = regionOfCells(selection.cells);
  return {
    ...base,
    region: region && !mixed && outside === 0 ? region : null,
    cells: null,
    cell_count: selection.cells.length,
    approximate: true,
  };
}

/** Stable cache key for a selection. */
export function selectionKey(selection: ChatSelection | null): string {
  if (!selection) return "none";
  if (selection.region) return `region:${selection.region}`;
  if (!selection.cells) return "none";
  let h = 0x811c9dc5;
  for (const c of selection.cells) {
    for (let i = 0; i < c.length; i++) h = Math.imul(h ^ c.charCodeAt(i), 0x01000193) >>> 0;
  }
  return `cells:${selection.cells.length}:${h.toString(16)}`;
}

/** Tool area arguments for a selection: { region } or { cells }, or null when it can't be queried. */
export function selectionArea(selection: ChatSelection | null): { region: string } | { cells: string[] } | null {
  if (!selection) return null;
  if (selection.region) return { region: selection.region };
  if (selection.cells && selection.cells.length > 0) return { cells: selection.cells };
  return null;
}
