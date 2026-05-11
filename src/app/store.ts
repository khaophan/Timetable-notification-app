import { Injectable, signal, effect } from '@angular/core';
import { ClassSession, AppSettings, ActiveNotification } from './models';

@Injectable({ providedIn: 'root' })
export class AppStore {
  readonly schedule = signal<ClassSession[]>([]);
  readonly settings = signal<AppSettings>({
    notifyTeacher: true,
    notifySubjectCode: true,
    notifySubjectName: true,
    notifyRoom: true,
    notifyEnd: true,
    popupDuration: 10,
  });
  readonly isActive = signal<boolean>(true);
  readonly activeNotification = signal<ActiveNotification | null>(null);

  constructor() {
    this.loadState();
    
    // Save state on change
    effect(() => {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('sched_schedule', JSON.stringify(this.schedule()));
          localStorage.setItem('sched_settings', JSON.stringify(this.settings()));
          localStorage.setItem('sched_active', JSON.stringify(this.isActive()));
        }
      } catch (e) {
        console.warn('Failed to save state to localStorage:', e);
      }
    });
  }

  private loadState() {
    if (typeof localStorage === 'undefined') return;
    try {
      const storedSchedule = localStorage.getItem('sched_schedule');
      if (storedSchedule) this.schedule.set(JSON.parse(storedSchedule));

      const storedSettings = localStorage.getItem('sched_settings');
      if (storedSettings) this.settings.set(JSON.parse(storedSettings));

      const storedActive = localStorage.getItem('sched_active');
      if (storedActive !== null) this.isActive.set(JSON.parse(storedActive));
    } catch (e) {
      console.error('Failed to load state', e);
    }
  }

  updateSchedule(newSchedule: ClassSession[]) {
    this.schedule.set(newSchedule);
  }

  updateSettings(newSettings: Partial<AppSettings>) {
    this.settings.update(s => ({ ...s, ...newSettings }));
  }

  toggleActive(active: boolean) {
    this.isActive.set(active);
  }
}
