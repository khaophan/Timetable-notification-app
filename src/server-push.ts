import webpush from 'web-push';
import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  Firestore,
  collection,
  getDocs,
  query,
  where,
  updateDoc,
  doc,
  addDoc,
  getDoc,
  setDoc,
  deleteDoc,
} from 'firebase/firestore';
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import fs from 'node:fs';
import path from 'node:path';

interface SessionItem {
  id: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  subjectCode?: string;
  subjectName?: string;
  room?: string;
  teacher?: string;
}

interface CustomCategoryItem {
  id: string;
  name: string;
  enabled: boolean;
  sessions: SessionItem[];
}

interface BackupDocData {
  schedule?: SessionItem[];
  customCategories?: CustomCategoryItem[];
  active?: boolean;
  settings?: {
    preNotifyMinutes?: number;
    notifyEnd?: boolean;
    notifyTeacher?: boolean;
    notifySubjectCode?: boolean;
    notifySubjectName?: boolean;
    notifyRoom?: boolean;
    calendarHolidays?: Record<string, string>;
  };
}

const THAI_PUBLIC_HOLIDAYS_2026: Record<string, string> = {
  '2026-01-01': 'วันขึ้นปีใหม่',
  '2026-03-03': 'วันมาฆบูชา',
  '2026-04-06': 'วันจักรี',
  '2026-04-13': 'วันสงกรานต์',
  '2026-04-14': 'วันสงกรานต์',
  '2026-04-15': 'วันสงกรานต์',
  '2026-05-01': 'วันแรงงานแห่งชาติ',
  '2026-05-04': 'วันฉัตรมงคล',
  '2026-05-31': 'วันวิสาขบูชา',
  '2026-06-03': 'วันเฉลิมฯ พระราชินี',
  '2026-07-28': 'วันเฉลิมฯ ร.10',
  '2026-07-29': 'วันอาสาฬหบูชา',
  '2026-07-30': 'วันเข้าพรรษา',
  '2026-08-12': 'วันแม่แห่งชาติ',
  '2026-10-13': 'วันนวมินทรมหาราช',
  '2026-10-23': 'วันปิยมหาราช',
  '2026-12-05': 'วันพ่อแห่งชาติ',
  '2026-12-10': 'วันรัฐธรรมนูญ',
  '2026-12-31': 'วันสิ้นปี',
};

let publicVapidKey = (process.env['VAPID_PUBLIC_KEY'] || '').trim();
let privateVapidKey = (process.env['VAPID_PRIVATE_KEY'] || '').trim();
let vapidConfigured = false;

let db: Firestore | null = null;
let isReady = false;
let initPromise: Promise<void> | null = null;
let workerTimer: ReturnType<typeof setInterval> | null = null;

// Prevent sending duplicate notifications within the same minute/tick
const sentTriggerKeys = new Set<string>();

function applyVapidDetails(pub: string, priv: string) {
  publicVapidKey = pub;
  privateVapidKey = priv;
  webpush.setVapidDetails('mailto:khaophan.po@gmail.com', publicVapidKey, privateVapidKey);
  vapidConfigured = true;
}

export function getVapidPublicKey(): string {
  return publicVapidKey;
}

export async function getVapidPublicKeyAsync(): Promise<string> {
  await initPushWorker();
  return publicVapidKey;
}

function getBangkokDateParts(now = new Date()) {
  const bangkokMs = now.getTime() + 7 * 60 * 60 * 1000;
  const bkk = new Date(bangkokMs);
  const year = bkk.getUTCFullYear();
  const month = String(bkk.getUTCMonth() + 1).padStart(2, '0');
  const day = String(bkk.getUTCDate()).padStart(2, '0');
  const hours = bkk.getUTCHours();
  const minutes = bkk.getUTCMinutes();
  const dayIndex = bkk.getUTCDay();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return {
    dateStr: `${year}-${month}-${day}`,
    dayName: dayNames[dayIndex],
    isWeekend: dayIndex === 0 || dayIndex === 6,
    hours,
    minutes,
    hhmm: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
  };
}

function subtractMinutes(hhmm: string, minsToSubtract: number): string | null {
  const parts = hhmm.split(':');
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;

  let total = h * 60 + m - minsToSubtract;
  while (total < 0) total += 1440;
  total = total % 1440;

  const resH = Math.floor(total / 60);
  const resM = total % 60;
  return `${String(resH).padStart(2, '0')}:${String(resM).padStart(2, '0')}`;
}

async function ensurePersistentVapidKeys(firestore: Firestore) {
  if (publicVapidKey && privateVapidKey) {
    applyVapidDetails(publicVapidKey, privateVapidKey);
    return;
  }

  try {
    const keyDocRef = doc(firestore, 'system_internal', 'vapid_keys');
    const snap = await getDoc(keyDocRef);
    if (snap.exists()) {
      const data = snap.data() as { publicKey?: string; privateKey?: string };
      if (data.publicKey && data.privateKey) {
        applyVapidDetails(data.publicKey, data.privateKey);
        console.log('[PushWorker] Loaded persistent VAPID keys from Firestore.');
        return;
      }
    }

    const generated = webpush.generateVAPIDKeys();
    await setDoc(keyDocRef, {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      updatedAt: new Date().toISOString(),
    });
    applyVapidDetails(generated.publicKey, generated.privateKey);
    console.log('[PushWorker] Generated and persisted permanent VAPID keys to Firestore.');
  } catch (err) {
    console.error('[PushWorker] Failed to persist VAPID keys to Firestore, using in-memory fallback:', err);
    if (!vapidConfigured) {
      const fallback = webpush.generateVAPIDKeys();
      applyVapidDetails(fallback.publicKey, fallback.privateKey);
    }
  }
}

export async function initPushWorker(): Promise<void> {
  if (isReady && db) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      const existingApps = getApps();
      const firebaseApp =
        existingApps.find((a) => a.name === 'server-push-worker') ||
        initializeApp(configData, 'server-push-worker');
      db = getFirestore(firebaseApp, configData.firestoreDatabaseId);
      const auth = getAuth(firebaseApp);

      const email = 'backend_scheduler_robot@system.local';
      const password = 'VerySecureBackendPassword123!';

      try {
        await signInWithEmailAndPassword(auth, email, password);
        console.log('[PushWorker] Backend worker authenticated.');
      } catch (err: unknown) {
        const authErr = err as { code?: string };
        if (authErr.code === 'auth/user-not-found' || authErr.code === 'auth/invalid-credential') {
          await createUserWithEmailAndPassword(auth, email, password);
          console.log('[PushWorker] Backend worker account created.');
        } else {
          throw err;
        }
      }

      await ensurePersistentVapidKeys(db);
      isReady = true;

      if (!workerTimer) {
        workerTimer = setInterval(() => {
          void processNotificationQueue();
          void evaluateRealtimeSchedules();
        }, 20000);
        console.log('[PushWorker] 24/7 Web Push scheduler started (20s interval, Bangkok UTC+7).');
      }

      void processNotificationQueue();
      void evaluateRealtimeSchedules();
    } catch (e) {
      console.error('[PushWorker] Initialization failed:', e);
      initPromise = null;
    }
  })();

  return initPromise;
}

async function deliverWebPushToUser(
  userId: string,
  title: string,
  body: string,
  tag = 'classsync-alert',
  notificationId = ''
): Promise<{ sentCount: number; totalSubs: number }> {
  if (!db || !vapidConfigured) return { sentCount: 0, totalSubs: 0 };

  const subQuery = query(collection(db, 'pushSubscriptions'), where('userId', '==', userId));
  const subSnaps = await getDocs(subQuery);
  const totalSubs = subSnaps.size;
  let sentCount = 0;

  const payload = JSON.stringify({
    title,
    body,
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag,
    url: '/',
    userId,
    allowSnooze: true,
  });

  const deliveries = subSnaps.docs.map(async (subSnap) => {
    const subData = subSnap.data() as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };
    const subscription = {
      endpoint: subData.endpoint,
      keys: subData.keys,
    };

    try {
      await webpush.sendNotification(subscription, payload, {
        TTL: 60 * 5,
        urgency: 'high',
      });
      sentCount++;
    } catch (err: unknown) {
      const pushErr = err as { statusCode?: number; message?: string };
      if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
        await deleteDoc(doc(db!, 'pushSubscriptions', subSnap.id)).catch(() => undefined);
      }
      console.warn('[PushWorker] Delivery failed for sub', subSnap.id, pushErr.statusCode || pushErr.message);
    }
  });

  await Promise.all(deliveries);

  if (notificationId && db) {
    const status = sentCount > 0 ? 'sent' : 'failed';
    await updateDoc(doc(db, 'notifications', notificationId), { status }).catch(() => undefined);
    await addDoc(collection(db, 'notificationLogs'), {
      userId,
      notificationId,
      status,
      sentAt: new Date().toISOString(),
    }).catch(() => undefined);
  }

  return { sentCount, totalSubs };
}

export async function processNotificationQueue(): Promise<void> {
  if (!isReady || !db) return;
  try {
    const now = new Date();
    const pendingQuery = query(collection(db, 'notifications'), where('status', '==', 'pending'));
    const snaps = await getDocs(pendingQuery);

    for (const docSnap of snaps.docs) {
      const nData = docSnap.data() as {
        userId: string;
        sendAt: string;
        title: string;
        body: string;
      };
      const sendAtDate = new Date(nData.sendAt);
      if (now >= sendAtDate) {
        await deliverWebPushToUser(
          nData.userId,
          nData.title,
          nData.body,
          `queue_${docSnap.id}`,
          docSnap.id
        );
      }
    }
  } catch (e) {
    console.error('[PushWorker] Queue processing error:', e);
  }
}

export async function evaluateRealtimeSchedules(): Promise<void> {
  if (!isReady || !db) return;
  try {
    const bkk = getBangkokDateParts();
    const usersSnap = await getDocs(collection(db, 'users'));

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      const backupSnap = await getDoc(doc(db, 'users', uid, 'backup', 'data'));
      if (!backupSnap.exists()) continue;

      const backup = backupSnap.data() as BackupDocData;
      if (backup.active === false) continue;

      const settings = backup.settings || {};
      const customHolidays = settings.calendarHolidays || {};
      const isHoliday =
        bkk.isWeekend ||
        Boolean(THAI_PUBLIC_HOLIDAYS_2026[bkk.dateStr]) ||
        Boolean(customHolidays[bkk.dateStr]);

      if (isHoliday) continue;

      const preNotifyMinutes = settings.preNotifyMinutes ?? 3;
      const notifyEnd = settings.notifyEnd ?? true;

      const officialSessions = Array.isArray(backup.schedule) ? backup.schedule : [];
      const enabledCustomSessions: { categoryName: string; session: SessionItem }[] = [];

      if (Array.isArray(backup.customCategories)) {
        for (const cat of backup.customCategories) {
          if (cat && cat.enabled && Array.isArray(cat.sessions)) {
            for (const s of cat.sessions) {
              enabledCustomSessions.push({ categoryName: cat.name || 'ตารางส่วนตัว', session: s });
            }
          }
        }
      }

      const combined: { sourceName?: string; session: SessionItem }[] = [
        ...officialSessions.map((session) => ({ session })),
        ...enabledCustomSessions.map((item) => ({
          sourceName: item.categoryName,
          session: item.session,
        })),
      ];

      for (const item of combined) {
        const s = item.session;
        if (!s || !s.dayOfWeek || !s.startTime) continue;
        if (s.dayOfWeek.trim().toLowerCase() !== bkk.dayName.toLowerCase()) continue;

        const subjectLabel = s.subjectName || s.subjectCode || 'คาบเรียน';
        if (subjectLabel === 'เลิกเรียน' || subjectLabel === 'พักเที่ยง') {
          if (subjectLabel === 'เลิกเรียน' && s.startTime === bkk.hhmm) {
            const endDayKey = `${uid}_dismiss_${s.id}_${bkk.dateStr}_${bkk.hhmm}`;
            if (!sentTriggerKeys.has(endDayKey)) {
              sentTriggerKeys.add(endDayKey);
              await deliverWebPushToUser(
                uid,
                'เลิกเรียนแล้ว',
                'หมดเวลาเรียนสำหรับวันนี้แล้ว เดินทางกลับบ้านอย่างปลอดภัย',
                `dismiss_${s.id}`
              );
            }
          }
          continue;
        }

        const startTriggerTime = subtractMinutes(s.startTime, preNotifyMinutes);
        if (startTriggerTime === bkk.hhmm) {
          const triggerKey = `${uid}_start_${s.id}_${bkk.dateStr}_${bkk.hhmm}`;
          if (!sentTriggerKeys.has(triggerKey)) {
            sentTriggerKeys.add(triggerKey);
            const prefix = item.sourceName ? `[${item.sourceName}] ` : '';
            const title =
              preNotifyMinutes > 0
                ? `${prefix}แจ้งเตือนเข้าเรียน (ล่วงหน้า ${preNotifyMinutes} นาที)`
                : `${prefix}ถึงเวลาเข้าเรียนแล้ว`;
            const details: string[] = [`วิชา: ${subjectLabel}`, `เวลา: ${s.startTime} - ${s.endTime} น.`];
            if (settings.notifyRoom !== false && s.room) details.push(`ห้อง: ${s.room}`);
            if (settings.notifyTeacher !== false && s.teacher) details.push(`ผู้สอน: ${s.teacher}`);

            await deliverWebPushToUser(uid, title, details.join('\n'), `start_${s.id}`);
          }
        }

        if (notifyEnd && s.endTime === bkk.hhmm) {
          const endKey = `${uid}_end_${s.id}_${bkk.dateStr}_${bkk.hhmm}`;
          if (!sentTriggerKeys.has(endKey)) {
            sentTriggerKeys.add(endKey);
            const prefix = item.sourceName ? `[${item.sourceName}] ` : '';
            await deliverWebPushToUser(
              uid,
              `${prefix}หมดเวลาคาบเรียน`,
              `หมดคาบวิชา ${subjectLabel} (${s.endTime} น.)`,
              `end_${s.id}`
            );
          }
        }
      }
    }

    // Trim trigger cache if huge
    if (sentTriggerKeys.size > 5000) {
      sentTriggerKeys.clear();
    }
  } catch (e) {
    console.error('[PushWorker] Realtime schedule evaluation error:', e);
  }
}

export async function sendTestPushForUser(
  userId: string,
  delaySeconds = 0,
  title = 'ทดสอบแจ้งเตือนพื้นหลัง (Web Push)',
  body = 'ระบบ Web Push เบื้องหลังทำงานสำเร็จ แม้จะปัดปิดแอปหรือพับหน้าจอแล้วก็ตาม'
): Promise<{ scheduled: boolean; sentCount: number; totalSubs: number }> {
  await initPushWorker();
  if (!db) return { scheduled: false, sentCount: 0, totalSubs: 0 };

  const clampedDelay = Math.max(0, Math.min(60, Number(delaySeconds) || 0));

  if (clampedDelay === 0) {
    const res = await deliverWebPushToUser(userId, title, body, `test_${Date.now()}`);
    return { scheduled: true, sentCount: res.sentCount, totalSubs: res.totalSubs };
  }

  const sendAt = new Date(Date.now() + clampedDelay * 1000);
  const docId = `test_${userId.slice(0, 12)}_${Date.now()}`;
  await setDoc(doc(db, 'notifications', docId), {
    userId,
    sendAt: sendAt.toISOString(),
    timestamp: sendAt.getTime(),
    title,
    body,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  // Fire exact timer in addition to durable Firestore queue so 5s iPad close-app test triggers precisely
  setTimeout(() => {
    void deliverWebPushToUser(userId, title, body, `test_${docId}`, docId);
  }, clampedDelay * 1000);

  const subQuery = query(collection(db, 'pushSubscriptions'), where('userId', '==', userId));
  const subSnaps = await getDocs(subQuery);
  return { scheduled: true, sentCount: 0, totalSubs: subSnaps.size };
}

export async function scheduleServerSnooze(
  userId: string,
  title: string,
  body: string,
  delaySeconds = 300
): Promise<{ scheduled: boolean; sendAt: string }> {
  await initPushWorker();
  const safeDelay = Math.max(10, Math.min(3600, Number(delaySeconds) || 300));
  const sendAt = new Date(Date.now() + safeDelay * 1000);
  const sendAtIso = sendAt.toISOString();

  if (db && userId) {
    const docId = `snooze_${userId.slice(0, 12)}_${Date.now()}`;
    await setDoc(doc(db, 'notifications', docId), {
      userId,
      sendAt: sendAtIso,
      timestamp: sendAt.getTime(),
      title: title || 'แจ้งเตือนซ้ำ (ครบเวลาเลื่อน 5 นาที)',
      body: body || 'ถึงเวลาเข้าเรียนตามที่คุณตั้งเลื่อนเตือนไว้แล้ว',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  }

  return { scheduled: true, sendAt: sendAtIso };
}