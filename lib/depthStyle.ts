const COLORS = ["#64748B", "#38BDF8", "#2DD4BF", "#A78BFA", "#FBBF24", "#FB923C", "#F472B6", "#A3E635"] as const;

const RESTING_ALPHA: Record<number, number> = { 1: 0.05, 2: 0.04, 3: 0.04 };

export function depthLook(depth: number): { color: string; width: number; dashed: boolean } {
  if (depth <= 0) return { color: COLORS[0], width: 2, dashed: false };
  const slot = ((depth - 1) % 7) + 1;
  return { color: COLORS[slot], width: 1, dashed: depth >= 5 };
}

export function restingFill(depth: number): string | undefined {
  const alpha = RESTING_ALPHA[depth];
  if (!alpha) return undefined;
  return rgba(depthLook(depth).color, alpha);
}

function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
