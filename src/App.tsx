import { useState, useEffect, useMemo } from 'react';
import { AudioProvider } from './AudioContext';
import { PlaybackProvider } from './PlaybackContext';
import { SettingsProvider, useSettings } from './SettingsContext';
import { UIStateProvider, useUIState } from './UIStateContext';
import AudioEngine from './components/AudioEngine';
import OfflineIndicator from './components/OfflineIndicator';
import TabBar from './components/TabBar';
import LibraryView from './views/LibraryView';
import PlayerView from './views/PlayerView';
import SearchView from './views/SearchView';
import SettingsView from './views/SettingsView';
import MiniPlayer from './components/MiniPlayer';
import { motion, AnimatePresence } from 'motion/react';
import { WifiOff, AlertCircle, RefreshCcw, ArrowLeft } from 'lucide-react';
import { GlobalSafetyManager, LoadingPlaceholder } from './components/Safety';
import { AnimationStyle } from './types';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function AppContent() {
  const { activeTab, setActiveTab, isLoading, initError, toast, swStatus, showToast, isOffline, activeTabRequest, clearTabRequest } = useUIState();
  const { settings } = useSettings();
  
  useEffect(() => {
    if (activeTabRequest) {
      setActiveTab(activeTabRequest as any);
      clearTabRequest();
    }
  }, [activeTabRequest, clearTabRequest, setActiveTab]);

  // Handle SW updates
  useEffect(() => {
    if (swStatus === 'waiting') {
      showToast("Update Ready: Reload to apply");
    }
  }, [swStatus, showToast]);

  const getAnimationProps = (style: AnimationStyle) => {
    if (style === 'off' || !style) return { initial: { opacity: 1 }, animate: { opacity: 1 }, exit: { opacity: 1 } };
    
    let currentStyle: AnimationStyle = style;
    if (style === 'random') {
      const styles: AnimationStyle[] = ['slide-up', 'slide-down', 'slide-left', 'slide-right'];
      currentStyle = styles[Math.floor(Math.random() * styles.length)];
    }

    switch (currentStyle) {
      case 'slide-up': return { initial: { y: '100%' }, animate: { y: 0 }, exit: { y: '100%' } };
      case 'slide-down': return { initial: { y: '-100%' }, animate: { y: 0 }, exit: { y: '-100%' } };
      case 'slide-left': return { initial: { x: '100%' }, animate: { x: 0 }, exit: { x: '100%' } };
      case 'slide-right': return { initial: { x: '-100%' }, animate: { x: 0 }, exit: { x: '-100%' } };
      default: return { initial: { opacity: 1 }, animate: { opacity: 1 }, exit: { opacity: 1 } };
    }
  };

  const animationProps = useMemo(() => getAnimationProps(settings.animationStyle), [settings.animationStyle]);

  return (
    <div 
      className={`fixed inset-0 bg-system-background overflow-hidden flex flex-col pt-safe select-none h-[100dvh] transition-[padding,background] duration-500 ease-in-out ${settings.miniMode ? 'p-1' : ''} ${settings.bigTouchMode ? 'big-touch-mode' : ''}`}
    >
      <div className={cn("flex-1 w-full max-w-[1400px] mx-auto flex flex-col overflow-hidden relative", 
        settings.menuPosition === 'top' ? 'pt-24' : 'pb-32'
      )}>
        <AudioEngine />
        <OfflineIndicator />
        
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: 50, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.9 }}
              className={`fixed ${settings.menuPosition === 'bottom' ? 'bottom-32' : 'top-28'} left-1/2 -translate-x-1/2 z-[160] bg-system-label text-system-background px-6 py-3 rounded-2xl text-xs font-semibold shadow-2xl border border-apple-border`}
            >
              {toast}
            </motion.div>
          )}
        </AnimatePresence>
        
        <main className="flex-1 relative overflow-hidden flex flex-col">
          {isLoading ? (
            <div className="flex-1 px-4 md:px-8 lg:px-12">
              <div className="max-w-2xl mx-auto h-full text-white">
                <LoadingPlaceholder />
              </div>
            </div>
          ) : initError ? (
            <div className="flex-1 flex items-center justify-center px-4 md:px-8 lg:px-12">
              <div className={`w-full max-w-lg bg-apple-card ${settings.miniMode ? 'rounded-2xl p-6' : 'rounded-[2.5rem] p-8'} border border-apple-border shadow-2xl text-center`}>
                <div className="w-16 h-16 bg-amber-100/10 text-amber-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
                  <AlertCircle size={32} />
                </div>
                <h2 className="text-2xl font-bold mb-2 text-system-label">Startup Issue</h2>
                <p className="text-system-secondary-label text-sm mb-8 font-medium">{initError}</p>
                <button 
                  onClick={() => window.location.reload()}
                  className="w-full bg-system-label text-system-background py-4 rounded-2xl font-semibold flex items-center justify-center gap-2 active:scale-95 transition-transform"
                >
                  <RefreshCcw size={20} />
                  <span>Retry System</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 relative overflow-hidden">
              {/* Main Tab Views */}
              <div className="h-full relative overflow-hidden">
                {/* Library View */}
                <div className={`absolute inset-0 z-10 overflow-y-auto no-scrollbar pt-6 pb-12 transition-all duration-300 ${activeTab === 'library' ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                  <LibraryView />
                </div>

                {/* Search View */}
                <div className={`absolute inset-0 z-20 overflow-hidden bg-system-background transition-all duration-300 ${activeTab === 'search' ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
                  <SearchView />
                </div>

                {/* Player Overlay (Full Screen Sheet) */}
                <AnimatePresence>
                  {activeTab === 'player' && (
                    <motion.div
                      key="player"
                      {...animationProps}
                      transition={{ duration: settings.animationStyle === 'off' ? 0 : 0.4, ease: [0.32, 0.72, 0, 1] }}
                      className={`fixed inset-0 z-[100] bg-system-background overflow-hidden shadow-2xl pb-32`}
                    >
                      <PlayerView onBack={() => setActiveTab('library')} />
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Settings Overlay (Full Screen Sheet) */}
                <AnimatePresence>
                  {activeTab === 'settings' && (
                    <motion.div
                      key="settings"
                      {...animationProps}
                      transition={{ duration: settings.animationStyle === 'off' ? 0 : 0.4, ease: [0.32, 0.72, 0, 1] }}
                      className={`fixed inset-0 z-[110] bg-system-background overflow-y-auto no-scrollbar pb-32`}
                    >
                      <div className="w-full px-6 py-10 min-h-full pb-32">
                        <div className="w-full max-w-7xl mx-auto flex items-center justify-between mb-10">
                          {settings.backButtonPosition === 'top' ? (
                            <button 
                              onClick={() => setActiveTab('library')}
                              className={`w-12 h-12 bg-secondary-system-background border border-apple-border rounded-full flex items-center justify-center active:scale-95 transition-transform text-system-label`}
                            >
                              <ArrowLeft size={20} />
                            </button>
                          ) : (
                            <div className="w-12 h-12" />
                          )}
                          <h2 className="text-xl font-black tracking-tight text-system-label">Settings</h2>
                          <div className="w-12 h-12" />
                        </div>
                         <SettingsView onBack={() => setActiveTab('library')} />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Mini Player - Always above TabBar. Show when full player is NOT active */}
              <AnimatePresence>
                {activeTab !== 'player' && (
                  <div className={`fixed left-1/2 -translate-x-1/2 w-full max-w-md px-4 z-[90] transition-all duration-500 animate-in fade-in slide-in-from-bottom-4 ${
                    settings.menuPosition === 'bottom' ? 'bottom-28' : 'bottom-10'
                  }`}>
                    <MiniPlayer onExpand={() => setActiveTab('player')} />
                  </div>
                )}
              </AnimatePresence>
            </div>
          )}
        </main>
        
        {!isLoading && !initError && (
          <div className={cn(
            "fixed left-0 right-0 h-24 bg-system-background/80 backdrop-blur-2xl px-4 flex items-center justify-center z-[150]",
            settings.menuPosition === 'top' ? 'top-0 border-b border-apple-border/5 pt-6' : 'bottom-0 border-t border-apple-border/5 pb-6'
          )}>
            <div className="w-full max-w-md">
              <TabBar activeTab={activeTab} setActiveTab={setActiveTab} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import { ModalProvider } from './components/SafeModal';

export default function App() {
  return (
    <GlobalSafetyManager>
      <ModalProvider>
        <SettingsProvider>
          <UIStateProvider>
            <AudioProvider>
              <PlaybackProvider>
                <AppContent />
              </PlaybackProvider>
            </AudioProvider>
          </UIStateProvider>
        </SettingsProvider>
      </ModalProvider>
    </GlobalSafetyManager>
  );
}
