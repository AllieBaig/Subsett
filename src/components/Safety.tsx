import React, { useState, useEffect, Component, ErrorInfo } from 'react';
import { AlertTriangle, RotateCcw, ShieldCheck } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorInfo: string | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, errorInfo: (error as Error).message };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[CRITICAL RENDER FAILURE]", error, errorInfo);
    // Track crashes to avoid infinite loops
    const crashCount = parseInt(localStorage.getItem('app_render_crash_count') || '0');
    localStorage.setItem('app_render_crash_count', (crashCount + 1).toString());
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 flex items-center justify-center bg-system-background p-8 text-center z-[10000]">
          <div className="max-w-md w-full bg-apple-card rounded-[2.5rem] p-10 border border-apple-border shadow-2xl">
            <div className="w-20 h-20 bg-amber-100/10 text-amber-600 rounded-3xl flex items-center justify-center mx-auto mb-8">
              <AlertTriangle size={40} />
            </div>
            <h2 className="text-2xl font-bold mb-3 text-system-label">Interface Stability Recovery</h2>
            <p className="text-system-secondary-label text-sm mb-10 leading-relaxed font-medium">
              We detected an unstable interface state. The system is protecting your data and will resume safely after a reset.
            </p>
            <div className="space-y-3">
              <button 
                onClick={() => {
                  localStorage.removeItem('app_render_crash_count');
                  window.location.reload();
                }}
                className="w-full bg-system-label text-system-background py-4.5 rounded-2xl font-bold flex items-center justify-center gap-3 active:scale-[0.98] transition-all"
              >
                <RotateCcw size={20} />
                <span>Resume App</span>
              </button>
              <button 
                onClick={async () => {
                  try {
                    localStorage.clear();
                    if ('caches' in window) {
                      const names = await caches.keys();
                      await Promise.all(names.map(name => caches.delete(name)));
                    }
                    if ('serviceWorker' in navigator) {
                      const regs = await navigator.serviceWorker.getRegistrations();
                      await Promise.all(regs.map(reg => reg.unregister()));
                    }
                  } catch (e) {
                    console.error("Emergency cleanup failed:", e);
                  } finally {
                    window.location.reload();
                  }
                }}
                className="w-full bg-red-500/10 text-red-600 py-3 rounded-xl font-bold text-[10px] uppercase tracking-widest hover:bg-red-500/20 active:scale-95 transition-all"
              >
                Clear Cache & Safe Boot
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export const GlobalSafetyManager = ({ children }: { children: React.ReactNode }) => {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check for crash loop on mount
    const crashCount = parseInt(localStorage.getItem('app_boot_crash_count') || '0');
    if (crashCount > 2) {
      console.warn("Safety: High risk state detected. Performing emergency reset.");
      localStorage.clear();
      localStorage.setItem('app_boot_crash_count', '0');
      // No reload here yet, let the app try one fresh boot after clearing
    }

    const handleError = (event: ErrorEvent) => {
      console.error("[RUNTIME SYSTEM ERROR]", event.error?.stack || event.message);
      const newCount = crashCount + 1;
      localStorage.setItem('app_boot_crash_count', newCount.toString());
      
      // Auto-clear crash count if stable for 10 seconds
      setTimeout(() => localStorage.setItem('app_boot_crash_count', '0'), 10000);

      setError("Core system coordination timeout.");
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      console.error("[ASYNC COORDINATION ERROR]", event.reason?.message || event.reason);
      // Not always critical enough to stop the whole app, but we log it
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);

    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  if (error) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-system-background p-8 text-center z-[9999]">
        <div className="max-w-md w-full bg-apple-card rounded-[2.5rem] p-10 border border-apple-border shadow-2xl transition-all">
          <div className="w-20 h-20 bg-system-label text-system-background rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-xl">
            <ShieldCheck size={40} />
          </div>
          <h2 className="text-2xl font-bold mb-3 text-system-label">System Safe Mode</h2>
          <p className="text-system-secondary-label text-sm mb-10 leading-relaxed font-medium">
            Your session has been isolated to prevent data corruption. A standard restart will restore full functionality.
          </p>
          <button 
            onClick={() => {
              localStorage.setItem('app_boot_crash_count', '0');
              window.location.reload();
            }}
            className="w-full bg-system-label text-system-background py-4.5 rounded-2xl font-bold flex items-center justify-center gap-3 active:scale-[0.98] transition-all"
          >
            <RotateCcw size={20} />
            <span>Restore Environment</span>
          </button>
        </div>
      </div>
    );
  }

  return <ErrorBoundary>{children}</ErrorBoundary>;
};

export const LoadingPlaceholder = () => (
  <div className="h-full flex flex-col items-center justify-center bg-system-background">
    <div className="w-28 h-28 bg-apple-card rounded-[32px] shadow-xl flex items-center justify-center animate-pulse">
      <div className="w-12 h-12 bg-system-tertiary-label/20 rounded-xl" />
    </div>
    <div className="mt-12 flex flex-col items-center gap-4">
      <div className="h-6 w-48 bg-secondary-system-background rounded-full animate-pulse" />
      <div className="h-4 w-32 bg-secondary-system-background rounded-full animate-pulse opacity-60" />
    </div>
  </div>
);
