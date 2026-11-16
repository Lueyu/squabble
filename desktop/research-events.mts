/**
 * research-events.mts — 研究活动事件缓冲：把本机 CLI 产生的事件攒成批次回传 broker。
 *
 * 职责边界：
 *  - ResearchEventBuffer 按事件 id 去重、做容量截断保护（上限 256 条 / 256KB，超限插入一条
 *    truncated 摘要标记并保留更早的事件），并按 broker 已成功送达的 poll 批次做 acknowledge 清理。
 * 上下游：
 *  - 上游（谁调用）：desktop/companion.mts 在任务执行期间 append 事件、poll 成功后 acknowledge；
 *    desktop/companion.integration.spec.ts 覆盖其行为。
 *  - 下游：无（纯内存缓冲，不做任何 I/O）。
 * 关键约定：
 *  - 入队前会检查事件序列化结果是否包含配对 token，防止凭据经事件流外泄。
 */
import { randomUUID } from 'node:crypto';
import { validResearchActivity, type ResearchActivity } from './research-protocol.mjs';

const MAX_EVENTS = 256;
const MAX_BYTES = 256_000;
interface QueuedEvent {
  event: ResearchActivity;
  bytes: number;
}

/** 只有随成功送达的 poll 一并被捕获的条目，才会在 acknowledge 时移除。 */
export class ResearchEventBuffer {
  private entries: QueuedEvent[] = [];
  private bytes = 0;
  private truncationId: string | undefined;

  get length(): number {
    return this.entries.length;
  }

  append(event: ResearchActivity, secret: string): void {
    if (!validResearchActivity(event)) return;
    const encoded = JSON.stringify(event);
    if (encoded.includes(secret) || this.entries.some((item) => item.event.id === event.id)) return;
    const bytes = Buffer.byteLength(encoded, 'utf8');
    // Reserve room for one explicit truncation marker, retaining older events.
    if (this.entries.length >= MAX_EVENTS - 1 || this.bytes + bytes > MAX_BYTES - 1_024) {
      if (!this.truncationId) {
        const marker: ResearchActivity = {
          id: `truncated:${randomUUID()}`,
          kind: 'summary',
          status: 'unavailable',
          at: new Date().toISOString(),
          summary: 'Some activity was omitted because the desktop event buffer reached its limit.',
        };
        const markerBytes = Buffer.byteLength(JSON.stringify(marker), 'utf8');
        this.truncationId = marker.id;
        this.entries.push({ event: marker, bytes: markerBytes });
        this.bytes += markerBytes;
      }
      return;
    }
    // Copy the callback input so later mutation cannot alter an in-flight snapshot.
    this.entries.push({ event: JSON.parse(encoded) as ResearchActivity, bytes });
    this.bytes += bytes;
  }

  snapshot(): ResearchActivity[] {
    return this.entries.slice(0, 32).map((item) => item.event);
  }

  acknowledge(events: ResearchActivity[]): void {
    const ids = new Set(events.map((event) => event.id));
    this.entries = this.entries.filter((item) => {
      if (!ids.has(item.event.id)) return true;
      this.bytes -= item.bytes;
      return false;
    });
    if (this.truncationId && ids.has(this.truncationId)) this.truncationId = undefined;
  }
}
