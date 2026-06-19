/** Ejecuta fn(item, index) en paralelo con límite de concurrencia. */
export function hardwareThreads() {
  return typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
}

/** Hilos lógicos para lecturas concurrentes (FSA / fetch). */
export function ioConcurrency() {
  const cores = hardwareThreads();
  return Math.min(64, Math.max(32, cores * 4));
}

export async function runInParallel(items, fn, concurrency = 16) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
