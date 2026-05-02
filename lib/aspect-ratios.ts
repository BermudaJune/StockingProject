export const MAIN_ASPECT_RATIOS = [
  "auto",
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "5:4",
  "4:5",
  "21:9"
] as const;

export type MainAspectRatio = (typeof MAIN_ASPECT_RATIOS)[number];

export const VARIANT_ASPECT_RATIO = "3:4";
