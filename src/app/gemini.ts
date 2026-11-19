import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { ClassSession } from './models';
import { Capacitor } from '@capacitor/core';

@Injectable({ providedIn: 'root' })
export class GeminiService {
  private http = inject(HttpClient);

  private resolveBackendBaseUrl(): string {
    if (Capacitor.isNativePlatform()) {
      return 'https://ais-dev-5ce7x4ii37m5xmqzzudf4v-123885007893.asia-southeast1.run.app';
    }
    if (typeof window !== 'undefined' && window.location?.origin) {
      const origin = window.location.origin;
      if (
        origin.includes('vercel.app') ||
        (!origin.includes('localhost') && !origin.includes('127.0.0.1') && !origin.includes('run.app'))
      ) {
        return 'https://ais-dev-5ce7x4ii37m5xmqzzudf4v-123885007893.asia-southeast1.run.app';
      }
      return origin;
    }
    return '';
  }

  async parseScheduleImage(base64Image: string, mimeType: string): Promise<ClassSession[]> {
    try {
      const apiBaseUrl = this.resolveBackendBaseUrl().replace(/\/$/, '');
      const payload = { base64Image, mimeType };

      const response = await lastValueFrom(
        this.http.post<ClassSession[]>(`${apiBaseUrl}/api/gemini/parse`, payload)
      );

      return response ?? [];
    } catch (error: unknown) {
      console.error('[GeminiService] Error parsing schedule via server API:', error);

      const err = error as {
        status?: number;
        message?: string;
        error?: { message?: string; error?: string };
      };
      const errMsg = err.error?.message || err.error?.error || err.message || String(error);
      const lowMsg = errMsg.toLowerCase();

      if (err.status === 405 || lowMsg.includes('405')) {
        throw new Error(
          'เซิร์ฟเวอร์ AI ปลายทางไม่รองรับคำขอ (405) กรุณารีโหลดแอปเพื่อให้เชื่อมต่อกับเซิร์ฟเวอร์หลักล่าสุด'
        );
      }
      if (
        err.status === 429 ||
        errMsg.includes('429') ||
        errMsg.includes('RESOURCE_EXHAUSTED') ||
        lowMsg.includes('quota')
      ) {
        throw new Error(
          'ระบบ AI มีการใช้งานเกินโควต้าชั่วคราว กรุณารอประมาณ 1 นาทีแล้วลองใหม่อีกครั้ง'
        );
      }
      if (
        err.status === 503 ||
        errMsg.includes('503') ||
        lowMsg.includes('unavailable') ||
        lowMsg.includes('high demand')
      ) {
        throw new Error('ระบบ AI กำลังหนาแน่นชั่วคราว กรุณากดลองใหม่อีกครั้ง');
      }
      throw new Error(`เกิดข้อผิดพลาดจากเซิร์ฟเวอร์ AI: ${errMsg}`);
    }
  }
}
