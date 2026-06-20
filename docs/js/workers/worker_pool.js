/** Pool reutilizable de Web Workers con cola de tareas. */
import { hardwareThreads } from "../parallel.js?v=40";

export function defaultPoolSize() {
  const cores = hardwareThreads();
  return Math.max(2, Math.min(16, cores - 1));
}

export function isWorkerSupported() {
  return typeof Worker !== "undefined" && typeof URL !== "undefined";
}

export class WorkerPool {
  constructor(workerUrl, size = defaultPoolSize()) {
    this.workerUrl = workerUrl;
    this.size = size;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 0;
    this.failed = false;
  }

  init() {
    for (let i = 0; i < this.size; i += 1) {
      const w = new Worker(this.workerUrl, { type: "module" });
      w.onmessage = (ev) => this._onMessage(w, ev);
      w.onerror = (err) => this._onWorkerError(w, err);
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  _onMessage(worker, ev) {
    const { id, error, ...result } = ev.data ?? {};
    const entry = this.pending.get(id);
    if (!entry || entry.worker !== worker) return;
    this.pending.delete(id);
    this.idle.push(worker);
    if (error) entry.reject(new Error(error));
    else entry.resolve(result);
    this._pump();
  }

  _onWorkerError(worker, err) {
    for (const [id, entry] of this.pending) {
      if (entry.worker !== worker) continue;
      this.pending.delete(id);
      entry.reject(err);
      break;
    }
    this.idle.push(worker);
    this._pump();
  }

  _pump() {
    if (this.failed) return;
    while (this.queue.length && this.idle.length) {
      const task = this.queue.shift();
      const worker = this.idle.pop();
      const id = this.nextId;
      this.nextId += 1;
      this.pending.set(id, {
        resolve: task.resolve,
        reject: task.reject,
        worker,
      });
      worker.postMessage({ id, ...task.payload });
    }
  }

  run(payload) {
    if (this.failed) {
      return Promise.reject(new Error("Worker pool failed"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });
      this._pump();
    });
  }

  async runAll(tasks) {
    return Promise.all(tasks.map((payload) => this.run(payload)));
  }

  terminate() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
    for (const [, entry] of this.pending) {
      entry.reject(new Error("Worker pool terminated"));
    }
    this.pending.clear();
  }
}

/** @returns {WorkerPool | null} */
export function createMapWorkerPool() {
  if (!isWorkerSupported()) return null;
  try {
    const url = new URL("./map_worker.js", import.meta.url);
    const pool = new WorkerPool(url, defaultPoolSize());
    pool.init();
    return pool;
  } catch {
    return null;
  }
}
