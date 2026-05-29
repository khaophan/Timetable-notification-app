export interface ClassSession {
  id: string;
  dayOfWeek: string;
  startTime: string; // HH:MM
  endTime: string;   // HH:MM
  subjectCode: string;
  subjectName: string;
  room: string;
  teacher: string;
}

export interface AppSettings {
  notifyTeacher: boolean;
  notifySubjectCode: boolean;
  notifySubjectName: boolean;
  notifyRoom: boolean;
  notifyEnd: boolean;
  notificationSound?: string; // Base64 storage
  popupDuration: number; // in seconds
  preNotifyMinutes?: number; // Minutes before class starts (default: 3)
}

export interface ActiveNotification {
  title: string;
  body: string;
  type: 'start' | 'end';
}
