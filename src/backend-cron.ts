import admin from 'firebase-admin';

let isInitialized = false;

export function initFirebaseAdmin() {
  if (isInitialized) return;
  
  try {
    const serviceAccountStr = process.env['FIREBASE_SERVICE_ACCOUNT'];

    if (serviceAccountStr) {
      const serviceAccount = JSON.parse(serviceAccountStr);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('[Backend] Firebase Admin initialized with FIREBASE_SERVICE_ACCOUNT');
      isInitialized = true;
    } else if (process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
      admin.initializeApp();
      console.log('[Backend] Firebase Admin initialized with GOOGLE_APPLICATION_CREDENTIALS');
      isInitialized = true;
    } else {
      console.warn('[Backend] Missing FIREBASE_SERVICE_ACCOUNT. Background notifications will not work.');
    }
  } catch (error) {
    console.error('[Backend] Failed to initialize Firebase Admin:', error);
  }
}

// Map user settings 
interface UserSettings {
  preNotifyMinutes?: number;
}

interface ClassSession {
  id: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  subjectCode: string;
  subjectName: string;
  room: string;
  teacher: string;
}

export function startNotificationCron() {
  if (!isInitialized) return;

  const db = admin.firestore();
  
  // Checking every minute
  setInterval(async () => {
    try {
      const now = new Date();
      // Only process when exact minute changes (e.g., 10:00:00 -> 10:00:59)
      const dayIndex = now.getDay();
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const todayStr = days[dayIndex];
      
      const hours = now.getHours();
      const mins = now.getMinutes();

      // Get all users who have backup data
      const usersRef = db.collection('users');
      const snapshot = await usersRef.get();
      
      if (snapshot.empty) return;

      for (const userDoc of snapshot.docs) {
        const uid = userDoc.id;
        
        // 1. Get schedule config
        const dataDoc = await db.collection('users').doc(uid).collection('backup').doc('data').get();
        if (!dataDoc.exists) continue;
        
        const data = dataDoc.data();
        if (!data || !data['active']) continue; // Skip if notifications not active
        
        const schedule = (data['schedule'] || []) as ClassSession[];
        const settings = (data['settings'] || {}) as UserSettings;
        const preNotify = settings.preNotifyMinutes ?? 3;
        
        // 2. Filter classes for exact notification time match today
        for (const session of schedule) {
          if (session.dayOfWeek !== todayStr) continue;
          
          const [startH, startM] = session.startTime.split(':').map(Number);
          let notifyH = startH;
          let notifyM = startM - preNotify;
          while (notifyM < 0) {
            notifyM += 60;
            notifyH -= 1;
          }
          if (notifyH < 0) {
             notifyH = (notifyH % 24 + 24) % 24;  
          }
          
          if (notifyH === hours && notifyM === mins) {
            // Trigger push
            await sendPushForSession(uid, session);
          }
        }
      }

    } catch (err) {
      console.error('[Backend] Error in notification cron loop:', err);
    }
  }, 60000); // Check every 60 seconds
  
  console.log('[Backend] Background notification CRON started.');
}

async function sendPushForSession(uid: string, session: ClassSession) {
  try {
    const db = admin.firestore();
    const devicesSnap = await db.collection('users').doc(uid).collection('devices').get();
    
    if (devicesSnap.empty) {
       console.log(`[Backend] No devices found to notify for user ${uid}`);
       return;
    }
    
    const tokens: string[] = [];
    devicesSnap.forEach(doc => {
      if (doc.data()['token']) {
         tokens.push(doc.data()['token']);
      }
    });

    const isAfterSchool = (session.subjectName === 'เลิกเรียน' || !session.subjectName);

    const message = {
      notification: {
        title: isAfterSchool ? 'ได้เวลากลับบ้านแล้ว!' : `ถึงเวลาเรียน: ${session.subjectName} (${session.subjectCode})`,
        body: isAfterSchool ? 'ถึงเวลาปุ๊บก็กลับบ้านได้เลย' : `ที่ห้อง ${session.room} กับ ${session.teacher}`
      },
      tokens: tokens,
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`[Backend] Sent push to ${tokens.length} devices for ${uid}. Success: ${response.successCount}, Failures: ${response.failureCount}`);
  } catch (err) {
    console.error(`[Backend] Failed to send push for ${uid}:`, err);
  }
}
