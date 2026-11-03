import { Injectable } from '@nestjs/common';
import { StrategyStore } from './strategy.store';
import { NotificationService } from '../notifications/notification.service';

/** Delivery has no dependency on execution; retrying a push can never re-run a trade. */
@Injectable()
export class StrategyNotificationsService {
  constructor(private readonly store: StrategyStore, private readonly notifications: NotificationService) {}
  async tick(): Promise<void> {
    for (const row of await this.store.claimNotifications()) {
      try {
        const result = await this.notifications.deliverWithAcknowledgment(row.owner, row.payload, row.deliveredChannelIds);
        await this.store.notificationResult(row.id, result.deliveredChannelIds, result.ok, row.attempts + 1);
      } catch {
        await this.store.notificationResult(row.id, row.deliveredChannelIds, false, row.attempts + 1);
      }
    }
  }
}
