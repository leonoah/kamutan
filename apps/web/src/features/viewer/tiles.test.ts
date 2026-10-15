import { createSignedTileResolver } from "./tiles";
import type { TileLevel } from "@/api/types";

const grid: TileLevel[] = [
  { z: 0, widthPx: 155, heightPx: 110, cols: 1, rows: 1, mmPerPx: 2.7 },
  { z: 5, widthPx: 4963, heightPx: 3509, cols: 20, rows: 14, mmPerPx: 0.08 },
];

describe("createSignedTileResolver (batched short-lived signed URLs)", () => {
  it("fetches a whole block once, shares in-flight calls and serves the rest from cache", async () => {
    const fetchWindow = vi.fn(async (q: { z: number; x0: number; x1: number; y0: number; y1: number }) => {
      const urls: Record<string, string> = {};
      for (let y = q.y0; y <= q.y1; y++) for (let x = q.x0; x <= q.x1; x++) urls[`${q.z}/${x}_${y}`] = `https://s/${q.z}/${x}_${y}?sig`;
      return { urls, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
    });
    const url = createSignedTileResolver(fetchWindow, grid, 64); // 8×8 blocks
    const [a, b] = await Promise.all([url(5, 1, 1), url(5, 7, 7)]);
    expect(a).toBe("https://s/5/1_1?sig");
    expect(b).toBe("https://s/5/7_7?sig");
    expect(fetchWindow).toHaveBeenCalledTimes(1);
    expect(fetchWindow).toHaveBeenCalledWith({ z: 5, x0: 0, x1: 7, y0: 0, y1: 7 });
    // last block is clamped to the level grid
    await url(5, 19, 13);
    expect(fetchWindow).toHaveBeenLastCalledWith({ z: 5, x0: 16, x1: 19, y0: 8, y1: 13 });
    // out of grid → null without a call
    expect(await url(5, 20, 0)).toBeNull();
    expect(fetchWindow).toHaveBeenCalledTimes(2);
  });

  it("re-signs when a cached URL is about to expire", async () => {
    let t = 1_000_000;
    const fetchWindow = vi.fn(async () => ({ urls: { "0/0_0": `https://s/0/0_0?t=${t}` }, expiresAt: new Date(t + 5 * 60_000).toISOString() }));
    const url = createSignedTileResolver(fetchWindow, grid, 256, () => t);
    expect(await url(0, 0, 0)).toBe("https://s/0/0_0?t=1000000");
    t += 3 * 60_000;
    await url(0, 0, 0);
    expect(fetchWindow).toHaveBeenCalledTimes(1);
    t += 90_000; // < 60 s left
    expect(await url(0, 0, 0)).toBe(`https://s/0/0_0?t=${t}`);
    expect(fetchWindow).toHaveBeenCalledTimes(2);
  });
});
