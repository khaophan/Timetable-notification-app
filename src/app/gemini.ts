import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { ClassSession } from './models';
import { environment } from '../environments/environment';

@Injectable({ providedIn: 'root' })
export class GeminiService {
  constructor(private http: HttpClient) {}

  async parseScheduleImage(base64Image: string, mimeType: string): Promise<ClassSession[]> {
    try {
      // Use environment.API_URL if configured, otherwise use relative path
      const apiUrl = (environment as any).API_URL || '';
      
      const payload = {
        base64Image,
        mimeType
      };

      const response = await lastValueFrom(
        this.http.post<ClassSession[]>(`${apiUrl}/api/gemini/parse`, payload)
      );

      return response ?? [];
    } catch (error: any) {
      console.error('Error parsing schedule via backend API:', error);
      
      const errMsg = error.error?.error || error.message || String(error);
      if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
        throw new Error('ขออภัย ระบบมีการใช้งาน AI เกินโควต้าฟรีที่กำหนดชั่วคราว กรุณารอสักครู่ (ประมาณ 1 นาที) แล้วลองใหม่อีกครั้ง');
      } else {
        throw new Error(`เกิดข้อผิดพลาดจาก Backend AI: ${errMsg}`);
      }
    }
  }
}
