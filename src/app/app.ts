import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { Capacitor } from '@capacitor/core';
import { onAuthStateChanged, User } from 'firebase/auth';

import { AppStore } from './store';
import { GeminiService } from './gemini';
import { NotificationService } from './notification';
import { PwaService } from './pwa';
import { ToastService } from './toast';
import { StudyAnalytics } from './study-analytics';
import {
  AppSettings,
  ClassScheduleDoc,
  ClassSession,
  DEFAULT_SUBJECT_MAPPINGS,
  GRADE_LEVELS,
  PersonalScheduleCategory,
  UserRole,
} from './models';
import { CalendarDay, CalendarMonth, PUBLIC_HOLIDAYS_2026, THAI_MONTHS } from './calendar';
import {
  DAYS_ORDER,
  formatDateYYYYMMDD,
  isSchoolHoliday,
  subtractMinutesFormatted,
  translateDay,
} from './schedule-utils';
import {
  ADMIN_EMAIL,
  auth,
  deletePublishedClassSchedule,
  fetchDiagnosticInfo,
  fetchPublishedClassSchedules,
  LogItemSummary,
  logout,
  QueueItemSummary,
  saveGlobalConfig,
  savePublishedClassSchedule,
  signInWithGoogle,
  subscribeToPublishedClassSchedules,
  testFirestoreConnection,
} from './firebase-client';

export type AppStage = 'splash' | 'role-gate' | 'auth-gate' | 'classroom-picker' | 'workspace';
export type AppTab = 'home' | 'schedule' | 'analytics' | 'calendar' | 'settings' | 'admin';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [CommonModule, ReactiveFormsModule, MatIconModule, StudyAnalytics],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {
  readonly store = inject(AppStore);
  readonly gemini = inject(GeminiService);
  readonly notification = inject(NotificationService);
  readonly pwa = inject(PwaService);
  readonly toast = inject(ToastService);

  // Stage & Navigation State
  readonly appStage = signal<AppStage>('splash');
  readonly activeTab = signal<AppTab>('home');
  readonly selectedGateRole = signal<UserRole | null>(null);
  readonly currentUser = signal<User | null>(null);
  readonly authReady = signal<boolean>(false);
  readonly isProcessing = signal<boolean>(false);
  readonly currentTime = signal<Date>(new Date());

  // Published classrooms (strictly filtered to non-empty sessions)
  readonly publishedClasses = signal<ClassScheduleDoc[]>([]);
  readonly pickerGrade = signal<string>('');
  readonly pickerRoom = signal<string>('');

  // Permissions & Push Readiness
  readonly notificationPermission = signal<string>('default');
  readonly bgTestCountdown = signal<number>(0);

  // Personal Category UI State (Student Alarm Categories)
  readonly expandedCategoryId = signal<string | null>(null);

  // Calendar / Holiday Modal State
  readonly selectedDate = signal<CalendarDay | null>(null);
  readonly showHolidayEditor = signal<boolean>(false);

  // Admin Draft & Diagnostics State
  readonly adminDraftSessions = signal<ClassSession[]>([]);
  readonly editingSession = signal<ClassSession | null>(null);
  readonly subjectMappings = signal<Record<string, string>>({});
  readonly pushToken = signal<string | null>(null);
  readonly pushSubscriptionStatus = signal<string>('ยังไม่ได้ลงทะเบียน');
  readonly notificationQueueItems = signal<QueueItemSummary[]>([]);
  readonly notificationLogsItems = signal<LogItemSummary[]>([]);
  readonly notificationSuccessCount = signal<number>(0);
  readonly notificationFailedCount = signal<number>(0);

  readonly gradeOptions = GRADE_LEVELS;
  readonly daysOrder = DAYS_ORDER;

  // Derived Role & Classroom Computed Signals
  readonly isAdminLoggedIn = computed(() => {
    const user = this.currentUser();
    return Boolean(user && user.email === ADMIN_EMAIL);
  });

  readonly isStudentMode = computed(() => this.store.userRole() === 'student' || !this.isAdminLoggedIn());

  readonly availableGrades = computed(() => {
    const set = new Set<string>();
    for (const c of this.publishedClasses()) {
      if (c.sessions && c.sessions.length > 0 && c.grade) {
        set.add(c.grade);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'th'));
  });

  readonly availableRoomsForPickerGrade = computed(() => {
    const g = this.pickerGrade();
    if (!g) return [];
    return this.publishedClasses()
      .filter((c) => c.grade === g && c.sessions && c.sessions.length > 0)
      .sort((a, b) => a.room.localeCompare(b.room, undefined, { numeric: true }));
  });

  readonly selectedPickerClassDoc = computed(() => {
    const g = this.pickerGrade();
    const r = this.pickerRoom();
    if (!g || !r) return null;
    return this.publishedClasses().find((c) => c.grade === g && c.room === r) || null;
  });

  readonly preNotifyMinutes = computed(() => this.store.settings().preNotifyMinutes ?? 3);

  // Reactive Forms (Strictly NO FormsModule / ngModel!)
  readonly newCategoryForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  readonly newPersonalSessionForm = new FormGroup({
    dayOfWeek: new FormControl('Monday', { nonNullable: true, validators: [Validators.required] }),
    startTime: new FormControl('16:30', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d$/)],
    }),
    endTime: new FormControl('17:30', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d$/)],
    }),
    subjectName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    room: new FormControl('', { nonNullable: true }),
    teacher: new FormControl('', { nonNullable: true }),
  });

  readonly holidayForm = new FormGroup({
    holidayName: new FormControl('', { nonNullable: true }),
  });

  readonly editSessionForm = new FormGroup({
    id: new FormControl('', { nonNullable: true }),
    dayOfWeek: new FormControl('Monday', { nonNullable: true, validators: [Validators.required] }),
    startTime: new FormControl('08:30', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d$/)],
    }),
    endTime: new FormControl('09:20', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d$/)],
    }),
    subjectCode: new FormControl('', { nonNullable: true }),
    subjectName: new FormControl('', { nonNullable: true }),
    room: new FormControl('', { nonNullable: true }),
    teacher: new FormControl('', { nonNullable: true }),
  });

  readonly adminPublishForm = new FormGroup({
    grade: new FormControl('ม.4', { nonNullable: true, validators: [Validators.required] }),
    room: new FormControl('1', { nonNullable: true, validators: [Validators.required] }),
  });

  readonly adminMappingForm = new FormGroup({
    code: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  readonly adminBroadcastForm = new FormGroup({
    broadcastText: new FormControl('', { nonNullable: true }),
  });

  // Schedule & Day Computed Helpers
  readonly groupedSchedule = computed(() => {
    const list = this.store.effectiveSchedule();
    const result: { day: string; classes: ClassSession[] }[] = [];
    for (const day of DAYS_ORDER) {
      const classes = list
        .filter((c) => c.dayOfWeek === day)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
      if (classes.length > 0) result.push({ day, classes });
    }
    return result;
  });

  readonly currentDaySchedule = computed(() => {
    const list = this.store.effectiveSchedule();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayStr = days[this.currentTime().getDay()];
    return list
      .filter((c) => c.dayOfWeek === todayStr)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  });

  readonly todayHolidayInfo = computed(() =>
    isSchoolHoliday(
      formatDateYYYYMMDD(this.currentTime()),
      this.store.settings().calendarHolidays || {}
    )
  );

  readonly isSchoolOutForToday = computed(() => {
    if (this.todayHolidayInfo().isHoliday) return true;
    const todayList = this.currentDaySchedule();
    if (todayList.length === 0) return true;
    return todayList.every((s) => this.getClassStatus(s) === 'past');
  });

  readonly nextSchoolDayInfo = computed(() => {
    const list = this.store.effectiveSchedule();
    if (list.length === 0) return null;
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const customHolidays = this.store.settings().calendarHolidays || {};
    const today = this.currentTime();

    for (let i = 1; i <= 30; i++) {
      const checkDate = new Date(today);
      checkDate.setDate(checkDate.getDate() + i);
      const dateStr = formatDateYYYYMMDD(checkDate);
      if (isSchoolHoliday(dateStr, customHolidays).isHoliday) continue;

      const checkStr = days[checkDate.getDay()];
      const classes = list
        .filter((c) => c.dayOfWeek === checkStr)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
      return { day: checkStr, isTomorrow: i === 1, classes };
    }
    return null;
  });

  readonly todaySmartSummary = computed(() => {
    const h = this.todayHolidayInfo();
    if (h.isHoliday) return `วันนี้เป็นวันหยุด (${h.name}) พักผ่อนให้เต็มที่`;
    const count = this.currentDaySchedule().length;
    if (count === 0) return 'วันนี้ยังไม่มีรายการคาบเรียน';
    if (this.isSchoolOutForToday()) return 'วันนี้เรียนครบทุกคาบแล้ว';
    return `วันนี้มีตารางทั้งหมด ${count} รายการ`;
  });

  readonly timeUntilNextAlarmText = computed(() => {
    const next = this.notification.nextAlarm();
    if (!next) return '';
    const diffMs = next.time.getTime() - this.currentTime().getTime();
    if (diffMs <= 0) return 'กำลังถึงเวลา...';
    const diffMins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    if (hours > 24) {
      return `อีก ${Math.floor(hours / 24)} วัน ${hours % 24} ชม.`;
    }
    if (hours > 0) {
      return `อีก ${hours} ชม. ${mins} นาที`;
    }
    return `อีก ${mins} นาที`;
  });

  readonly calendarMonths = computed<CalendarMonth[]>(() => {
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth();
    const customHolidays = this.store.settings().calendarHolidays || {};
    const months: CalendarMonth[] = [];

    for (let m = currentMonth; m < 12; m++) {
      const monthDays: CalendarDay[] = [];
      const firstDay = new Date(currentYear, m, 1);
      const lastDay = new Date(currentYear, m + 1, 0);
      const padding = firstDay.getDay();

      for (let i = 0; i < padding; i++) {
        monthDays.push({
          date: new Date(currentYear, m, 1 - (padding - i)),
          dateString: '',
          isToday: false,
          isCurrentMonth: false,
          isWeekend: false,
        });
      }

      for (let d = 1; d <= lastDay.getDate(); d++) {
        const date = new Date(currentYear, m, d);
        const dateString = formatDateYYYYMMDD(date);
        const isToday =
          date.getDate() === today.getDate() &&
          date.getMonth() === today.getMonth() &&
          date.getFullYear() === today.getFullYear();
        const isWeekend = date.getDay() === 0 || date.getDay() === 6;

        const dayItem: CalendarDay = {
          date,
          dateString,
          isToday,
          isCurrentMonth: true,
          isWeekend,
        };

        if (customHolidays[dateString]) {
          dayItem.holidayName = customHolidays[dateString];
          dayItem.isCustomHoliday = true;
        } else if (PUBLIC_HOLIDAYS_2026[dateString]) {
          dayItem.holidayName = PUBLIC_HOLIDAYS_2026[dateString];
          dayItem.isCustomHoliday = false;
        } else if (isWeekend) {
          dayItem.holidayName = date.getDay() === 0 ? 'วันอาทิตย์' : 'วันเสาร์';
          dayItem.isCustomHoliday = true;
        }

        monthDays.push(dayItem);
      }

      months.push({
        year: currentYear,
        month: m,
        name: THAI_MONTHS[m],
        days: monthDays,
      });
    }
    return months;
  });

  readonly readinessScore = computed(() => {
    let score = 100;
    if (this.notificationPermission() !== 'granted') score -= 45;
    if (this.pwa.needsIosHomeScreenInstall()) score -= 25;
    if (
      !Capacitor.isNativePlatform() &&
      this.notificationPermission() === 'granted' &&
      this.pushSubscriptionStatus() !== 'Registered & Active'
    ) {
      score -= 15;
    }
    return Math.max(0, score);
  });

  private clockTimer?: ReturnType<typeof setInterval>;
  private splashTimer?: ReturnType<typeof setTimeout>;
  private bgTestInterval?: ReturnType<typeof setInterval>;
  private unsubscribeClasses: (() => void) | null = null;
  private unsubscribeAuth: (() => void) | null = null;

  constructor() {
    effect(() => {
      const cfg = this.store.globalConfig();
      if (cfg) {
        this.adminBroadcastForm.patchValue(
          { broadcastText: cfg.broadcastText || '' },
          { emitEvent: false }
        );
        if (cfg.subjectMappings) {
          this.subjectMappings.set(cfg.subjectMappings);
        }
      }
    });

    this.editSessionForm.get('subjectCode')?.valueChanges.subscribe((val) => {
      if (!val) return;
      const cleanCode = val.trim().toUpperCase();
      const matchedName = this.subjectMappings()[cleanCode] || DEFAULT_SUBJECT_MAPPINGS[cleanCode];
      const nameCtrl = this.editSessionForm.get('subjectName');
      if (matchedName && nameCtrl && !nameCtrl.value.trim()) {
        nameCtrl.setValue(matchedName, { emitEvent: false });
      }
    });
  }

  async ngOnInit() {
    this.notification.startChecking();

    if (typeof window !== 'undefined') {
      void testFirestoreConnection();

      this.clockTimer = setInterval(() => {
        this.currentTime.set(new Date());
      }, 1000);

      // Load local subject mappings
      const savedMap = localStorage.getItem('subject_mappings');
      if (savedMap) {
        try {
          this.subjectMappings.set(JSON.parse(savedMap));
        } catch {
          // Ignore
        }
      }

      this.unsubscribeAuth = onAuthStateChanged(auth, (user) => {
        this.currentUser.set(user);
        this.authReady.set(true);
        if (user) {
          this.store.startRealtimeListeners();
          if (!this.unsubscribeClasses) {
            this.unsubscribeClasses = subscribeToPublishedClassSchedules((classes) => {
              this.publishedClasses.set(classes);
              const selectedId = this.store.selectedClassId();
              if (this.isStudentMode() && selectedId) {
                const match = classes.find((c) => c.id === selectedId);
                if (match && match.sessions.length > 0) {
                  this.store.updateSchedule(match.sessions);
                }
              }
            });
          }
          if (this.appStage() !== 'splash') {
            void this.onUserSessionDetected(user);
          }
        } else {
          this.store.stopRealtimeListeners();
          if (this.unsubscribeClasses) {
            this.unsubscribeClasses();
            this.unsubscribeClasses = null;
          }
        }
      });
    }

    if (typeof window !== 'undefined') {
      void this.updateNotificationPermissionStatus();

      // Exact 5-second branded splash screen before entering gateway/app
      const splashMs = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 1500
        : 5000;

      this.splashTimer = setTimeout(() => {
        this.finishSplash();
      }, splashMs);
    }
  }

  ngOnDestroy(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.splashTimer) clearTimeout(this.splashTimer);
    if (this.bgTestInterval) clearInterval(this.bgTestInterval);
    if (this.unsubscribeClasses) this.unsubscribeClasses();
    if (this.unsubscribeAuth) this.unsubscribeAuth();
  }

  finishSplash(): void {
    if (this.appStage() !== 'splash') return;
    if (this.splashTimer) {
      clearTimeout(this.splashTimer);
      this.splashTimer = undefined;
    }

    const user = this.currentUser();
    if (!user) {
      this.appStage.set('role-gate');
      return;
    }
    void this.onUserSessionDetected(user);
  }

  selectGateRole(role: UserRole): void {
    this.selectedGateRole.set(role);
    this.store.setUserRole(role);
    const user = this.currentUser();

    if (user) {
      if (role === 'admin' && user.email !== ADMIN_EMAIL) {
        this.toast.show(
          `บัญชี ${user.email} ไม่มีสิทธิ์ผู้ดูแลระบบ กรุณาเข้าสู่ระบบด้วยบัญชีครูผู้ดูแล`,
          'warning',
          'สิทธิ์ไม่ตรงกัน'
        );
        this.appStage.set('auth-gate');
        return;
      }
      void this.onUserSessionDetected(user);
      return;
    }

    this.appStage.set('auth-gate');
  }

  backToRoleGate(): void {
    this.selectedGateRole.set(null);
    this.appStage.set('role-gate');
  }

  async doGoogleLogin(): Promise<void> {
    const role = this.selectedGateRole() || this.store.userRole() || 'student';
    this.isProcessing.set(true);
    try {
      const user = await signInWithGoogle();
      if (!user) return;

      if (role === 'admin' && user.email !== ADMIN_EMAIL) {
        await logout();
        this.toast.show(
          `เฉพาะบัญชีผู้ดูแล (${ADMIN_EMAIL}) เท่านั้นที่สามารถเข้าใช้โหมดคุณครูได้`,
          'error',
          'ไม่มีสิทธิ์ผู้ดูแลระบบ'
        );
        return;
      }

      this.store.setUserRole(role);
      await this.onUserSessionDetected(user);
      this.toast.show(`เข้าสู่ระบบสำเร็จ (${user.displayName || user.email})`, 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'ไม่สามารถเข้าสู่ระบบด้วย Google ได้';
      if (!msg.includes('popup-closed-by-user')) {
        this.toast.show(msg, 'error', 'เข้าสู่ระบบไม่สำเร็จ');
      }
    } finally {
      this.isProcessing.set(false);
    }
  }

  private async onUserSessionDetected(user: User): Promise<void> {
    const intendedRole = this.selectedGateRole() || this.store.userRole();
    const actualRole: UserRole =
      user.email === ADMIN_EMAIL && intendedRole === 'admin'
        ? 'admin'
        : intendedRole === 'admin'
          ? 'student'
          : intendedRole || (user.email === ADMIN_EMAIL ? 'admin' : 'student');

    this.store.setUserRole(actualRole);

    // Load published rooms + restore personal backup
    const [classes] = await Promise.all([
      fetchPublishedClassSchedules().catch(() => [] as ClassScheduleDoc[]),
      this.store.restoreFromCloud(),
    ]);
    if (classes.length > 0) {
      this.publishedClasses.set(classes);
    }

    // Refresh push subscription cleanly if already granted
    await this.updateNotificationPermissionStatus();
    if (this.notificationPermission() === 'granted' && !Capacitor.isNativePlatform()) {
      void this.notification.requestPermission();
    }

    await this.loadDashboardData();

    if (actualRole === 'admin') {
      this.appStage.set('workspace');
      this.activeTab.set(this.store.effectiveSchedule().length > 0 ? 'home' : 'admin');
      await this.store.syncNow();
      return;
    }

    // Student routing: if already selected an active published classroom, go straight to workspace
    const savedClassId = this.store.selectedClassId();
    const matchedClass = classes.find((c) => c.id === savedClassId && c.sessions.length > 0);
    if (matchedClass) {
      this.store.setSelectedClassroom(
        matchedClass.id,
        matchedClass.grade,
        matchedClass.room,
        matchedClass.sessions
      );
      await this.store.syncNow();
      this.appStage.set('workspace');
      this.activeTab.set('home');
    } else if (this.store.schedule().length > 0 && savedClassId) {
      await this.store.syncNow();
      this.appStage.set('workspace');
      this.activeTab.set('home');
    } else {
      this.openClassroomPicker();
    }
  }

  openClassroomPicker(): void {
    const grades = this.availableGrades();
    const currentGrade = this.store.selectedGrade();
    const initialGrade = grades.includes(currentGrade) ? currentGrade : grades[0] || '';
    this.pickerGrade.set(initialGrade);

    const rooms = this.publishedClasses().filter((c) => c.grade === initialGrade);
    const currentRoom = this.store.selectedRoom();
    const matchedRoom = rooms.find((r) => r.room === currentRoom)?.room || rooms[0]?.room || '';
    this.pickerRoom.set(matchedRoom);

    this.appStage.set('classroom-picker');
  }

  selectPickerGrade(grade: string): void {
    this.pickerGrade.set(grade);
    const firstRoom = this.publishedClasses().find(
      (c) => c.grade === grade && c.sessions.length > 0
    );
    this.pickerRoom.set(firstRoom ? firstRoom.room : '');
  }

  selectPickerRoom(room: string): void {
    this.pickerRoom.set(room);
  }

  async refreshPublishedClasses(): Promise<void> {
    this.isProcessing.set(true);
    try {
      const classes = await fetchPublishedClassSchedules();
      this.publishedClasses.set(classes);
      if (!this.pickerGrade() && classes.length > 0) {
        this.selectPickerGrade(classes[0].grade);
      }
      this.toast.show(`โหลดข้อมูลห้องเรียนล่าสุดแล้ว (${classes.length} ห้อง)`, 'info');
    } finally {
      this.isProcessing.set(false);
    }
  }

  async confirmClassroomSelection(): Promise<void> {
    const chosen = this.selectedPickerClassDoc();
    if (!chosen) {
      this.toast.show('กรุณาเลือกระดับชั้นและห้องเรียนที่ต้องการ', 'warning');
      return;
    }

    this.isProcessing.set(true);
    try {
      this.store.setSelectedClassroom(chosen.id, chosen.grade, chosen.room, chosen.sessions);
      await this.store.syncNow();

      // Prompt notification permissions for student on classroom confirmation
      if (this.notificationPermission() === 'default') {
        const granted = await this.notification.requestPermission();
        await this.updateNotificationPermissionStatus();
        if (granted) {
          this.toast.show('เปิดสิทธิ์แจ้งเตือนแล้ว ระบบจะเตือนทุกคาบเรียนอัตโนมัติ', 'success');
        }
      }

      this.appStage.set('workspace');
      this.activeTab.set('home');
      this.toast.show(`เชื่อมต่อตารางเรียนห้อง ${chosen.displayName} เรียบร้อย`, 'success');
    } finally {
      this.isProcessing.set(false);
    }
  }

  async doLogout(): Promise<void> {
    const ok = await this.toast.confirm(
      'ออกจากระบบ',
      'ต้องการออกจากระบบบัญชีปัจจุบันและกลับไปยังหน้าเลือกบทบาทใช่หรือไม่?',
      'ออกจากระบบ',
      'อยู่ต่อ'
    );
    if (!ok) return;

    await logout();
    this.selectedGateRole.set(null);
    this.store.setUserRole(null);
    this.appStage.set('role-gate');
    this.toast.show('ออกจากระบบเรียบร้อยแล้ว', 'info');
  }

  setTab(tab: AppTab): void {
    if (tab === 'admin' && !this.isAdminLoggedIn()) return;
    this.activeTab.set(tab);
    if (tab === 'home' || tab === 'admin') {
      void this.loadDashboardData();
    }
  }

  async loadDashboardData(): Promise<void> {
    try {
      const info = await fetchDiagnosticInfo();
      this.pushToken.set(info.pushToken);
      this.pushSubscriptionStatus.set(info.subscriptionStatus);
      this.notificationQueueItems.set(info.queueItems);
      this.notificationLogsItems.set(info.logItems);
      this.notificationSuccessCount.set(info.sCount);
      this.notificationFailedCount.set(info.fCount);
    } catch {
      // Non-fatal
    }
  }

  // Notification & Delayed iPad Background Test
  async updateNotificationPermissionStatus(): Promise<void> {
    if (typeof window === 'undefined') return;
    if ('Notification' in window) {
      this.notificationPermission.set(Notification.permission);
    } else {
      this.notificationPermission.set('unsupported');
    }
  }

  async requestNotificationPermission(): Promise<void> {
    this.isProcessing.set(true);
    try {
      const granted = await this.notification.requestPermission();
      await this.updateNotificationPermissionStatus();
      await this.loadDashboardData();

      if (granted || this.notificationPermission() === 'granted') {
        this.toast.show(
          'เปิดใช้งานการแจ้งเตือนเบื้องหลัง (Web Push) สำเร็จแล้ว',
          'success',
          'พร้อมรับการแจ้งเตือน'
        );
      } else if (this.pwa.needsIosHomeScreenInstall()) {
        this.pwa.showInstallGuideModal.set(true);
      } else {
        this.toast.show(
          'กรุณาอนุญาตการแจ้งเตือนในการตั้งค่าเบราว์เซอร์หรือ iPadOS Settings',
          'warning',
          'สิทธิ์ถูกปิดกั้น'
        );
      }
    } finally {
      this.isProcessing.set(false);
    }
  }

  async runImmediateTestNotification(): Promise<void> {
    await this.notification.sendTestNotification(this.store.settings(), 0);
    await this.loadDashboardData();
  }

  async runDelayedBackgroundPushTest(seconds = 5): Promise<void> {
    if (this.notificationPermission() !== 'granted') {
      await this.requestNotificationPermission();
      if (this.notificationPermission() !== 'granted') return;
    }

    if (this.bgTestInterval) clearInterval(this.bgTestInterval);
    this.bgTestCountdown.set(seconds);

    const res = await this.notification.sendTestNotification(this.store.settings(), seconds);
    if (!res) {
      this.bgTestCountdown.set(0);
      this.toast.show('ไม่สามารถตั้งเวลาทดสอบกับเซิร์ฟเวอร์ได้ กรุณาลองอีกครั้ง', 'error');
      return;
    }

    if (res.totalSubs === 0) {
      this.toast.show(
        'ยังไม่มี Push Subscription บนอุปกรณ์นี้ กรุณากดอนุญาตแจ้งเตือนอีกครั้ง',
        'warning'
      );
    } else {
      this.toast.show(
        `ตั้งเวลาส่ง Push เบื้องหลังใน ${seconds} วินาทีแล้ว — สามารถกดปัดปิดหรือพับแอปได้เลย!`,
        'info',
        'กำลังส่งใน 5 วินาที'
      );
    }

    this.bgTestInterval = setInterval(() => {
      const next = this.bgTestCountdown() - 1;
      this.bgTestCountdown.set(Math.max(0, next));
      if (next <= 0 && this.bgTestInterval) {
        clearInterval(this.bgTestInterval);
        this.bgTestInterval = undefined;
      }
    }, 1000);
  }

  // Snooze Controls
  async snooze5Minutes(): Promise<void> {
    await this.notification.snoozeActiveNotification(5);
    this.toast.show('เลื่อนแจ้งเตือนออกไป 5 นาทีแล้ว (ซิงก์ขึ้นเซิร์ฟเวอร์เรียบร้อย)', 'info');
  }

  formatCountdownMmSs(totalSeconds: number): string {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Personal Schedule Categories ("หมวดตารางส่วนตัว" like alarm clocks)
  createPersonalCategory(): void {
    if (this.newCategoryForm.invalid) return;
    const name = this.newCategoryForm.controls.name.value.trim();
    if (!name) return;
    const created = this.store.addPersonalCategory(name);
    this.newCategoryForm.reset();
    this.expandedCategoryId.set(created.id);
    this.toast.show(`สร้างหมวด "${created.name}" แล้ว สามารถเพิ่มเวลาแจ้งเตือนส่วนตัวได้เลย`, 'success');
  }

  toggleCategoryExpand(catId: string): void {
    this.expandedCategoryId.set(this.expandedCategoryId() === catId ? null : catId);
  }

  addSessionToCategory(cat: PersonalScheduleCategory): void {
    if (this.newPersonalSessionForm.invalid) {
      this.toast.show('กรุณากรอกชื่อกิจกรรมและเวลาให้ถูกต้อง (รูปแบบ HH:MM)', 'warning');
      return;
    }
    const val = this.newPersonalSessionForm.getRawValue();
    if (val.endTime <= val.startTime) {
      this.toast.show('เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่มต้น', 'warning');
      return;
    }

    this.store.addSessionToPersonalCategory(cat.id, {
      dayOfWeek: val.dayOfWeek,
      startTime: val.startTime,
      endTime: val.endTime,
      subjectCode: '',
      subjectName: val.subjectName.trim(),
      room: val.room.trim(),
      teacher: val.teacher.trim(),
      sourceCategoryId: cat.id,
      sourceCategoryName: cat.name,
    });

    this.newPersonalSessionForm.patchValue({ subjectName: '', room: '', teacher: '' });
    this.toast.show(`เพิ่มรายการในหมวด "${cat.name}" แล้ว`, 'success');
  }

  async deleteCategoryConfirm(cat: PersonalScheduleCategory): Promise<void> {
    const ok = await this.toast.confirm(
      'ลบหมวดตารางส่วนตัว',
      `ต้องการลบหมวด "${cat.name}" และรายการแจ้งเตือนทั้งหมดในหมวดนี้ใช่หรือไม่?`,
      'ลบหมวด',
      'ยกเลิก',
      true
    );
    if (!ok) return;
    this.store.deletePersonalCategory(cat.id);
    if (this.expandedCategoryId() === cat.id) this.expandedCategoryId.set(null);
  }

  // Schedule & Session Formatting Helpers
  translateDay(day: string): string {
    return translateDay(day);
  }

  resolveSubjectName(session: ClassSession): string {
    const code = (session.subjectCode || '').trim().toUpperCase();
    const mapping = this.subjectMappings();
    return (
      mapping[code] ||
      DEFAULT_SUBJECT_MAPPINGS[code] ||
      session.subjectName ||
      code ||
      'ไม่ระบุวิชา'
    );
  }

  getClassStatus(session: ClassSession): 'past' | 'current' | 'future' {
    const now = this.currentTime();
    const [startH, startM] = session.startTime.split(':').map(Number);
    const [endH, endM] = session.endTime.split(':').map(Number);

    const start = new Date(now);
    start.setHours(startH, startM, 0, 0);
    const end = new Date(now);
    end.setHours(endH, endM, 0, 0);

    if (now > end) return 'past';
    if (now >= start && now <= end) return 'current';
    return 'future';
  }

  getCountdown(session: ClassSession): string {
    const now = this.currentTime();
    const [endH, endM] = session.endTime.split(':').map(Number);
    const end = new Date(now);
    end.setHours(endH, endM, 0, 0);
    const diff = end.getTime() - now.getTime();
    if (diff <= 0) return '00:00';
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  getBellTime(session: ClassSession): string {
    return subtractMinutesFormatted(session.startTime, this.preNotifyMinutes());
  }

  // Settings Mutators
  updateSetting(key: keyof AppSettings, value: boolean | number | string | undefined): void {
    this.store.updateSettings({ [key]: value });
  }

  updateNumericSetting(key: 'preNotifyMinutes' | 'popupDuration', event: Event): void {
    const val = parseInt((event.target as HTMLSelectElement | HTMLInputElement).value, 10);
    if (!Number.isNaN(val)) {
      this.store.updateSettings({ [key]: val });
    }
  }

  onSoundSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target?.result as string;
      this.store.updateSettings({ notificationSound: base64 });
      this.toast.show('บันทึกเสียงแจ้งเตือนใหม่แล้ว', 'success');
    };
    reader.readAsDataURL(file);
  }

  testSound(): void {
    this.notification.playNotificationSound(this.store.settings().notificationSound);
  }

  // Holiday Editor
  openHolidayEditor(day: CalendarDay): void {
    if (!day.isCurrentMonth) return;
    this.selectedDate.set(day);
    const initial =
      day.holidayName && day.holidayName !== 'วันเสาร์' && day.holidayName !== 'วันอาทิตย์'
        ? day.holidayName
        : '';
    this.holidayForm.setValue({ holidayName: initial });
    this.showHolidayEditor.set(true);
  }

  saveHoliday(): void {
    const day = this.selectedDate();
    if (!day) return;
    const current = { ...(this.store.settings().calendarHolidays || {}) };
    const name = this.holidayForm.controls.holidayName.value.trim();
    if (name) {
      current[day.dateString] = name;
    } else {
      delete current[day.dateString];
    }
    this.store.updateSettings({ calendarHolidays: current });
    this.showHolidayEditor.set(false);
    this.toast.show(
      name ? `บันทึกวันหยุด "${name}" เรียบร้อย` : 'ลบวันหยุดที่กำหนดเองแล้ว',
      'success'
    );
  }

  clearHoliday(): void {
    this.holidayForm.setValue({ holidayName: '' });
    this.saveHoliday();
  }

  // Admin: AI Image Parse, Draft Editing, Classroom Publishing
  async onAdminImageSelected(event: Event): Promise<void> {
    if (!this.isAdminLoggedIn()) return;
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.isProcessing.set(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('อ่านไฟล์รูปภาพไม่สำเร็จ'));
        reader.readAsDataURL(file);
      });

      const parsed = await this.gemini.parseScheduleImage(base64, file.type || 'image/png');
      const mappings = this.subjectMappings();
      const mapped = parsed.map((s) => {
        const code = (s.subjectCode || '').trim().toUpperCase();
        const autoName = mappings[code] || DEFAULT_SUBJECT_MAPPINGS[code];
        return code && autoName && !s.subjectName ? { ...s, subjectName: autoName } : s;
      });

      this.adminDraftSessions.set(mapped);
      this.toast.show(
        `AI อ่านตารางเรียนสำเร็จ ${mapped.length} คาบ — ตรวจสอบแล้วกด "เผยแพร่เข้าห้องเรียน" ได้เลย`,
        'success'
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'ไม่สามารถอ่านรูปภาพตารางเรียนได้';
      this.toast.show(msg, 'error', 'AI Parse ไม่สำเร็จ');
    } finally {
      this.isProcessing.set(false);
      input.value = '';
    }
  }

  addBlankDraftSession(): void {
    if (!this.isAdminLoggedIn()) return;
    const newSession: ClassSession = {
      id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      dayOfWeek: 'Monday',
      startTime: '08:30',
      endTime: '09:20',
      subjectCode: '',
      subjectName: 'รายวิชาใหม่',
      room: '',
      teacher: '',
    };
    this.adminDraftSessions.update((list) => [...list, newSession]);
    this.openSessionEditor(newSession);
  }

  openSessionEditor(session: ClassSession): void {
    if (!this.isAdminLoggedIn()) return;
    this.editingSession.set(session);
    this.editSessionForm.setValue({
      id: session.id,
      dayOfWeek: session.dayOfWeek || 'Monday',
      startTime: session.startTime || '08:30',
      endTime: session.endTime || '09:20',
      subjectCode: session.subjectCode || '',
      subjectName: session.subjectName || '',
      room: session.room || '',
      teacher: session.teacher || '',
    });
  }

  saveEditedSession(): void {
    if (this.editSessionForm.invalid) {
      this.toast.show('กรุณากรอกเวลาให้อยู่ในรูปแบบ HH:MM เช่น 08:30', 'warning');
      return;
    }
    const val = this.editSessionForm.getRawValue();
    if (val.endTime <= val.startTime) {
      this.toast.show('เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่มต้น', 'warning');
      return;
    }

    const existsInDraft = this.adminDraftSessions().some((s) => s.id === val.id);
    if (existsInDraft) {
      this.adminDraftSessions.update((list) => list.map((s) => (s.id === val.id ? val : s)));
    } else {
      this.store.updateSchedule(this.store.schedule().map((s) => (s.id === val.id ? val : s)));
    }
    this.editingSession.set(null);
    this.toast.show('บันทึกการแก้ไขคาบเรียนแล้ว', 'success');
  }

  deleteDraftSession(sessionId: string): void {
    this.adminDraftSessions.update((list) => list.filter((s) => s.id !== sessionId));
  }

  async publishDraftToClassroom(): Promise<void> {
    if (!this.isAdminLoggedIn()) return;
    if (this.adminPublishForm.invalid) {
      this.toast.show('กรุณาระบุระดับชั้นและห้องเรียน', 'warning');
      return;
    }

    const sessions = this.adminDraftSessions();
    if (sessions.length === 0) {
      this.toast.show('กรุณาอัปโหลดรูปภาพหรือเพิ่มคาบเรียนอย่างน้อย 1 คาบก่อนเผยแพร่', 'warning');
      return;
    }

    const { grade, room } = this.adminPublishForm.getRawValue();
    this.isProcessing.set(true);
    try {
      const saved = await savePublishedClassSchedule(grade, room, sessions);
      // Also set active schedule if admin is viewing it
      this.store.setSelectedClassroom(saved.id, saved.grade, saved.room, saved.sessions);
      await this.store.syncNow();
      this.toast.show(`เผยแพร่ตารางเรียนห้อง ${saved.displayName} ให้นักเรียนเลือกแล้ว`, 'success');
    } catch (err: unknown) {
      this.toast.show(
        err instanceof Error ? err.message : 'เผยแพร่ตารางเรียนไม่สำเร็จ',
        'error'
      );
    } finally {
      this.isProcessing.set(false);
    }
  }

  loadClassroomIntoDraft(docItem: ClassScheduleDoc): void {
    this.adminPublishForm.setValue({ grade: docItem.grade, room: docItem.room });
    this.adminDraftSessions.set([...docItem.sessions]);
    this.toast.show(`ดึงข้อมูลห้อง ${docItem.displayName} มาแก้ไขแล้ว`, 'info');
  }

  async deletePublishedClassroom(docItem: ClassScheduleDoc): Promise<void> {
    const ok = await this.toast.confirm(
      'ลบตารางเรียนของห้องเรียน',
      `ต้องการลบตารางเรียนห้อง ${docItem.displayName} ออกจากระบบใช่หรือไม่?`,
      'ลบห้องเรียน',
      'ยกเลิก',
      true
    );
    if (!ok) return;
    await deletePublishedClassSchedule(docItem.id);
    this.toast.show(`ลบห้อง ${docItem.displayName} เรียบร้อยแล้ว`, 'info');
  }

  // Admin: Subject Mappings & Broadcast
  saveAdminMapping(): void {
    if (this.adminMappingForm.invalid) return;
    const code = this.adminMappingForm.controls.code.value.trim().toUpperCase();
    const name = this.adminMappingForm.controls.name.value.trim();
    if (!code || !name) return;

    const updated = { ...this.subjectMappings(), [code]: name };
    this.subjectMappings.set(updated);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('subject_mappings', JSON.stringify(updated));
    }
    this.adminMappingForm.reset();
    void this.saveAdminGlobalConfig();
  }

  removeAdminMapping(code: string): void {
    const updated = { ...this.subjectMappings() };
    delete updated[code];
    this.subjectMappings.set(updated);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('subject_mappings', JSON.stringify(updated));
    }
    void this.saveAdminGlobalConfig();
  }

  async saveAdminGlobalConfig(): Promise<void> {
    if (!this.isAdminLoggedIn()) return;
    try {
      await saveGlobalConfig({
        backendApiUrl: typeof window !== 'undefined' ? window.location.origin : '',
        subjectMappings: this.subjectMappings(),
        githubRepo: 'khaophan/Timetable-notification-app',
        broadcastText: this.adminBroadcastForm.controls.broadcastText.value.trim(),
        maintenanceMode: false,
        updatedAt: new Date().toISOString(),
      });
      this.toast.show('บันทึกการตั้งค่าส่วนกลางเรียบร้อยแล้ว', 'success');
    } catch {
      this.toast.show('ไม่สามารถบันทึกการตั้งค่าส่วนกลางได้', 'error');
    }
  }

  async confirmResetAll(): Promise<void> {
    const ok = await this.toast.confirm(
      'ล้างข้อมูลตารางเรียนในอุปกรณ์นี้',
      'ข้อมูลตารางส่วนตัวและค่าปรับแต่งในเครื่องนี้จะถูกรีเซ็ต (ข้อมูลห้องเรียนที่คุณครูเผยแพร่ยังอยู่ครบ)',
      'ล้างข้อมูล',
      'ยกเลิก',
      true
    );
    if (!ok) return;
    await this.store.resetAll();
    this.toast.show('รีเซ็ตข้อมูลในอุปกรณ์เรียบร้อยแล้ว', 'info');
    if (this.isStudentMode()) {
      this.openClassroomPicker();
    }
  }
}
