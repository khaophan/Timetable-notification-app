import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';
import cors from 'cors';
import { GoogleGenAI, Type } from '@google/genai';
import {
  initPushWorker,
  getVapidPublicKeyAsync,
  processNotificationQueue,
  evaluateRealtimeSchedules,
  sendTestPushForUser,
  scheduleServerSnooze,
} from './server-push';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Boot background Web Push worker only in live serve/runtime mode
const isCliBuild =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv.some((a) => a === 'build' || a.endsWith('/build'));
const isServeOrRuntime =
  isMainModule(import.meta.url) ||
  Boolean(process.env['pm_id']) ||
  (typeof process !== 'undefined' &&
    Array.isArray(process.argv) &&
    process.argv.some((a) => a.includes('serve')));

if (!isCliBuild && isServeOrRuntime) {
  void initPushWorker();
}

app.use('/api', (_req, _res, next) => {
  void initPushWorker();
  next();
});

app.get('/api/push/vapidPublicKey', async (_req, res) => {
  try {
    const publicKey = await getVapidPublicKeyAsync();
    res.json({ publicKey });
  } catch (err) {
    console.error('[API] Failed to get VAPID key:', err);
    res.status(500).json({ error: 'Failed to retrieve VAPID public key' });
  }
});

app.get('/api/push/cron', async (_req, res) => {
  await processNotificationQueue();
  await evaluateRealtimeSchedules();
  res.json({ success: true, message: 'Notification queue and Bangkok schedules evaluated' });
});

app.post('/api/push/test', async (req, res) => {
  try {
    const { userId, delaySeconds, title, body } = req.body as {
      userId?: string;
      delaySeconds?: number;
      title?: string;
      body?: string;
    };

    if (!userId) {
      res.status(400).json({ error: 'Missing userId' });
      return;
    }

    const result = await sendTestPushForUser(
      userId,
      delaySeconds ?? 0,
      title || 'ทดสอบแจ้งเตือนพื้นหลัง ClassSync',
      body || 'แจ้งเตือนจริงจากเซิร์ฟเวอร์สำเร็จ! คุณสามารถพับหรือปัดปิดแอปได้อย่างมั่นใจ'
    );
    res.json({ success: true, ...result });
  } catch (err: unknown) {
    console.error('[API] Push test error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Push test failed' });
  }
});

app.post('/api/push/snooze', async (req, res) => {
  try {
    const { userId, title, body, delaySeconds } = req.body as {
      userId?: string;
      title?: string;
      body?: string;
      delaySeconds?: number;
    };

    if (!userId) {
      res.status(400).json({ error: 'Missing userId' });
      return;
    }

    const result = await scheduleServerSnooze(
      userId,
      title || 'แจ้งเตือนซ้ำ (เลื่อนเตือน 5 นาที)',
      body || 'ครบกำหนดเลื่อนเตือนแล้ว เตรียมตัวเข้าเรียนได้เลย',
      delaySeconds ?? 300
    );
    res.json({ success: true, ...result });
  } catch (err: unknown) {
    console.error('[API] Snooze error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Snooze failed' });
  }
});

const angularApp = new AngularNodeAppEngine({
  allowedHosts: [
    'localhost',
    'ais-dev-5ce7x4ii37m5xmqzzudf4v-123885007893.asia-southeast1.run.app',
    'ais-pre-5ce7x4ii37m5xmqzzudf4v-123885007893.asia-southeast1.run.app',
  ],
  trustProxyHeaders: true,
});

app.post('/api/gemini/parse', async (req, res) => {
  try {
    const { base64Image, mimeType } = req.body as {
      base64Image?: string;
      mimeType?: string;
    };

    if (!base64Image || !mimeType) {
      res.status(400).json({ error: 'Missing base64Image or mimeType' });
      return;
    }

    const key = process.env['GEMINI_API_KEY'];
    if (!key) {
      res.status(500).json({ error: 'GEMINI_API_KEY is not defined on the server' });
      return;
    }

    const ai = new GoogleGenAI({ apiKey: key });

    let response;
    let retries = 3;
    while (retries >= 0) {
      try {
        response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: {
            parts: [
              {
                inlineData: {
                  data: base64Image.split(',')[1] || base64Image,
                  mimeType,
                },
              },
              {
                text:
                  'Extract the class schedule from this image. Guidelines:\n' +
                  '1. Ensure all extracted text (Subject names, Teacher names) is in Thai if it appears in Thai in the image.\n' +
                  '2. If a subject name is missing but a subject code is present, DO NOT try to infer the subject name. Leave it as an empty string.\n' +
                  '3. Convert Day of Week to English like "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", or "Sunday".\n' +
                  '4. Ensure startTime and endTime are in "HH:MM" 24h format.\n' +
                  '5. If the schedule is in a grid, carefully map the times to the correct days.\n' +
                  '6. If a cell/slot in the 10th period (starting at 15:40) of the grid is empty/blank in the input image, set its subjectName to "เลิกเรียน" and keep subjectCode, room, and teacher as empty strings.',
              },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING, description: 'Generate a unique string ID' },
                  dayOfWeek: { type: Type.STRING, description: 'Day of week in English, e.g., Monday' },
                  startTime: { type: Type.STRING, description: 'Start time in HH:MM format' },
                  endTime: { type: Type.STRING, description: 'End time in HH:MM format' },
                  subjectCode: { type: Type.STRING, description: 'Subject code (e.g., ว30103)' },
                  subjectName: {
                    type: Type.STRING,
                    description: 'Subject name in Thai. Leave empty if not explicitly written.',
                  },
                  room: { type: Type.STRING, description: 'Room number or name' },
                  teacher: { type: Type.STRING, description: 'Teacher name' },
                },
                required: [
                  'id',
                  'dayOfWeek',
                  'startTime',
                  'endTime',
                  'subjectCode',
                  'subjectName',
                  'room',
                  'teacher',
                ],
              },
            },
          },
        });
        break;
      } catch (err: unknown) {
        const errorObject = err as { status?: number; message?: string; code?: number };
        const status = errorObject.status || errorObject.code || 0;
        const msg = errorObject.message || '';
        const isRetryable =
          status === 429 ||
          status === 503 ||
          msg.includes('429') ||
          msg.includes('503') ||
          msg.toLowerCase().includes('rate limit') ||
          msg.toLowerCase().includes('high demand') ||
          msg.toLowerCase().includes('unavailable');

        if (retries === 0 || !isRetryable) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 2500));
        retries--;
      }
    }

    if (!response || !response.text) {
      res.status(500).json({ error: 'No response returned from Gemini API' });
      return;
    }

    const parsed = JSON.parse(response.text);
    res.json(parsed);
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string; code?: number; error?: { message?: string } };
    const status = err.status || err.code || 500;
    const msg =
      err.message || (err.error && typeof err.error === 'object' ? err.error.message : '') || String(error);
    const lowMsg = msg.toLowerCase();

    if (
      status === 429 ||
      lowMsg.includes('429') ||
      lowMsg.includes('quota') ||
      lowMsg.includes('resource_exhausted') ||
      lowMsg.includes('too many requests')
    ) {
      res.status(429).json({
        error: 'RESOURCE_EXHAUSTED',
        message: 'ขออภัย ระบบมีการใช้งาน AI เกินโควต้าชั่วคราว กรุณารอสักครู่แล้วลองใหม่อีกครั้ง',
      });
    } else if (
      status === 503 ||
      lowMsg.includes('503') ||
      lowMsg.includes('unavailable') ||
      lowMsg.includes('high demand')
    ) {
      res.status(503).json({
        error: 'UNAVAILABLE',
        message: 'ระบบ AI มีผู้ใช้งานหนาแน่นชั่วคราว กรุณาลองส่งคำขอใหม่อีกครั้ง',
      });
    } else {
      console.error('Error parsing schedule with Gemini:', error);
      res.status(status >= 400 && status < 600 ? status : 500).json({ error: msg });
    }
  }
});

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  })
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  const originalHost = req.headers.host;
  const originalXForwardedHost = req.headers['x-forwarded-host'];

  req.headers.host = 'localhost';
  if (req.headers['x-forwarded-host']) {
    delete req.headers['x-forwarded-host'];
  }

  angularApp
    .handle(req)
    .then((response) => {
      req.headers.host = originalHost;
      if (originalXForwardedHost !== undefined) {
        req.headers['x-forwarded-host'] = originalXForwardedHost;
      }
      return response ? writeResponseToNodeResponse(response, res) : next();
    })
    .catch((err) => {
      req.headers.host = originalHost;
      if (originalXForwardedHost !== undefined) {
        req.headers['x-forwarded-host'] = originalXForwardedHost;
      }
      next(err);
    });
});

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 3000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }
    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
