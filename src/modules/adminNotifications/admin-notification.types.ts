export type AdminNotificationCategory =
  | 'EXAM_START'
  | 'EXAM_FINISH'
  | 'CHEATING'
  | 'INQUIRY'
  | 'INQUIRY_REPLY'
  | 'GRADING'
  | 'REGISTRATION';

export type AdminNotificationSeverity = 'INFO' | 'MEDIUM' | 'HIGH';

export interface AdminNotification {
  id: string;
  category: AdminNotificationCategory;
  titleKo: string;
  titleEn: string;
  bodyKo: string;
  bodyEn: string;
  severity: AdminNotificationSeverity;
  href?: string;
  meta?: Record<string, unknown>;
  ts: number;
}

export interface AdminNotificationPreferences {
  examStart: boolean;
  examFinish: boolean;
  cheating: boolean;
  inquiry: boolean;
  inquiryReply: boolean;
  grading: boolean;
  registration: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: AdminNotificationPreferences = {
  examStart: true,
  examFinish: true,
  cheating: true,
  inquiry: true,
  inquiryReply: true,
  grading: true,
  registration: false,
};

export const PREFERENCE_KEY_BY_CATEGORY: Record<
  AdminNotificationCategory,
  keyof AdminNotificationPreferences
> = {
  EXAM_START: 'examStart',
  EXAM_FINISH: 'examFinish',
  CHEATING: 'cheating',
  INQUIRY: 'inquiry',
  INQUIRY_REPLY: 'inquiryReply',
  GRADING: 'grading',
  REGISTRATION: 'registration',
};
