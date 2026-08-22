/** Reuse the battery's already-reachable SPA server. When a visual probe is
 * run standalone, start its private server and return an ownership-aware
 * closer instead. */
export async function ensureProbeServer({ base, server, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(base, { cache: 'no-store' });
    if (response.ok) return null;
  } catch {
    // No shared server: the standalone probe owns the listener below.
  }

  const { port } = new URL(base);
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(Number(port), '127.0.0.1', () => {
      server.off('error', onError);
      resolve(undefined);
    });
  });
  return () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
