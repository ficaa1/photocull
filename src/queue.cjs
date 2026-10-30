class PriorityQueue {
  constructor(concurrency = 3) {
    this.concurrency = concurrency;
    this.running = 0;
    this.pending = [];
    this.jobs = new Map();
    this.idleWaiters = [];
  }

  add(key, priority, work) {
    const existing = this.jobs.get(key);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
      return existing.promise;
    }
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { key, priority, work, promise, resolve, reject };
    this.jobs.set(key, job);
    this.pending.push(job);
    this.drain();
    return promise;
  }

  drain() {
    while (this.running < this.concurrency && this.pending.length) {
      this.pending.sort((a, b) => b.priority - a.priority);
      const job = this.pending.shift();
      this.running++;
      Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => {
        this.jobs.delete(job.key);
        this.running--;
        this.drain();
        if (!this.running && !this.pending.length) this.idleWaiters.splice(0).forEach(resolve => resolve());
      });
    }
  }

  cancelWhere(predicate) {
    const canceled = this.pending.filter(predicate);
    this.pending = this.pending.filter(job => !predicate(job));
    for (const job of canceled) {
      this.jobs.delete(job.key);
      job.reject(Object.assign(new Error('Preview superseded by navigation.'), { code: 'CANCELED' }));
    }
    if (!this.running && !this.pending.length) this.idleWaiters.splice(0).forEach(resolve => resolve());
  }

  idle() { return !this.running && !this.pending.length ? Promise.resolve() : new Promise(resolve => this.idleWaiters.push(resolve)); }
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const result = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      result[i] = await fn(items[i], i);
    }
  }));
  return result;
}

module.exports = { PriorityQueue, mapLimit };
