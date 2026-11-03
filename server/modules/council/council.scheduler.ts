/** Single-process scheduler. SQL claims remain the authority for individual task attempts. */
interface Waiter { owner: string; session: string; connection?: string; limit: number; ready: () => Promise<boolean>;
  resolve: (release: (() => void) | null) => void; reject: (error: unknown) => void }
export class CouncilScheduler {
  private queue: Waiter[] = [];
  private active = new Map<string, { session: string; connection?: string }[]>();
  private lastSession = new Map<string, string>();
  private draining = false;
  private drainRequested = false;

  acquire(owner: string, session: string, connection: string | undefined, limit: number, ready: () => Promise<boolean>): Promise<(() => void) | null> {
    return new Promise((resolve, reject) => { this.queue.push({ owner, session, connection, limit, ready, resolve, reject }); void this.drain(); });
  }
  private async drain(): Promise<void> {
    if (this.draining) { this.drainRequested = true; return; }
    this.drainRequested = false;
    this.draining = true;
    try {
      // Prefer a different waiting session on each release, without starving a single session.
      this.queue.sort((a, b) => Number(this.lastSession.get(a.owner) === a.session) - Number(this.lastSession.get(b.owner) === b.session));
      for (let i = 0; i < this.queue.length;) {
        const waiter = this.queue[i];
        const active = this.active.get(waiter.owner) ?? [];
        if (active.length >= 2 || active.filter(a => a.session === waiter.session).length >= waiter.limit
          || (waiter.connection && active.some(a => a.connection === waiter.connection))) { i++; continue; }
        this.queue.splice(i, 1);
        try {
          if (!await waiter.ready()) { waiter.resolve(null); continue; }
          const lease = { session: waiter.session, connection: waiter.connection };
          active.push(lease); this.active.set(waiter.owner, active); this.lastSession.set(waiter.owner, waiter.session);
          let released = false;
          waiter.resolve(() => {
            if (released) return; released = true;
            const held = this.active.get(waiter.owner) ?? [];
            const index = held.indexOf(lease);
            if (index >= 0) held.splice(index, 1);
            void this.drain();
          });
        } catch (error) { waiter.reject(error); }
      }
    } finally { this.draining = false; if (this.drainRequested) void this.drain(); }
  }
}
