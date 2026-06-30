import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../../integrations/redis/redis.service';
import { AdminMonitorGateway } from '../adminMonitor/admin-monitor.gateway';
import type { AdminAiAlertPayload } from '../../websocket/admin.gateway';
import {
  AdminNotification,
  AdminNotificationCategory,
  AdminNotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
  PREFERENCE_KEY_BY_CATEGORY,
} from './admin-notification.types';

const PREFS_KEY = 'admin:notif:prefs';
const INBOX_KEY = 'admin:notif:inbox';
const READ_KEY = (userId: string): string => `admin:notif:read:${userId}`;
const INBOX_MAX = 200;
const INBOX_TTL_SEC = 7 * 24 * 60 * 60;
const AI_ALERT_CHANNEL = 'proctor:ai-alert';

export interface NotifyInput {
  category: AdminNotificationCategory;
  titleKo: string;
  titleEn: string;
  bodyKo: string;
  bodyEn: string;
  severity?: AdminNotification['severity'];
  href?: string;
  meta?: Record<string, unknown>;
}

@Injectable()
export class AdminNotificationsService implements OnModuleInit {
  private readonly logger = new Logger(AdminNotificationsService.name);

  constructor(
    private readonly redis: RedisService,
    @Inject(forwardRef(() => AdminMonitorGateway))
    private readonly adminMonitor: AdminMonitorGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.redis.subscribe(AI_ALERT_CHANNEL, (msg) => {
      void this.handleAiAlert(msg);
    });
  }

  async getPreferences(): Promise<AdminNotificationPreferences> {
    const raw = await this.redis.get(PREFS_KEY);
    if (!raw) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    try {
      return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    }
  }

  async updatePreferences(
    patch: Partial<AdminNotificationPreferences>,
  ): Promise<AdminNotificationPreferences> {
    const current = await this.getPreferences();
    const next = { ...current, ...patch };
    await this.redis.set(PREFS_KEY, JSON.stringify(next));
    return next;
  }

  async listInbox(
    userId: string,
    limit = 50,
  ): Promise<{ items: (AdminNotification & { read: boolean })[]; unreadCount: number }> {
    const [rawItems, readIds] = await Promise.all([
      this.redis.lrange(INBOX_KEY, 0, Math.min(limit, INBOX_MAX) - 1),
      this.getReadIds(userId),
    ]);

    const items = rawItems
      .map((raw) => this.parseNotification(raw))
      .filter((n): n is AdminNotification => n != null);

    const enriched = items.map((item) => ({
      ...item,
      read: readIds.has(item.id),
    }));

    const unreadCount = enriched.filter((i) => !i.read).length;
    return { items: enriched, unreadCount };
  }

  async unreadCount(userId: string): Promise<number> {
    const { unreadCount } = await this.listInbox(userId, INBOX_MAX);
    return unreadCount;
  }

  async markRead(userId: string, notificationId: string): Promise<void> {
    const readIds = await this.getReadIds(userId);
    readIds.add(notificationId);
    await this.redis.set(READ_KEY(userId), JSON.stringify([...readIds]), INBOX_TTL_SEC);
  }

  async markAllRead(userId: string): Promise<void> {
    const rawItems = await this.redis.lrange(INBOX_KEY, 0, INBOX_MAX - 1);
    const ids = rawItems
      .map((raw) => this.parseNotification(raw)?.id)
      .filter((id): id is string => !!id);
    await this.redis.set(READ_KEY(userId), JSON.stringify(ids), INBOX_TTL_SEC);
  }

  async notify(input: NotifyInput): Promise<AdminNotification | null> {
    const prefs = await this.getPreferences();
    const prefKey = PREFERENCE_KEY_BY_CATEGORY[input.category];
    if (!prefs[prefKey]) return null;

    const notification: AdminNotification = {
      id: randomUUID(),
      category: input.category,
      titleKo: input.titleKo,
      titleEn: input.titleEn,
      bodyKo: input.bodyKo,
      bodyEn: input.bodyEn,
      severity: input.severity ?? 'INFO',
      href: input.href,
      meta: input.meta,
      ts: Date.now(),
    };

    await this.redis.lpushTrim(INBOX_KEY, JSON.stringify(notification), INBOX_MAX);
    await this.redis.set(`${INBOX_KEY}:touch`, String(notification.ts), INBOX_TTL_SEC);

    try {
      await this.adminMonitor.emitNotification(notification);
    } catch (err) {
      this.logger.warn(`emitNotification failed: ${(err as Error).message}`);
    }

    return notification;
  }

  private async handleAiAlert(message: string): Promise<void> {
    let payload: AdminAiAlertPayload;
    try {
      payload = JSON.parse(message) as AdminAiAlertPayload;
    } catch {
      return;
    }

    const severity =
      payload.severity === 'HIGH' ? 'HIGH' : payload.severity === 'MED' ? 'MEDIUM' : 'INFO';

    await this.notify({
      category: 'CHEATING',
      titleKo: '부정행위 의심 감지',
      titleEn: 'Cheating suspicion detected',
      bodyKo: payload.captionKo || 'AI 감독 시스템이 이상 행동을 감지했습니다.',
      bodyEn: payload.captionEn || 'AI proctor detected suspicious behavior.',
      severity,
      href: '/monitoring',
      meta: {
        sessionId: payload.sessionId,
        eventId: payload.eventId,
        type: payload.type,
        ruleBroken: payload.ruleBroken,
      },
    });
  }

  private async getReadIds(userId: string): Promise<Set<string>> {
    const raw = await this.redis.get(READ_KEY(userId));
    if (!raw) return new Set();
    try {
      const arr = JSON.parse(raw) as string[];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }

  private parseNotification(raw: string): AdminNotification | null {
    try {
      return JSON.parse(raw) as AdminNotification;
    } catch {
      return null;
    }
  }
}
