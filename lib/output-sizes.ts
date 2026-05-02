export const OUTPUT_SIZES = ["1K", "2K", "4K"] as const;

export type OutputSize = (typeof OUTPUT_SIZES)[number];
