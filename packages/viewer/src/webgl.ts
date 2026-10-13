/** True when a WebGL2 context can be created (deck.gl 9 requires WebGL2). */
export function canUseWebGL(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2"));
  } catch {
    return false;
  }
}
