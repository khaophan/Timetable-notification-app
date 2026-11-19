import { ClassSession } from './models';
import { PUBLIC_HOLIDAYS_2026 } from './calendar';

export const DAYS_ORDER = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export const THAI_DAY_MAP: Record<string, string> = {
  Monday: 'วันจันทร์',
  Tuesday: 'วันอังคาร',
  Wednesday: 'วันพุธ',
  Thursday: 'วันพฤหัสบดี',
  Friday: 'วันศุกร์',
  Saturday: 'วันเสาร์',
  Sunday: 'วันอาทิตย์',
};

export function translateDay(day: string): string {
  return THAI_DAY_MAP[day] || day;
}

export function timeToMinutes(hhmm: string): number {
  const parts = (hhmm || '').split(':');
  if (parts.length !== 2) return 0;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

export function subtractMinutesFormatted(hhmm: string, mins: number): string {
  let total = timeToMinutes(hhmm) - mins;
  while (total < 0) total += 1440;
  total = total % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatDateYYYYMMDD(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function isSchoolHoliday(
  dateString: string,
  customHolidays: Record<string, string> = {}
): { isHoliday: boolean; name?: string } {
  if (customHolidays[dateString]) {
    return { isHoliday: true, name: customHolidays[dateString] };
  }
  if (PUBLIC_HOLIDAYS_2026[dateString]) {
    return { isHoliday: true, name: PUBLIC_HOLIDAYS_2026[dateString] };
  }

  const parts = dateString.split('-');
  if (parts.length === 3) {
    const date = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    const dow = date.getDay();
    if (dow === 0) return { isHoliday: true, name: 'วันอาทิตย์' };
    if (dow === 6) return { isHoliday: true, name: 'วันเสาร์' };
  }
  return { isHoliday: false };
}

export function isNonStudyPeriod(session: ClassSession): boolean {
  const name = (session.subjectName || '').trim();
  return name === 'พักเที่ยง' || name === 'พักกลางวัน' || name === 'เลิกเรียน' || name === 'ว่าง';
}

export interface DailyStudyStat {
  day: string;
  thaiDay: string;
  shortLabel: string;
  hours: number;
  minutes: number;
  sessionCount: number;
}

export interface SubjectStudyStat {
  subject: string;
  hours: number;
  minutes: number;
  sessionCount: number;
}

export function computeDailyStudyStats(sessions: ClassSession[]): DailyStudyStat[] {
  const shortLabels: Record<string, string> = {
    Monday: 'จ.',
    Tuesday: 'อ.',
    Wednesday: 'พ.',
    Thursday: 'พฤ.',
    Friday: 'ศ.',
    Saturday: 'ส.',
    Sunday: 'อา.',
  };

  return DAYS_ORDER.map((day) => {
    const daySessions = sessions.filter(
      (s) => s.dayOfWeek === day && !isNonStudyPeriod(s)
    );
    const totalMinutes = daySessions.reduce((acc, s) => {
      const diff = timeToMinutes(s.endTime) - timeToMinutes(s.startTime);
      return acc + Math.max(0, diff);
    }, 0);

    return {
      day,
      thaiDay: translateDay(day),
      shortLabel: shortLabels[day] || day,
      minutes: totalMinutes,
      hours: Math.round((totalMinutes / 60) * 10) / 10,
      sessionCount: daySessions.length,
    };
  }).filter((d, i) => i < 5 || d.sessionCount > 0);
}

export function computeSubjectStudyStats(
  sessions: ClassSession[],
  resolveName: (s: ClassSession) => string
): SubjectStudyStat[] {
  const map = new Map<string, { minutes: number; count: number }>();
  for (const s of sessions) {
    if (isNonStudyPeriod(s)) continue;
    const label = resolveName(s);
    const diff = Math.max(0, timeToMinutes(s.endTime) - timeToMinutes(s.startTime));
    const prev = map.get(label) || { minutes: 0, count: 0 };
    map.set(label, { minutes: prev.minutes + diff, count: prev.count + 1 });
  }

  return Array.from(map.entries())
    .map(([subject, stat]) => ({
      subject,
      minutes: stat.minutes,
      hours: Math.round((stat.minutes / 60) * 10) / 10,
      sessionCount: stat.count,
    }))
    .sort((a, b) => b.minutes - a.minutes);
}
