"use client";
// Stub. Replaced by #25 (AI analyst chat).
import type { AreaSelection } from "@/lib/contracts";

export type AnalystChatProps = {
  selection: AreaSelection | null;
  onHighlightMonths?: (months: string[]) => void;
};

export function AnalystChat(props: AnalystChatProps) {
  void props;
  return null;
}
