import { Injectable, signal, effect } from '@angular/core';
import { ClassSession, AppSettings, ActiveNotification } from './models';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';

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
      const currentSchedule = this.schedule();
      const currentSettings = this.settings();
      const currentActive = this.isActive();
      
      const saveAsync = async () => {
        try {
          if (Capacitor.isNativePlatform()) {
            await Preferences.set({ key: 'sched_schedule', value: JSON.stringify(currentSchedule) });
            await Preferences.set({ key: 'sched_settings', value: JSON.stringify(currentSettings) });
            await Preferences.set({ key: 'sched_active', value: JSON.stringify(currentActive) });
          } else if (typeof localStorage !== 'undefined') {
            localStorage.setItem('sched_schedule', JSON.stringify(currentSchedule));
            localStorage.setItem('sched_settings', JSON.stringify(currentSettings));
            localStorage.setItem('sched_active', JSON.stringify(currentActive));
          }
        } catch (e) {
          console.warn('Failed to save state:', e);
        }
      };
      
      saveAsync();
    });
  }

  private async loadState() {
    try {
      let storedSchedule: string | null = null;
      let storedSettings: string | null = null;
      let storedActive: string | null = null;

      if (Capacitor.isNativePlatform()) {
        storedSchedule = (await Preferences.get({ key: 'sched_schedule' })).value;
        storedSettings = (await Preferences.get({ key: 'sched_settings' })).value;
        storedActive = (await Preferences.get({ key: 'sched_active' })).value;
      } else if (typeof localStorage !== 'undefined') {
        storedSchedule = localStorage.getItem('sched_schedule');
        storedSettings = localStorage.getItem('sched_settings');
        storedActive = localStorage.getItem('sched_active');
      }

      if (storedSchedule) this.schedule.set(JSON.parse(storedSchedule));
      if (storedSettings) this.settings.set(JSON.parse(storedSettings));
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
