import { randomUUID } from 'node:crypto';
import { validResearchActivity, type ResearchActivity } from './research-protocol.mjs';

const MAX_EVENTS = 256;
const MAX_BYTES = 256_000;
interface QueuedEvent { event: ResearchActivity; bytes: number }

/** Acknowledgements remove only entries captured by a successfully delivered poll. */
export class ResearchEventBuffer {
  private entries: QueuedEvent[] = [];
  private bytes = 0;
  private truncationId: string | undefined;

  get length(): number { return this.entries.length; }

  append(event: ResearchActivity, secret: string): void {
    if (!validResearchActivity(event)) return;
    const encoded = JSON.stringify(event);
    if (encoded.includes(secret) || this.entries.some(item => item.event.id === event.id)) return;
    const bytes = Buffer.byteLength(encoded, 'utf8');
    // Reserve room for one explicit truncation marker, retaining older events.
    if (this.entries.length >= MAX_EVENTS - 1 || this.bytes + bytes > MAX_BYTES - 1_024) {
      if (!this.truncationId) {
        const marker: ResearchActivity = { id: `truncated:${randomUUID()}`, kind: 'summary', status: 'unavailable',
          at: new Date().toISOString(), summary: 'Some activity was omitted because the desktop event buffer reached its limit.' };
        const markerBytes = Buffer.byteLength(JSON.stringify(marker), 'utf8');
        this.truncationId = marker.id; this.entries.push({ event: marker, bytes: markerBytes }); this.bytes += markerBytes;
      }
      return;
    }
    // Copy the callback input so later mutation cannot alter an in-flight snapshot.
    this.entries.push({ event: JSON.parse(encoded) as ResearchActivity, bytes }); this.bytes += bytes;
  }

  snapshot(): ResearchActivity[] { return this.entries.slice(0, 32).map(item => item.event); }

  acknowledge(events: ResearchActivity[]): void {
    const ids = new Set(events.map(event => event.id));
    this.entries = this.entries.filter(item => {
      if (!ids.has(item.event.id)) return true;
      this.bytes -= item.bytes; return false;
    });
    if (this.truncationId && ids.has(this.truncationId)) this.truncationId = undefined;
  }
}
