import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** tailwind-merge must know our custom font-size scale, otherwise `text-meta` and
 *  `text-foreground` are treated as the same (color) group and one gets dropped. */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["meta", "dense", "body", "panel", "screen", "hero"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
