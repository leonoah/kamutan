/** Loading of the Sprint-2 understanding artifacts (no app imports: shared by the client and the mock backend). */
const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes as BodyInit).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Fetch one understanding artifact (kamutan.legend/1 | detections/1 | rooms/1). Storage objects are gzip JSON:
 * when the server did not set Content-Encoding (raw .gz bytes, magic 1f 8b), we gunzip here.
 */
export async function fetchArtifact<T extends { schema: string }>(url: string, schema: T["schema"], signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`artifact HTTP ${res.status}`);
  let bytes: Uint8Array = new Uint8Array(await res.arrayBuffer());
  if (isGzip(bytes)) bytes = await gunzip(bytes);
  const doc = JSON.parse(new TextDecoder().decode(bytes)) as T;
  if (doc?.schema !== schema) throw new Error(`unexpected artifact schema ${String(doc?.schema)}`);
  return doc;
}

