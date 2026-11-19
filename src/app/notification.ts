import { Injectable, inject, effect, signal, OnDestroy } from '@angular/core';
import { AppStore } from './store';
import { ClassSession, AppSettings, DEFAULT_SUBJECT_MAPPINGS } from './models';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications, PendingResult } from '@capacitor/local-notifications';
import { Device, DeviceInfo } from '@capacitor/device';
import {
  uploadDiagnosticLogs,
  requestFirebaseNotificationPermission,
  savePushSubscriptionObject,
  scheduleServerPushSnooze,
  sendServerTestPush,
} from './firebase-client';
import { formatDateYYYYMMDD, isSchoolHoliday } from './schedule-utils';

export interface AuditEvent {
  id: string;
  timestamp: string;
  title: string;
  state: 'created' | 'scheduled' | 'delivered' | 'displayed' | 'clicked' | 'missed';
  details: string;
}

export interface SystemLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  category: 'system' | 'notification' | 'sync' | 'alarm';
  message: string;
}

@Injectable({ providedIn: 'root' })
export class NotificationService implements OnDestroy {
  private store = inject(AppStore);
  private notifiedSet = new Set<string>();
  private checkIntervalId?: ReturnType<typeof setInterval>;
  private snoozeTimerId?: ReturnType<typeof setInterval>;
  private popupDismissTimer?: ReturnType<typeof setTimeout>;

  logs = signal<SystemLog[]>([]);
  exactAlarmPermission = signal<'granted' | 'denied' | 'unknown'>('unknown');
  scheduledCount = signal<number>(0);
  pendingAlarms = signal<PendingResult | null>(null);
  notificationsScheduled = signal<number>(0);
  notificationsFired = signal<number>(0);
  deviceInfo = signal<DeviceInfo | null>(null);
  auditLogs = signal<AuditEvent[]>([]);
  batteryOptimizationConfirmed = signal<boolean>(false);
  nextAlarm = signal<{ title: string; time: Date; subjectName: string } | null>(null);
  lastCheckedTime = signal<Date | null>(null);
  scheduleIntegrityScore = signal<number>(100);

  // Interactive 5-minute Snooze signals
  snoozeRemainingSeconds = signal<number>(0);
  snoozeTargetTitle = signal<string>('');
  snoozeTargetBody = signal<string>('');

  constructor() {
    this.loadLogs();

    if (typeof window !== 'undefined') {
      void this.checkNativeCapabilities();
      void this.setupNativeListeners();
      this.setupServiceWorkerMessageListener();

      setTimeout(() => void this.verifyAndHealSchedule(), 2000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          void this.verifyAndHealSchedule();
        }
      });

      effect(() => {
        this.store.effectiveSchedule();
        this.store.settings();
        this.store.isActive();
        void this.scheduleAllNativeNotifications();
        this.computeWebNextAlarm();
      });
    }
  }

  ngOnDestroy(): void {
    if (this.checkIntervalId) clearInterval(this.checkIntervalId);
    if (this.snoozeTimerId) clearInterval(this.snoozeTimerId);
    if (this.popupDismissTimer) clearTimeout(this.popupDismissTimer);
  }

  private setupServiceWorkerMessageListener(): void {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      const payload = event.data as {
        type?: string;
        title?: string;
        body?: string;
        snoozeUntil?: number;
        subscription?: { endpoint: string; keys: { p256dh: string; auth: string } };
      };
      if (!payload || !payload.type) return;

      if (payload.type === 'PUSH_SUBSCRIPTION_CHANGED' && payload.subscription) {
        void savePushSubscriptionObject(payload.subscription);
      } else if (payload.type === 'CLASSSYNC_SNOOZE_5M') {
        const secs = payload.snoozeUntil
          ? Math.max(1, Math.round((payload.snoozeUntil - Date.now()) / 1000))
          : 300;
        this.startLocalSnoozeCountdown(
          payload.title || 'แจ้งเตือนซ้ำ (เลื่อนเตือน)',
          payload.body || 'ครบกำหนด 5 นาทีแล้ว เตรียมเข้าเรียน',
          secs
        );
      }
    });
  }

  private async setupNativeListeners() {
    if (!Capacitor.isNativePlatform()) return;
    await LocalNotifications.addListener('localNotificationReceived', (notification) => {
      this.notificationsFired.update((c) => c + 1);
      this.saveMetrics();
      this.addLog('info', 'notification', `Alarm Fired: ${notification.title}`);
      this.addAudit(
        notification.id?.toString() || 'unknown',
        notification.title || 'Unknown',
        'delivered',
        'Native OS delivered alarm'
      );
    });

    await LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      this.addLog('info', 'notification', `User interacted: ${action.actionId}`);
      this.addAudit(
        action.notification.id?.toString() || 'unknown',
        action.notification.title || 'Unknown',
        'clicked',
        `Action: ${action.actionId}`
      );
    });
  }

  addAudit(id: string, title: string, state: AuditEvent['state'], details: string) {
    const timestamp = new Date().toISOString();
    const newAudit: AuditEvent = { id, timestamp, title, state, details };
    this.auditLogs.update((current) => {
      const updated = [newAudit, ...current].slice(0, 500);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('sched_audit_logs', JSON.stringify(updated));
      }
      return updated;
    });
  }

  exportLogsAsJson() {
    const data = {
      systemLogs: this.logs(),
      auditLogs: this.auditLogs(),
      deviceInfo: this.deviceInfo(),
      metrics: {
        scheduled: this.notificationsScheduled(),
        fired: this.notificationsFired(),
      },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `classsync_logs_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  addLog(
    level: 'info' | 'warn' | 'error',
    category: 'system' | 'notification' | 'sync' | 'alarm',
    message: string
  ) {
    const timestamp = new Date().toISOString();
    const newLog: SystemLog = { timestamp, level, category, message };
    this.logs.update((current) => {
      const updated = [newLog, ...current].slice(0, 100);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('sched_diagnostic_logs', JSON.stringify(updated));
      }
      return updated;
    });

    if (level === 'error') {
      void uploadDiagnosticLogs([newLog]);
    }
  }

  private saveMetrics() {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sched_metrics_fired', this.notificationsFired().toString());
      localStorage.setItem('sched_metrics_scheduled', this.notificationsScheduled().toString());
    }
  }

  private loadLogs() {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('sched_diagnostic_logs');
      if (saved) {
        try {
          this.logs.set(JSON.parse(saved));
        } catch {
          // Ignore corrupted logs
        }
      }
      const savedFired = localStorage.getItem('sched_metrics_fired');
      const savedScheduled = localStorage.getItem('sched_metrics_scheduled');
      if (savedFired) this.notificationsFired.set(parseInt(savedFired, 10));
      if (savedScheduled) this.notificationsScheduled.set(parseInt(savedScheduled, 10));

      const savedAudits = localStorage.getItem('sched_audit_logs');
      if (savedAudits) {
        try {
          this.auditLogs.set(JSON.parse(savedAudits));
        } catch {
          // Ignore
        }
      }

      if (localStorage.getItem('sched_battery_confirmed') === 'true') {
        this.batteryOptimizationConfirmed.set(true);
      }
    }
  }

  confirmBatteryOptimizationResolved() {
    this.batteryOptimizationConfirmed.set(true);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sched_battery_confirmed', 'true');
    }
  }

  private computeWebNextAlarm() {
    if (Capacitor.isNativePlatform()) return;
    const schedule = this.store.effectiveSchedule();
    const settings = this.store.settings();
    if (!this.store.isActive() || schedule.length === 0) {
      this.nextAlarm.set(null);
      return;
    }

    const preNotify = settings.preNotifyMinutes ?? 3;
    const customHolidays = settings.calendarHolidays || {};
    const now = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    let closest: { title: string; time: Date; subjectName: string } | null = null;
    let closestMs = Infinity;

    for (let offset = 0; offset < 7; offset++) {
      const date = new Date(now);
      date.setDate(now.getDate() + offset);
      const dateStr = formatDateYYYYMMDD(date);
      if (isSchoolHoliday(dateStr, customHolidays).isHoliday) continue;

      const dayName = dayNames[date.getDay()];
      for (const s of schedule) {
        if (s.dayOfWeek !== dayName || !s.startTime) continue;
        const name = this.resolveName(s);
        if (name === 'พักเที่ยง' || name === 'พักกลางวัน') continue;

        const [h, m] = s.startTime.split(':').map(Number);
        let notifyH = h;
        let notifyM = m - preNotify;
        while (notifyM < 0) {
          notifyM += 60;
          notifyH -= 1;
        }
        if (notifyH < 0) notifyH = ((notifyH % 24) + 24) % 24;

        const target = new Date(date);
        target.setHours(notifyH, notifyM, 0, 0);
        const ms = target.getTime();
        if (ms > now.getTime() && ms < closestMs) {
          closestMs = ms;
          closest = {
            title: s.sourceCategoryName ? `[${s.sourceCategoryName}]` : 'คาบเรียนถัดไป',
            time: target,
            subjectName: name,
          };
        }
      }
      if (closest) break;
    }

    this.nextAlarm.set(closest);
    this.lastCheckedTime.set(new Date());
  }

  private calculateNextOccurrence(weekday: number, hour: number, minute: number): Date {
    const now = new Date();
    const currentCapacitorDay = now.getDay() + 1;
    let daysToAdd = weekday - currentCapacitorDay;
    if (
      daysToAdd < 0 ||
      (daysToAdd === 0 &&
        (now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute)))
    ) {
      daysToAdd += 7;
    }
    const nextDate = new Date(now);
    nextDate.setDate(now.getDate() + daysToAdd);
    nextDate.setHours(hour, minute, 0, 0);
    return nextDate;
  }

  async verifyAndHealSchedule() {
    this.lastCheckedTime.set(new Date());
    if (typeof window === 'undefined') return;
    if (!Capacitor.isNativePlatform()) {
      this.computeWebNextAlarm();
      return;
    }

    const scheduleCount = this.store.effectiveSchedule().length;
    try {
      const pending = await LocalNotifications.getPending();
      let closestAlarm: { title: string; time: Date; subjectName: string } | null = null;
      let closestDate = Infinity;

      pending.notifications.forEach((n) => {
        let alarmTime: Date | null = null;
        if (n.schedule?.at) {
          alarmTime = new Date(n.schedule.at);
        } else if (n.schedule?.on) {
          alarmTime = this.calculateNextOccurrence(
            n.schedule.on.weekday!,
            n.schedule.on.hour!,
            n.schedule.on.minute!
          );
        }

        if (alarmTime && alarmTime.getTime() < closestDate) {
          closestDate = alarmTime.getTime();
          closestAlarm = {
            title: n.title || 'การแจ้งเตือน',
            time: alarmTime,
            subjectName: n.body || '',
          };
        }
      });

      this.nextAlarm.set(closestAlarm);
      if (this.store.isActive() && scheduleCount > 0 && pending.notifications.length === 0) {
        this.scheduleIntegrityScore.set(50);
        await this.scheduleAllNativeNotifications();
        this.scheduleIntegrityScore.set(100);
      } else {
        this.scheduleIntegrityScore.set(100);
      }
    } catch (e) {
      this.addLog('error', 'system', `Verify integrity error: ${e}`);
    }
  }

  async checkNativeCapabilities() {
    if (!Capacitor.isNativePlatform()) return;
    try {
      const info = await Device.getInfo();
      this.deviceInfo.set(info);
      const { display } = await LocalNotifications.checkPermissions();
      this.exactAlarmPermission.set(display === 'granted' ? 'granted' : 'unknown');
      const pending = await LocalNotifications.getPending();
      this.pendingAlarms.set(pending);
      this.scheduledCount.set(pending.notifications.length);
    } catch (err) {
      this.addLog('error', 'system', `Check native capabilities failed: ${err}`);
    }
  }

  async requestPermission(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    if (Capacitor.isNativePlatform()) {
      try {
        const permission = await LocalNotifications.requestPermissions();
        return permission.display === 'granted';
      } catch {
        return false;
      }
    }

    if (!('Notification' in window)) return false;
    const token = await requestFirebaseNotificationPermission();
    return Boolean(token) || Notification.permission === 'granted';
  }

  startChecking() {
    if (typeof window === 'undefined' || this.checkIntervalId) return;
    this.computeWebNextAlarm();
    this.checkIntervalId = setInterval(() => {
      this.checkSchedule();
      this.computeWebNextAlarm();
    }, 15000);
  }

  stopChecking() {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = undefined;
    }
  }

  private checkSchedule() {
    if (!this.store.isActive()) return;

    const now = new Date();
    const dateStr = formatDateYYYYMMDD(now);
    const settings = this.store.settings();
    if (isSchoolHoliday(dateStr, settings.calendarHolidays || {}).isHoliday) return;

    const currentDay = now.toLocaleDateString('en-US', { weekday: 'long' });
    const currentHours = now.getHours();
    const currentMinutes = now.getMinutes();

    const todayClasses = this.store
      .effectiveSchedule()
      .filter((s) => s.dayOfWeek === currentDay)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    const preNotifyMinutes = settings.preNotifyMinutes ?? 3;

    for (let i = 0; i < todayClasses.length; i++) {
      const session = todayClasses[i];
      const name = this.resolveName(session);
      if (name === 'พักเที่ยง' || name === 'พักกลางวัน') continue;

      const startParts = session.startTime.split(':');
      if (startParts.length === 2) {
        const startH = parseInt(startParts[0], 10);
        const startM = parseInt(startParts[1], 10);
        let notifyH = startH;
        let notifyM = startM - preNotifyMinutes;
        while (notifyM < 0) {
          notifyM += 60;
          notifyH -= 1;
        }
        if (notifyH < 0) notifyH = ((notifyH % 24) + 24) % 24;

        if (currentHours === notifyH && currentMinutes === notifyM) {
          const key = `start_${session.id}_${dateStr}_${notifyH}_${notifyM}`;
          if (!this.notifiedSet.has(key)) {
            this.notifiedSet.add(key);
            if (name === 'เลิกเรียน') {
              this.sendNotification(
                'เลิกเรียนแล้ว',
                'หมดเวลาเรียนของวันนี้แล้ว เดินทางกลับบ้านอย่างปลอดภัย',
                'end',
                settings,
                false
              );
            } else {
              this.sendClassTransitionNotification(session, i + 1, settings);
            }
          }
        }
      }

      if (settings.notifyEnd && name !== 'เลิกเรียน') {
        const endParts = session.endTime.split(':');
        if (endParts.length === 2) {
          const endH = parseInt(endParts[0], 10);
          const endM = parseInt(endParts[1], 10);
          if (currentHours === endH && currentMinutes === endM) {
            const key = `end_${session.id}_${dateStr}_${endH}_${endM}`;
            if (!this.notifiedSet.has(key)) {
              this.notifiedSet.add(key);
              const prefix = session.sourceCategoryName ? `[${session.sourceCategoryName}] ` : '';
              this.sendNotification(
                `${prefix}หมดคาบเรียน`,
                `หมดคาบเรียนวิชา ${name} แล้ว`,
                'end',
                settings,
                false
              );
            }
          }
        }
      }
    }
  }

  private resolveName(session: ClassSession): string {
    let mappings: Record<string, string> = {};
    try {
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('subject_mappings') : null;
      if (saved) mappings = JSON.parse(saved);
    } catch {
      // Ignore
    }
    const code = (session.subjectCode || '').trim().toUpperCase();
    return (
      mappings[code] ||
      DEFAULT_SUBJECT_MAPPINGS[code] ||
      session.subjectName ||
      session.subjectCode ||
      'ไม่ระบุวิชา'
    );
  }

  private sendClassTransitionNotification(
    next: ClassSession,
    classNum: number,
    settings: AppSettings
  ) {
    const nextName = this.resolveName(next);
    const preNotifyMinutes = settings.preNotifyMinutes ?? 3;
    const prefix = next.sourceCategoryName ? `[${next.sourceCategoryName}] ` : '';
    const slotLabel = classNum === 1 ? 'คาบแรก' : `คาบที่ ${classNum}`;

    const lines = [
      preNotifyMinutes > 0
        ? `อีก ${preNotifyMinutes} นาทีจะเริ่มเรียน (${slotLabel})`
        : `ได้เวลาเริ่มเรียน (${slotLabel})`,
      `วิชา: ${nextName}`,
      `เวลา: ${next.startTime} - ${next.endTime} น.`,
    ];
    if (settings.notifyRoom && next.room) lines.push(`ห้อง: ${next.room}`);
    if (settings.notifyTeacher && next.teacher) lines.push(`ผู้สอน: ${next.teacher}`);

    const title =
      preNotifyMinutes > 0
        ? `${prefix}แจ้งเตือนเข้าเรียน (ล่วงหน้า ${preNotifyMinutes} นาที)`
        : `${prefix}แจ้งเตือนเริ่มชั้นเรียน`;

    this.sendNotification(title, lines.join('\n'), 'start', settings, true);
  }

  async sendTestNotification(
    settings: AppSettings,
    delaySeconds = 0
  ): Promise<{ scheduled: boolean; sentCount: number; totalSubs: number } | null> {
    const timeLabel = new Date().toLocaleTimeString('th-TH', {
      hour: '2-digit',
      minute: '2-digit',
    });

    if (delaySeconds > 0 && !Capacitor.isNativePlatform()) {
      return sendServerTestPush(
        delaySeconds,
        'ทดสอบ Web Push พื้นหลัง (ClassSync)',
        `ส่งเมื่อครบกำหนด ${delaySeconds} วินาที — แม้ปัดปิดแอปหรือพับหน้าจอแล้ว ระบบแจ้งเตือนยังทำงานสมบูรณ์`
      );
    }

    if (delaySeconds === 0) {
      this.sendNotification(
        'ทดสอบระบบแจ้งเตือน ClassSync',
        `ขณะนี้เวลา ${timeLabel} น.\nระบบแจ้งเตือนพร้อมใช้งานอย่างสมบูรณ์`,
        'start',
        settings,
        true
      );
      if (!Capacitor.isNativePlatform()) {
        return sendServerTestPush(0);
      }
      return { scheduled: true, sentCount: 1, totalSubs: 1 };
    }

    await this.scheduleSandboxNotification(delaySeconds);
    return { scheduled: true, sentCount: 0, totalSubs: 1 };
  }

  async snoozeActiveNotification(minutes = 5): Promise<void> {
    const active = this.store.activeNotification();
    if (!active) return;
    const title = `${active.title} (เลื่อนเตือน ${minutes} นาที)`;
    const body = active.body;
    this.store.activeNotification.set(null);

    this.startLocalSnoozeCountdown(title, body, minutes * 60);
    if (!Capacitor.isNativePlatform()) {
      await scheduleServerPushSnooze(title, body, minutes * 60);
    } else {
      await LocalNotifications.schedule({
        notifications: [
          {
            title,
            body,
            id: Math.floor(Math.random() * 900000) + 10000,
            schedule: { at: new Date(Date.now() + minutes * 60 * 1000), allowWhileIdle: true },
            sound: 'default',
            channelId: 'class-alerts',
          },
        ],
      }).catch(() => undefined);
    }
  }

  private startLocalSnoozeCountdown(title: string, body: string, totalSeconds: number) {
    if (this.snoozeTimerId) clearInterval(this.snoozeTimerId);
    this.snoozeTargetTitle.set(title);
    this.snoozeTargetBody.set(body);
    this.snoozeRemainingSeconds.set(totalSeconds);

    this.snoozeTimerId = setInterval(() => {
      const next = this.snoozeRemainingSeconds() - 1;
      if (next <= 0) {
        if (this.snoozeTimerId) clearInterval(this.snoozeTimerId);
        this.snoozeTimerId = undefined;
        this.snoozeRemainingSeconds.set(0);
        this.sendNotification(title, body, 'start', this.store.settings(), true);
      } else {
        this.snoozeRemainingSeconds.set(next);
      }
    }, 1000);
  }

  cancelSnooze() {
    if (this.snoozeTimerId) {
      clearInterval(this.snoozeTimerId);
      this.snoozeTimerId = undefined;
    }
    this.snoozeRemainingSeconds.set(0);
  }

  private sendNotification(
    title: string,
    body: string,
    type: 'start' | 'end',
    settings: AppSettings,
    allowSnooze = true
  ) {
    this.playNotificationSound(settings.notificationSound);

    this.store.activeNotification.set({ title, body, type, allowSnooze });
    if (this.popupDismissTimer) clearTimeout(this.popupDismissTimer);
    this.popupDismissTimer = setTimeout(() => {
      this.store.activeNotification.set(null);
    }, (settings.popupDuration || 10) * 1000);

    if (typeof window === 'undefined') return;

    if (Capacitor.isNativePlatform()) {
      void LocalNotifications.createChannel({
        id: 'class-alerts',
        name: 'แจ้งเตือนคาบเรียนด่วน',
        description: 'แสดงป้ายเตือนลอยด้านบนขอบจอ',
        importance: 5,
        sound: 'default',
        visibility: 1,
        vibration: true,
      })
        .then(() =>
          LocalNotifications.schedule({
            notifications: [
              {
                title,
                body,
                id: Math.floor(Math.random() * 1000000),
                schedule: { at: new Date(Date.now() + 100) },
                sound: 'default',
                channelId: 'class-alerts',
              },
            ],
          })
        )
        .catch(() => undefined);
    } else if ('Notification' in window && Notification.permission === 'granted') {
      if ('serviceWorker' in navigator) {
        void navigator.serviceWorker.ready.then((registration) => {
          const baseUrl = window.location.origin;
          const options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
            body,
            icon: `${baseUrl}/pwa-192x192.png`,
            badge: `${baseUrl}/pwa-192x192.png`,
            tag: 'classsync-alert',
            renotify: true,
            vibrate: [200, 100, 200],
          };
          return registration.showNotification(title, options);
        });
      }
    }
  }

  playNotificationSound(customSound?: string) {
    if (typeof window === 'undefined') return;
    if (customSound) {
      const audio = new Audio(customSound);
      void audio.play().catch(() => undefined);
      return;
    }
    try {
      const win = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const AudioContextClass = win.AudioContext || win.webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const t = ctx.currentTime;
      const freqs = [659, 988];
      freqs.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const s = t + i * 0.12;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, s);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.99, s + 0.8);
        gain.gain.setValueAtTime(0, s);
        gain.gain.linearRampToValueAtTime(0.18, s + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, s + 1.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(s);
        osc.stop(s + 1.3);
      });
    } catch {
      // Ignore WebAudio restrictions
    }
  }

  private stringToHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  async scheduleAllNativeNotifications() {
    if (!Capacitor.isNativePlatform()) return;
    try {
      await LocalNotifications.createChannel({
        id: 'class-alerts',
        name: 'แจ้งเตือนคาบเรียนด่วน',
        description: 'แสดงป้ายเตือนลอยด้านบนขอบจอ',
        importance: 5,
        sound: 'default',
        visibility: 1,
        vibration: true,
      });

      const pendingRes = await LocalNotifications.getPending();
      if (pendingRes?.notifications?.length > 0) {
        await LocalNotifications.cancel({
          notifications: pendingRes.notifications.map((n: { id: number }) => ({ id: n.id })),
        });
      }

      if (!this.store.isActive()) return;
      const schedule = this.store.effectiveSchedule();
      const settings = this.store.settings();
      const preNotifyMinutes = settings.preNotifyMinutes ?? 3;
      const dayMap: Record<string, number> = {
        sunday: 1,
        monday: 2,
        tuesday: 3,
        wednesday: 4,
        thursday: 5,
        friday: 6,
        saturday: 7,
      };

      const notificationsToSchedule = [];
      for (const session of schedule) {
        if (!session.dayOfWeek || !session.startTime) continue;
        const weekday = dayMap[session.dayOfWeek.trim().toLowerCase()];
        if (!weekday) continue;

        const name = this.resolveName(session);
        if (name === 'พักเที่ยง' || name === 'พักกลางวัน') continue;

        const [startH, startM] = session.startTime.split(':').map(Number);
        let notifyH = startH;
        let notifyM = startM - preNotifyMinutes;
        let notifyWeekday = weekday;
        while (notifyM < 0) {
          notifyM += 60;
          notifyH -= 1;
        }
        if (notifyH < 0) {
          const daysBack = Math.ceil(Math.abs(notifyH) / 24);
          notifyH = ((notifyH % 24) + 24) % 24;
          notifyWeekday -= daysBack;
          while (notifyWeekday < 1) notifyWeekday += 7;
        }

        const prefix = session.sourceCategoryName ? `[${session.sourceCategoryName}] ` : '';
        notificationsToSchedule.push({
          id: this.stringToHash(`${session.id}_start`),
          title:
            preNotifyMinutes > 0
              ? `${prefix}แจ้งเตือนเข้าเรียน (ล่วงหน้า ${preNotifyMinutes} นาที)`
              : `${prefix}แจ้งเตือนเริ่มชั้นเรียน`,
          body: `วิชา: ${name}\nเวลา: ${session.startTime} น.`,
          schedule: {
            on: { weekday: notifyWeekday, hour: notifyH, minute: notifyM },
            repeats: true,
            allowWhileIdle: true,
          },
          sound: 'default',
          channelId: 'class-alerts',
        });
      }

      if (notificationsToSchedule.length > 0) {
        await LocalNotifications.schedule({ notifications: notificationsToSchedule });
        this.notificationsScheduled.update((c) => c + 1);
        this.saveMetrics();
        await this.checkNativeCapabilities();
      }
    } catch (err) {
      this.addLog('error', 'alarm', `Schedule native alarms failed: ${err}`);
    }
  }

  async scheduleSandboxNotification(seconds: number) {
    const title = '🎉 สำเร็จการทำงานเบื้องหลัง 100%';
    const body = `ระบบแจ้งเตือนทำงานสมบูรณ์แบบแม้ปัดปิดแอป (${seconds} วินาที)`;
    if (Capacitor.isNativePlatform()) {
      await LocalNotifications.schedule({
        notifications: [
          {
            title,
            body,
            id: 777777,
            schedule: { at: new Date(Date.now() + seconds * 1000), allowWhileIdle: true },
            sound: 'default',
            channelId: 'class-alerts',
          },
        ],
      }).catch(() => undefined);
    }
  }
}
