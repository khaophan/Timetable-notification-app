import { initializeApp, getApps } from 'firebase/app';
import { getMessaging, onMessage } from 'firebase/messaging';
import {
  initializeFirestore,
  getFirestore,
  Firestore,
  doc,
  setDoc,
  getDoc,
  getDocFromServer,
  onSnapshot,
  collection,
  query,
  where,
  getDocs,
  deleteDoc,
  writeBatch,
  limit,
  DocumentReference,
  DocumentSnapshot,
} from 'firebase/firestore';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, User } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  ClassSession,
  ClassScheduleDoc,
  PersonalScheduleCategory,
  AppSettings,
  UserRole,
} from './models';
import { isSchoolHoliday } from './schedule-utils';

const app = getApps().find((a) => a.name === '[DEFAULT]') || initializeApp(firebaseConfig);

function createClientFirestore(): Firestore {
  try {
    return initializeFirestore(
      app,
      { experimentalForceLongPolling: true },
      firebaseConfig.firestoreDatabaseId
    );
  } catch {
    return getFirestore(app, firebaseConfig.firestoreDatabaseId);
  }
}

export const db = createClientFirestore();
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export const ADMIN_EMAIL = 'khaophan.po@gmail.com';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message.toLowerCase() : '';
    if (msg.includes('the client is offline')) {
      console.warn('[Firebase] Client offline during connection check.');
    }
    return false;
  }
}

const getDocWithRetry = async (
  docRef: DocumentReference,
  retries = 3,
  delayMs = 1200
): Promise<DocumentSnapshot> => {
  for (let i = 0; i < retries; i++) {
    try {
      return await getDoc(docRef);
    } catch (err) {
      const error = err as { code?: string; message?: string };
      const isOfflineError = Boolean(
        error &&
          (error.code === 'unavailable' ||
            (error.message && error.message.toLowerCase().includes('offline')))
      );
      if (isOfflineError && i < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
  return getDoc(docRef);
};

let messaging: ReturnType<typeof getMessaging> | null = null;
if (typeof window !== 'undefined' && 'Notification' in window) {
  try {
    messaging = getMessaging(app);
  } catch {
    messaging = null;
  }
}

export interface GlobalConfig {
  backendApiUrl: string;
  subjectMappings: Record<string, string>;
  githubRepo: string;
  broadcastText: string;
  maintenanceMode: boolean;
  updatedAt: string;
}

export interface BackupCloudPayload {
  schedule: ClassSession[];
  customCategories?: PersonalScheduleCategory[];
  selectedClassId?: string;
  selectedGrade?: string;
  selectedRoom?: string;
  role?: UserRole;
  settings: AppSettings;
  active: boolean;
  updatedAt: string;
}

export async function getAuthenticatedUid(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  await auth.authStateReady();
  return auth.currentUser?.uid || null;
}

export const signInWithGoogle = async (): Promise<User | null> => {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
};

export const logout = async (): Promise<void> => {
  await signOut(auth);
};

export async function ensureUserProfile(
  user: User,
  extra?: {
    role?: UserRole;
    selectedClassId?: string;
    selectedGrade?: string;
    selectedRoom?: string;
  }
): Promise<void> {
  const userPath = `users/${user.uid}`;
  try {
    const userRef = doc(db, 'users', user.uid);
    const snap = await getDocWithRetry(userRef);
    const createdAt = snap.exists()
      ? (snap.data()['createdAt'] as string) || new Date().toISOString()
      : new Date().toISOString();

    const payload: Record<string, string> = {
      email: user.email || '',
      createdAt,
    };
    if (user.displayName) payload['displayName'] = user.displayName;
    if (extra?.role) payload['role'] = extra.role;
    if (extra?.selectedClassId !== undefined) payload['selectedClassId'] = extra.selectedClassId;
    if (extra?.selectedGrade !== undefined) payload['selectedGrade'] = extra.selectedGrade;
    if (extra?.selectedRoom !== undefined) payload['selectedRoom'] = extra.selectedRoom;

    await setDoc(userRef, payload, { merge: true });
  } catch (err) {
    console.warn('[Firebase] Failed to sync user profile:', userPath, err);
  }
}

export function buildClassScheduleDocId(grade: string, room: string): string {
  const gNorm = grade
    .trim()
    .replace('ป.', 'p')
    .replace('ม.', 'm')
    .replace(/[^a-zA-Z0-9]/g, '');
  const rNorm = room.trim().replace(/[^a-zA-Z0-9]/g, '');
  if (gNorm && rNorm) {
    return `${gNorm}_r${rNorm}`;
  }
  const combined = `${grade}_${room}`;
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    hash = (hash << 5) - hash + combined.charCodeAt(i);
    hash = hash & hash;
  }
  return `cls_${Math.abs(hash).toString(36)}`;
}

export async function fetchPublishedClassSchedules(): Promise<ClassScheduleDoc[]> {
  try {
    const uid = await getAuthenticatedUid();
    if (!uid) return [];
    const snaps = await getDocs(collection(db, 'classSchedules'));
    const items: ClassScheduleDoc[] = [];
    snaps.forEach((d) => {
      const data = d.data() as Omit<ClassScheduleDoc, 'id'>;
      if (Array.isArray(data.sessions) && data.sessions.length > 0) {
        items.push({ id: d.id, ...data });
      }
    });
    return items.sort((a, b) => a.displayName.localeCompare(b.displayName, 'th'));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'classSchedules');
  }
}

export function subscribeToPublishedClassSchedules(
  callback: (items: ClassScheduleDoc[]) => void
): () => void {
  return onSnapshot(
    collection(db, 'classSchedules'),
    (snaps) => {
      const items: ClassScheduleDoc[] = [];
      snaps.forEach((d) => {
        const data = d.data() as Omit<ClassScheduleDoc, 'id'>;
        if (Array.isArray(data.sessions) && data.sessions.length > 0) {
          items.push({ id: d.id, ...data });
        }
      });
      items.sort((a, b) => a.displayName.localeCompare(b.displayName, 'th'));
      callback(items);
    },
    (err) => {
      console.warn('[Firebase] Class schedules listener skipped:', err.message);
    }
  );
}

export async function savePublishedClassSchedule(
  grade: string,
  room: string,
  sessions: ClassSession[]
): Promise<ClassScheduleDoc> {
  if (!sessions || sessions.length === 0) {
    throw new Error('ไม่สามารถเผยแพร่ตารางว่างได้ กรุณาเพิ่มอย่างน้อย 1 คาบเรียน');
  }
  const classId = buildClassScheduleDocId(grade, room);
  const displayName = `${grade.trim()}/${room.trim()}`;
  const updatedBy = auth.currentUser?.email || ADMIN_EMAIL;
  const docData: Omit<ClassScheduleDoc, 'id'> = {
    grade: grade.trim(),
    room: room.trim(),
    displayName,
    sessions,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };

  try {
    await setDoc(doc(db, 'classSchedules', classId), docData);
    return { id: classId, ...docData };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `classSchedules/${classId}`);
  }
}

export async function deletePublishedClassSchedule(classId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'classSchedules', classId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `classSchedules/${classId}`);
  }
}

export const getGlobalConfig = async (): Promise<GlobalConfig | null> => {
  try {
    const uid = await getAuthenticatedUid();
    if (!uid) return null;
    const snap = await getDocWithRetry(doc(db, 'global_settings', 'config'));
    if (snap.exists()) {
      return snap.data() as GlobalConfig;
    }
  } catch {
    return null;
  }
  return null;
};

export const saveGlobalConfig = async (newConfig: GlobalConfig): Promise<void> => {
  try {
    await setDoc(doc(db, 'global_settings', 'config'), {
      ...newConfig,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'global_settings/config');
  }
};

export const subscribeToGlobalConfig = (callback: (config: GlobalConfig | null) => void) => {
  return onSnapshot(
    doc(db, 'global_settings', 'config'),
    (snap) => {
      callback(snap.exists() ? (snap.data() as GlobalConfig) : null);
    },
    (err) => {
      console.warn('[Firebase] Global config listener paused until sign-in:', err.message);
    }
  );
};

export const uploadDiagnosticLogs = async (logs: unknown[]) => {
  const uid = await getAuthenticatedUid();
  if (!uid) return;
  try {
    const logDoc = doc(db, 'users', uid, 'diagnostics', new Date().toISOString());
    await setDoc(logDoc, {
      logs,
      uploadedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
    });
  } catch {
    // Non-fatal diagnostic upload failure
  }
};

export const backupScheduleSettings = async (payload: {
  schedule: ClassSession[];
  customCategories: PersonalScheduleCategory[];
  selectedClassId?: string;
  selectedGrade?: string;
  selectedRoom?: string;
  role?: UserRole | null;
  settings: AppSettings;
  active: boolean;
}) => {
  const uid = await getAuthenticatedUid();
  if (!uid) return;

  try {
    await ensureUserProfile(auth.currentUser!, {
      role: payload.role || undefined,
      selectedClassId: payload.selectedClassId,
      selectedGrade: payload.selectedGrade,
      selectedRoom: payload.selectedRoom,
    });

    const dataToWrite: Record<string, unknown> = {
      schedule: payload.schedule,
      customCategories: payload.customCategories,
      settings: payload.settings,
      active: payload.active,
      updatedAt: new Date().toISOString(),
    };
    if (payload.selectedClassId) dataToWrite['selectedClassId'] = payload.selectedClassId;
    if (payload.selectedGrade) dataToWrite['selectedGrade'] = payload.selectedGrade;
    if (payload.selectedRoom) dataToWrite['selectedRoom'] = payload.selectedRoom;
    if (payload.role) dataToWrite['role'] = payload.role;

    await setDoc(doc(db, 'users', uid, 'backup', 'data'), dataToWrite);

    const enabledPersonal = (payload.customCategories || [])
      .filter((c) => c.enabled)
      .flatMap((c) =>
        (c.sessions || []).map((s) => ({ ...s, sourceCategoryName: c.name }))
      );

    await syncNotificationQueue(
      uid,
      [...payload.schedule, ...enabledPersonal],
      payload.settings,
      payload.active
    );
  } catch (err) {
    console.warn('[Firebase] Backup skipped or failed:', err);
  }
};

const syncNotificationQueue = async (
  uid: string,
  combinedSchedule: ClassSession[],
  settings: AppSettings,
  active: boolean
) => {
  try {
    const pendingQuery = query(
      collection(db, 'notifications'),
      where('userId', '==', uid),
      where('status', '==', 'pending')
    );
    const pendingSnaps = await getDocs(pendingQuery);

    const batch = writeBatch(db);
    pendingSnaps.forEach((snap) => {
      // Preserve active snooze or explicit test alarms
      if (!snap.id.startsWith('snooze_') && !snap.id.startsWith('test_')) {
        batch.delete(snap.ref);
      }
    });

    if (active && combinedSchedule.length > 0) {
      const now = new Date();
      const dayMap: Record<string, number> = {
        sunday: 0,
        monday: 1,
        tuesday: 2,
        wednesday: 3,
        thursday: 4,
        friday: 5,
        saturday: 6,
      };
      const preNotifyMinutes = settings.preNotifyMinutes ?? 3;
      const customHolidays = settings.calendarHolidays || {};

      for (let i = 0; i < 7; i++) {
        const targetDate = new Date(now);
        targetDate.setDate(targetDate.getDate() + i);
        const yyyy = targetDate.getFullYear();
        const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
        const dd = String(targetDate.getDate()).padStart(2, '0');
        const dateString = `${yyyy}-${mm}-${dd}`;

        if (isSchoolHoliday(dateString, customHolidays).isHoliday) continue;

        const targetDay = targetDate.getDay();
        for (const session of combinedSchedule) {
          if (!session.dayOfWeek || !session.startTime) continue;
          const sessionDay = dayMap[session.dayOfWeek.trim().toLowerCase()];
          if (sessionDay !== targetDay) continue;

          const name = session.subjectName || session.subjectCode || 'ไม่ระบุวิชา';
          if (name === 'พักเที่ยง' || name === 'พักกลางวัน') continue;

          const [startH, startM] = session.startTime.split(':').map(Number);
          let notifyH = startH;
          let notifyM = startM - preNotifyMinutes;
          while (notifyM < 0) {
            notifyM += 60;
            notifyH -= 1;
          }
          if (notifyH < 0) notifyH = ((notifyH % 24) + 24) % 24;

          const notifyTime = new Date(targetDate);
          notifyTime.setHours(notifyH, notifyM, 0, 0);

          if (notifyTime > now) {
            const notifId = `${uid.slice(0, 16)}_s_${session.id.replace(/[^a-zA-Z0-9_-]/g, '')}_${notifyTime.getTime()}`.slice(0, 120);
            const notifRef = doc(collection(db, 'notifications'), notifId);
            const prefix = session.sourceCategoryName ? `[${session.sourceCategoryName}] ` : '';

            const bodyLines = [
              preNotifyMinutes > 0
                ? `อีก ${preNotifyMinutes} นาทีจะเริ่มเรียน`
                : 'ได้เวลาเริ่มเรียน',
              `วิชา: ${name}`,
              `เวลา: ${session.startTime} น.`,
            ];
            if (settings.notifyRoom && session.room) bodyLines.push(`ห้อง: ${session.room}`);
            if (settings.notifyTeacher && session.teacher) bodyLines.push(`ผู้สอน: ${session.teacher}`);

            batch.set(notifRef, {
              userId: uid,
              sendAt: notifyTime.toISOString(),
              timestamp: notifyTime.getTime(),
              title:
                preNotifyMinutes > 0
                  ? `${prefix}แจ้งเตือนเข้าเรียน (ล่วงหน้า ${preNotifyMinutes} นาที)`
                  : `${prefix}แจ้งเตือนเริ่มคาบเรียน`,
              body: bodyLines.join('\n'),
              status: 'pending',
              createdAt: new Date().toISOString(),
            });
          }
        }
      }
    }

    await batch.commit();
  } catch (err) {
    console.warn('[Firebase] Queue sync note:', err);
  }
};

export const restoreScheduleSettings = async (): Promise<BackupCloudPayload | null> => {
  const uid = await getAuthenticatedUid();
  if (!uid) return null;

  try {
    const snap = await getDocWithRetry(doc(db, 'users', uid, 'backup', 'data'));
    if (snap.exists()) {
      return snap.data() as BackupCloudPayload;
    }
  } catch (err) {
    console.warn('[Firebase] Restore schedule settings note:', err);
  }
  return null;
};

function hashEndpoint(endpoint: string): string {
  let hash = 0;
  for (let i = 0; i < endpoint.length; i++) {
    hash = (hash << 5) - hash + endpoint.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function detectDeviceMeta() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isIpad =
    typeof navigator !== 'undefined' &&
    (/ipad|iphone|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  const os = isIpad ? 'iOS/iPadOS' : /android/i.test(ua) ? 'Android' : 'Desktop';
  const browser = /edg/i.test(ua)
    ? 'Edge'
    : /chrome|crios/i.test(ua)
      ? 'Chrome'
      : /safari/i.test(ua)
        ? 'Safari'
        : 'Other';
  return { os, browser };
}

export const savePushSubscriptionObject = async (subData: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}): Promise<boolean> => {
  const uid = await getAuthenticatedUid();
  if (!uid || !subData?.endpoint || !subData?.keys?.p256dh || !subData?.keys?.auth) {
    return false;
  }

  const subId = `${uid.slice(0, 20)}_${hashEndpoint(subData.endpoint)}`;
  const { os, browser } = detectDeviceMeta();

  try {
    await setDoc(
      doc(db, 'pushSubscriptions', subId),
      {
        userId: uid,
        endpoint: subData.endpoint,
        keys: subData.keys,
        os,
        browser,
        lastUsed: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      { merge: true }
    );
    localStorage.setItem('fcm_token_granted', 'true');
    return true;
  } catch (err) {
    console.warn('[Firebase] Failed saving push subscription:', err);
    return false;
  }
};

export const requestFirebaseNotificationPermission = async (): Promise<string | null> => {
  if (typeof window === 'undefined' || !('Notification' in window)) return null;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return null;

    const swRegistration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    await navigator.serviceWorker.ready;

    const res = await fetch('/api/push/vapidPublicKey');
    const { publicKey } = (await res.json()) as { publicKey: string };
    if (!publicKey) return null;

    const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
    const base64 = (publicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }

    let subscription = await swRegistration.pushManager.getSubscription();
    if (subscription) {
      // Check if existing subscription uses a different server key; re-subscribe if mismatched
      const existingKey = subscription.options?.applicationServerKey;
      if (existingKey) {
        const existingBytes = new Uint8Array(existingKey);
        const mismatch =
          existingBytes.length !== outputArray.length ||
          existingBytes.some((b, idx) => b !== outputArray[idx]);
        if (mismatch) {
          await subscription.unsubscribe().catch(() => undefined);
          subscription = null;
        }
      }
    }

    if (!subscription) {
      subscription = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: outputArray,
      });
    }

    const subData = JSON.parse(JSON.stringify(subscription)) as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };

    await savePushSubscriptionObject(subData);
    return subData.endpoint;
  } catch (error) {
    console.error('[Firebase] Notification permission / push subscribe error:', error);
    return null;
  }
};

export const sendServerTestPush = async (
  delaySeconds = 0,
  title?: string,
  body?: string
): Promise<{ scheduled: boolean; sentCount: number; totalSubs: number } | null> => {
  const uid = await getAuthenticatedUid();
  if (!uid) return null;

  try {
    const res = await fetch('/api/push/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: uid,
        delaySeconds,
        title,
        body,
      }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { scheduled: boolean; sentCount: number; totalSubs: number };
  } catch (err) {
    console.warn('[Firebase] Failed calling /api/push/test:', err);
    return null;
  }
};

export const scheduleServerPushSnooze = async (
  title: string,
  body: string,
  delaySeconds = 300
): Promise<boolean> => {
  const uid = await getAuthenticatedUid();
  if (!uid) return false;

  try {
    const res = await fetch('/api/push/snooze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: uid, title, body, delaySeconds }),
    });
    return res.ok;
  } catch {
    return false;
  }
};

export interface QueueItemSummary {
  id: string;
  sendAt: string;
  title: string;
  status: string;
}

export interface LogItemSummary {
  id: string;
  sentAt: string;
  status: string;
}

export const fetchDiagnosticInfo = async () => {
  const uid = await getAuthenticatedUid();
  let pushToken = typeof localStorage !== 'undefined' && localStorage.getItem('fcm_token_granted')
    ? 'Granted/Subscribed'
    : 'Not Subscribed';
  let subscriptionStatus = 'Inactive';
  let queueItems: QueueItemSummary[] = [];
  let logItems: LogItemSummary[] = [];
  let sCount = 0;
  let fCount = 0;

  if (!uid) {
    return { pushToken, subscriptionStatus, queueItems, logItems, sCount, fCount };
  }

  try {
    const subQuery = query(collection(db, 'pushSubscriptions'), where('userId', '==', uid), limit(5));
    const subSnaps = await getDocs(subQuery);
    if (!subSnaps.empty) {
      subscriptionStatus = 'Registered & Active';
      const first = subSnaps.docs[0].data();
      const ep = String(first['endpoint'] || '');
      pushToken = ep.slice(0, 48) + (ep.length > 48 ? '...' : '');
    }

    const qQuery = query(collection(db, 'notifications'), where('userId', '==', uid), limit(50));
    const qSnaps = await getDocs(qQuery);
    queueItems = qSnaps.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        sendAt: String(data['sendAt'] || ''),
        title: String(data['title'] || ''),
        status: String(data['status'] || ''),
      };
    });
    queueItems.sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime());

    const lQuery = query(collection(db, 'notificationLogs'), where('userId', '==', uid), limit(50));
    const lSnaps = await getDocs(lQuery);
    logItems = lSnaps.docs.map((d) => {
      const data = d.data();
      const status = String(data['status'] || '');
      if (status === 'sent') sCount++;
      if (status === 'failed') fCount++;
      return {
        id: d.id,
        sentAt: String(data['sentAt'] || ''),
        status,
      };
    });
    logItems.sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
  } catch (e) {
    console.warn('[Firebase] fetchDiagnosticInfo skipped:', e);
  }

  return { pushToken, subscriptionStatus, queueItems, logItems, sCount, fCount };
};

if (messaging) {
  onMessage(messaging, (payload) => {
    console.log('[Foreground] FCM message received:', payload);
  });
}

export { messaging };
