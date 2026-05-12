import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.schedule.notifier.thai',
  appName: 'แจ้งเตือนตารางเรียน',
  webDir: 'www',
  server: {
    allowNavigation: [
      'github.com',
      '*.github.com',
      '*.githubusercontent.com',
      '*.google.com',
      '*.googleapis.com',
      'generativelanguage.googleapis.com',
      'firebaseapp.com',
      '*.firebaseapp.com',
      'fcm.googleapis.com'
    ]
  },
  plugins: {
    CapacitorHttp: {
      enabled: true
    },
    CapacitorUpdater: {
      autoUpdate: false,
      statsUrl: ''
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert']
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: '#488AFF',
      sound: 'beep.wav'
    }
  }
};

export default config;
