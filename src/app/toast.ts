import { Injectable, signal } from '@angular/core';

export interface ToastMessage {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  resolve: (result: boolean) => void;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<ToastMessage[]>([]);
  readonly confirmDialog = signal<ConfirmState | null>(null);

  show(
    message: string,
    type: ToastMessage['type'] = 'info',
    title = '',
    durationMs = 4500
  ): void {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const defaultTitles: Record<ToastMessage['type'], string> = {
      info: 'แจ้งเตือนระบบ',
      success: 'สำเร็จ',
      warning: 'ข้อควรทราบ',
      error: 'เกิดข้อผิดพลาด',
    };

    const item: ToastMessage = {
      id,
      title: title || defaultTitles[type],
      message,
      type,
    };

    this.toasts.update((list) => [item, ...list].slice(0, 4));
    if (durationMs > 0) {
      setTimeout(() => this.dismiss(id), durationMs);
    }
  }

  dismiss(id: string): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  confirm(
    title: string,
    message: string,
    confirmLabel = 'ยืนยัน',
    cancelLabel = 'ยกเลิก',
    destructive = false
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.confirmDialog.set({
        title,
        message,
        confirmLabel,
        cancelLabel,
        destructive,
        resolve,
      });
    });
  }

  resolveConfirm(result: boolean): void {
    const current = this.confirmDialog();
    if (current) {
      this.confirmDialog.set(null);
      current.resolve(result);
    }
  }
}
