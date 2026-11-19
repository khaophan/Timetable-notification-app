import { Injectable, signal, computed, effect, OnDestroy } from '@angular/core';
import {
  ClassSession,
  AppSettings,
  ActiveNotification,
  PersonalScheduleCategory,
  UserRole,
  ThemeMode,
} from './models';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import {
  backupScheduleSettings,
  restoreScheduleSettings,
  subscribeToGlobalConfig,
  GlobalConfig,
} from './firebase-client';

@Injectable({ providedIn: 'root' })
export class AppStore implements OnDestroy {
  readonly schedule = signal<ClassSession[]>([]);
  readonly customCategories = signal<PersonalScheduleCategory[]>([]);
  readonly selectedClassId = signal<string>('');
  readonly selectedGrade = signal<string>('');
  readonly selectedRoom = signal<string>('');
  readonly userRole = signal<UserRole | null>(null);
  readonly themeMode = signal<ThemeMode>('light');

  readonly settings = signal<AppSettings>({
    notifyTeacher: true,
    notifySubjectCode: true,
    notifySubjectName: true,
    notifyRoom: true,
    notifyEnd: true,
    popupDuration: 10,
    preNotifyMinutes: 3,
    calendarHolidays: {},
    themeMode: 'light',
  });

  readonly isActive = signal<boolean>(true);
  readonly activeNotification = signal<ActiveNotification | null>(null);
  readonly globalConfig = signal<GlobalConfig | null>(null);

  /** Combined effective timetable: official classroom schedule + enabled personal alarm categories */
  readonly effectiveSchedule = computed<ClassSession[]>(() => {
    const official = this.schedule();
    const personal = this.customCategories()
      .filter((cat) => cat.enabled)
      .flatMap((cat) =>
        cat.sessions.map((s) => ({
          ...s,
          sourceCategoryId: cat.id,
          sourceCategoryName: cat.name,
        }))
      );
    return [...official, ...personal];
  });

  private cloudSyncTimeout: ReturnType<typeof setTimeout> | undefined;
  private unsubscribeGlobalConfig: (() => void) | null = null;
  private initialized = false;

  constructor() {
    this.purgeLegacyCachedUrls();
    void this.loadState();

    if (typeof window !== 'undefined') {
      this.unsubscribeGlobalConfig = subscribeToGlobalConfig((config) => {
        if (config) {
          this.globalConfig.set(config);
          if (config.subjectMappings) {
            try {
              const localSaved = localStorage.getItem('subject_mappings') || '{}';
              const localMap = JSON.parse(localSaved) as Record<string, string>;
              const merged = { ...localMap, ...config.subjectMappings };
              localStorage.setItem('subject_mappings', JSON.stringify(merged));
            } catch {
              // Non-fatal
            }
          }
        }
      });
    }

    // Apply dark/light root class reactively
    effect(() => {
      const mode = this.themeMode();
      if (typeof document !== 'undefined') {
        document.documentElement.classList.toggle('dark', mode === 'dark');
        try {
          localStorage.setItem('app_theme_mode', mode);
        } catch {
          // Ignore storage error
        }
      }
    });

    // Persist local & cloud state smoothly
    effect(() => {
      const currentSchedule = this.schedule();
      const currentCategories = this.customCategories();
      const currentSettings = this.settings();
      const currentActive = this.isActive();
      const classId = this.selectedClassId();
      const grade = this.selectedGrade();
      const room = this.selectedRoom();
      const role = this.userRole();

      if (!this.initialized) return;

      void this.persistLocal(
        currentSchedule,
        currentCategories,
        currentSettings,
        currentActive,
        classId,
        grade,
        room,
        role
      );

      if (this.cloudSyncTimeout) clearTimeout(this.cloudSyncTimeout);
      this.cloudSyncTimeout = setTimeout(() => {
        void this.syncNow();
      }, 1500);
    });
  }

  ngOnDestroy(): void {
    if (this.cloudSyncTimeout) clearTimeout(this.cloudSyncTimeout);
    if (this.unsubscribeGlobalConfig) this.unsubscribeGlobalConfig();
  }

  private purgeLegacyCachedUrls(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const cachedUrl = localStorage.getItem('backend_api_url') || '';
      if (cachedUrl.includes('timetable-notification.vercel.app')) {
        localStorage.removeItem('backend_api_url');
      }
    } catch {
      // Ignore
    }
  }

  private async persistLocal(
    schedule: ClassSession[],
    customCategories: PersonalScheduleCategory[],
    settings: AppSettings,
    active: boolean,
    classId: string,
    grade: string,
    room: string,
    role: UserRole | null
  ) {
    try {
      if (Capacitor.isNativePlatform()) {
        await Preferences.set({ key: 'sched_schedule', value: JSON.stringify(schedule) });
        await Preferences.set({ key: 'sched_categories', value: JSON.stringify(customCategories) });
        await Preferences.set({ key: 'sched_settings', value: JSON.stringify(settings) });
        await Preferences.set({ key: 'sched_active', value: JSON.stringify(active) });
        await Preferences.set({ key: 'sched_class_id', value: classId });
        await Preferences.set({ key: 'sched_grade', value: grade });
        await Preferences.set({ key: 'sched_room', value: room });
        if (role) await Preferences.set({ key: 'sched_role', value: role });
      } else if (typeof localStorage !== 'undefined') {
        localStorage.setItem('sched_schedule', JSON.stringify(schedule));
        localStorage.setItem('sched_categories', JSON.stringify(customCategories));
        localStorage.setItem('sched_settings', JSON.stringify(settings));
        localStorage.setItem('sched_active', JSON.stringify(active));
        localStorage.setItem('sched_class_id', classId);
        localStorage.setItem('sched_grade', grade);
        localStorage.setItem('sched_room', room);
        if (role) localStorage.setItem('sched_role', role);
      }
    } catch (e) {
      console.warn('[AppStore] Local save warning:', e);
    }
  }

  async syncNow(): Promise<void> {
    await backupScheduleSettings({
      schedule: this.schedule(),
      customCategories: this.customCategories(),
      selectedClassId: this.selectedClassId(),
      selectedGrade: this.selectedGrade(),
      selectedRoom: this.selectedRoom(),
      role: this.userRole(),
      settings: this.settings(),
      active: this.isActive(),
    });
  }

  private cleanUpSchedule(list: ClassSession[]): ClassSession[] {
    return list.map((session) => {
      if (session.startTime === '15:40') {
        const trimmedCode = (session.subjectCode || '').trim();
        const trimmedName = (session.subjectName || '').trim();
        const trimmedTeacher = (session.teacher || '').trim();
        const trimmedRoom = (session.room || '').trim();

        if (
          (!trimmedCode && !trimmedTeacher && !trimmedRoom) ||
          ((trimmedName === 'โฮมรูม' || !trimmedName) &&
            !trimmedCode &&
            !trimmedTeacher &&
            !trimmedRoom) ||
          trimmedName === 'เลิกเรียน'
        ) {
          return {
            ...session,
            subjectCode: '',
            subjectName: 'เลิกเรียน',
            teacher: '',
            room: '',
          };
        }
      }
      return session;
    });
  }

  private async loadState() {
    try {
      let storedSchedule: string | null = null;
      let storedCategories: string | null = null;
      let storedSettings: string | null = null;
      let storedActive: string | null = null;
      let storedClassId: string | null = null;
      let storedGrade: string | null = null;
      let storedRoom: string | null = null;
      let storedRole: string | null = null;
      let storedTheme: string | null = null;

      if (Capacitor.isNativePlatform()) {
        storedSchedule = (await Preferences.get({ key: 'sched_schedule' })).value;
        storedCategories = (await Preferences.get({ key: 'sched_categories' })).value;
        storedSettings = (await Preferences.get({ key: 'sched_settings' })).value;
        storedActive = (await Preferences.get({ key: 'sched_active' })).value;
        storedClassId = (await Preferences.get({ key: 'sched_class_id' })).value;
        storedGrade = (await Preferences.get({ key: 'sched_grade' })).value;
        storedRoom = (await Preferences.get({ key: 'sched_room' })).value;
        storedRole = (await Preferences.get({ key: 'sched_role' })).value;
      } else if (typeof localStorage !== 'undefined') {
        storedSchedule = localStorage.getItem('sched_schedule');
        storedCategories = localStorage.getItem('sched_categories');
        storedSettings = localStorage.getItem('sched_settings');
        storedActive = localStorage.getItem('sched_active');
        storedClassId = localStorage.getItem('sched_class_id');
        storedGrade = localStorage.getItem('sched_grade');
        storedRoom = localStorage.getItem('sched_room');
        storedRole = localStorage.getItem('sched_role');
        storedTheme = localStorage.getItem('app_theme_mode');
      }

      if (storedSchedule) {
        this.schedule.set(this.cleanUpSchedule(JSON.parse(storedSchedule)));
      }
      if (storedCategories) {
        this.customCategories.set(JSON.parse(storedCategories));
      }
      if (storedSettings) {
        const parsed = JSON.parse(storedSettings) as AppSettings;
        this.settings.update((s) => ({ ...s, ...parsed }));
        if (parsed.themeMode === 'dark' || parsed.themeMode === 'light') {
          this.themeMode.set(parsed.themeMode);
        }
      }
      if (storedTheme === 'dark' || storedTheme === 'light') {
        this.themeMode.set(storedTheme);
      } else if (
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
      ) {
        this.themeMode.set('dark');
      }

      if (storedActive !== null) this.isActive.set(JSON.parse(storedActive));
      if (storedClassId) this.selectedClassId.set(storedClassId);
      if (storedGrade) this.selectedGrade.set(storedGrade);
      if (storedRoom) this.selectedRoom.set(storedRoom);
      if (storedRole === 'admin' || storedRole === 'student') {
        this.userRole.set(storedRole);
      }
    } catch (e) {
      console.error('[AppStore] Failed to load state:', e);
    } finally {
      this.initialized = true;
    }
  }

  async restoreFromCloud() {
    try {
      const data = await restoreScheduleSettings();
      if (data) {
        if (Array.isArray(data.schedule)) {
          this.schedule.set(this.cleanUpSchedule(data.schedule));
        }
        if (Array.isArray(data.customCategories)) {
          this.customCategories.set(data.customCategories);
        }
        if (data.settings) {
          this.settings.update((s) => ({ ...s, ...data.settings }));
          if (data.settings.themeMode === 'dark' || data.settings.themeMode === 'light') {
            this.themeMode.set(data.settings.themeMode);
          }
        }
        if (data.active !== undefined) this.isActive.set(data.active);
        if (data.selectedClassId) this.selectedClassId.set(data.selectedClassId);
        if (data.selectedGrade) this.selectedGrade.set(data.selectedGrade);
        if (data.selectedRoom) this.selectedRoom.set(data.selectedRoom);
      }
      return data;
    } catch (e) {
      console.warn('[AppStore] Restore from cloud warning:', e);
      return null;
    }
  }

  setThemeMode(mode: ThemeMode) {
    this.themeMode.set(mode);
    this.settings.update((s) => ({ ...s, themeMode: mode }));
  }

  toggleThemeMode() {
    this.setThemeMode(this.themeMode() === 'dark' ? 'light' : 'dark');
  }

  setUserRole(role: UserRole | null) {
    this.userRole.set(role);
    if (typeof localStorage !== 'undefined') {
      if (role) localStorage.setItem('sched_role', role);
      else localStorage.removeItem('sched_role');
    }
  }

  setSelectedClassroom(classId: string, grade: string, room: string, sessions: ClassSession[]) {
    this.selectedClassId.set(classId);
    this.selectedGrade.set(grade);
    this.selectedRoom.set(room);
    this.schedule.set(this.cleanUpSchedule(sessions));
  }

  updateSchedule(newSchedule: ClassSession[]) {
    this.schedule.set(this.cleanUpSchedule(newSchedule));
  }

  addPersonalCategory(name: string): PersonalScheduleCategory {
    const newCat: PersonalScheduleCategory = {
      id: `cat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim(),
      enabled: true,
      sessions: [],
    };
    this.customCategories.update((list) => [...list, newCat]);
    return newCat;
  }

  togglePersonalCategory(catId: string) {
    this.customCategories.update((list) =>
      list.map((c) => (c.id === catId ? { ...c, enabled: !c.enabled } : c))
    );
  }

  deletePersonalCategory(catId: string) {
    this.customCategories.update((list) => list.filter((c) => c.id !== catId));
  }

  renamePersonalCategory(catId: string, newName: string) {
    this.customCategories.update((list) =>
      list.map((c) => (c.id === catId ? { ...c, name: newName.trim() || c.name } : c))
    );
  }

  addSessionToPersonalCategory(catId: string, session: Omit<ClassSession, 'id'>) {
    const newSess: ClassSession = {
      ...session,
      id: `psess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      sourceCategoryId: catId,
    };
    this.customCategories.update((list) =>
      list.map((c) => (c.id === catId ? { ...c, sessions: [...c.sessions, newSess] } : c))
    );
  }

  removeSessionFromPersonalCategory(catId: string, sessionId: string) {
    this.customCategories.update((list) =>
      list.map((c) =>
        c.id === catId
          ? { ...c, sessions: c.sessions.filter((s) => s.id !== sessionId) }
          : c
      )
    );
  }

  updateSettings(newSettings: Partial<AppSettings>) {
    this.settings.update((s) => ({ ...s, ...newSettings }));
  }

  toggleActive(active: boolean) {
    this.isActive.set(active);
  }

  clearClassroomSelection() {
    this.selectedClassId.set('');
    this.selectedGrade.set('');
    this.selectedRoom.set('');
    this.schedule.set([]);
  }

  async resetAll() {
    this.schedule.set([]);
    this.customCategories.set([]);
    this.selectedClassId.set('');
    this.selectedGrade.set('');
    this.selectedRoom.set('');
    this.settings.set({
      notifyTeacher: true,
      notifySubjectCode: true,
      notifySubjectName: true,
      notifyRoom: true,
      notifyEnd: true,
      popupDuration: 10,
      preNotifyMinutes: 3,
      calendarHolidays: {},
      themeMode: this.themeMode(),
    });
    this.isActive.set(true);
    this.activeNotification.set(null);

    try {
      if (Capacitor.isNativePlatform()) {
        await Preferences.remove({ key: 'sched_schedule' });
        await Preferences.remove({ key: 'sched_categories' });
        await Preferences.remove({ key: 'sched_settings' });
        await Preferences.remove({ key: 'sched_active' });
        await Preferences.remove({ key: 'sched_class_id' });
        await Preferences.remove({ key: 'sched_grade' });
        await Preferences.remove({ key: 'sched_room' });
      } else if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('sched_schedule');
        localStorage.removeItem('sched_categories');
        localStorage.removeItem('sched_settings');
        localStorage.removeItem('sched_active');
        localStorage.removeItem('sched_class_id');
        localStorage.removeItem('sched_grade');
        localStorage.removeItem('sched_room');
      }
    } catch {
      // Ignore clear error
    }
  }
}
