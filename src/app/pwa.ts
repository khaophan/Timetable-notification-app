import { Injectable, signal, computed } from '@angular/core';
import { Capacitor } from '@capacitor/core';

export interface PwaInstallPrompt {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

@Injectable({ providedIn: 'root' })
export class PwaService {
  readonly deferredPrompt = signal<PwaInstallPrompt | null>(null);
  readonly isStandalone = signal<boolean>(false);
  readonly isIosOrIpadOs = signal<boolean>(false);
  readonly isAndroid = signal<boolean>(false);
  readonly isSafari = signal<boolean>(false);
  readonly isInAppBrowser = signal<boolean>(false);
  readonly isNative = signal<boolean>(Capacitor.isNativePlatform());
  readonly swStatus = signal<'checking' | 'registered' | 'failed' | 'not_supported'>('checking');
  readonly updateAvailable = signal<boolean>(false);
  readonly showInstallGuideModal = signal<boolean>(false);

  readonly platformLabel = computed(() => {
    if (this.isNative()) return 'แอปเนทีฟ (Android)';
    if (this.isIosOrIpadOs()) return this.isStandalone() ? 'iPad / iOS Web App' : 'iPad / iOS Safari';
    if (this.isAndroid()) return this.isStandalone() ? 'Android Web App' : 'Android Browser';
    return 'Desktop Browser';
  });

  readonly needsIosHomeScreenInstall = computed(
    () => !this.isNative() && this.isIosOrIpadOs() && !this.isStandalone()
  );

  constructor() {
    if (typeof window !== 'undefined') {
      this.detectPlatform();
      this.bindPwaEvents();
      this.initServiceWorkerTracking();
    }
  }

  private detectPlatform(): void {
    const ua = navigator.userAgent.toLowerCase();
    const isIpadDesktopMode =
      navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    const isIosUa = /iphone|ipad|ipod/.test(ua) || isIpadDesktopMode;
    const isAndroidUa = /android/.test(ua);
    const isSafariBrowser =
      /safari/.test(ua) && !/chrome|crios|fxios|edg/.test(ua);

    this.isIosOrIpadOs.set(isIosUa);
    this.isAndroid.set(isAndroidUa);
    this.isSafari.set(isSafariBrowser);

    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as { standalone?: boolean }).standalone === true;
    this.isStandalone.set(standalone);

    const isInApp =
      ua.includes('line/') ||
      ua.includes('fbav') ||
      ua.includes('messenger') ||
      ua.includes('fbios') ||
      ua.includes('instagram') ||
      ua.includes('webview') ||
      ua.includes('wv');
    this.isInAppBrowser.set(isInApp);
  }

  private bindPwaEvents(): void {
    const win = window as unknown as { deferredPrompt?: PwaInstallPrompt | null };
    if (win.deferredPrompt) {
      this.deferredPrompt.set(win.deferredPrompt);
    }

    window.addEventListener('pwa-install-available', () => {
      if (win.deferredPrompt) {
        this.deferredPrompt.set(win.deferredPrompt);
      }
    });

    window.addEventListener('beforeinstallprompt', (e: Event) => {
      e.preventDefault();
      const prompt = e as unknown as PwaInstallPrompt;
      win.deferredPrompt = prompt;
      this.deferredPrompt.set(prompt);
    });

    window.addEventListener('appinstalled', () => {
      win.deferredPrompt = null;
      this.deferredPrompt.set(null);
      this.isStandalone.set(true);
    });
  }

  private initServiceWorkerTracking(): void {
    if (!('serviceWorker' in navigator)) {
      this.swStatus.set('not_supported');
      return;
    }

    navigator.serviceWorker
      .getRegistration()
      .then((reg) => {
        if (reg) {
          this.swStatus.set('registered');
          if (reg.waiting) {
            this.updateAvailable.set(true);
          }
          reg.update().catch(() => undefined);
          reg.addEventListener('updatefound', () => {
            const worker = reg.installing;
            if (worker) {
              worker.addEventListener('statechange', () => {
                if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                  this.updateAvailable.set(true);
                }
              });
            }
          });
        } else {
          this.swStatus.set('checking');
          navigator.serviceWorker.ready
            .then(() => this.swStatus.set('registered'))
            .catch(() => this.swStatus.set('failed'));
        }
      })
      .catch(() => this.swStatus.set('failed'));

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });
  }

  async promptInstall(): Promise<boolean> {
    const prompt = this.deferredPrompt();
    if (prompt) {
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      this.deferredPrompt.set(null);
      return outcome === 'accepted';
    }
    this.showInstallGuideModal.set(true);
    return false;
  }

  async applySwUpdate(): Promise<void> {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg?.waiting) {
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    } else {
      window.location.reload();
    }
  }
}
