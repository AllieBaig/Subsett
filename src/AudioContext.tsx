import { useState, createContext, useContext, ReactNode, useEffect, useMemo, useCallback, useRef } from 'react';
import { Track, Playlist } from './types';
import * as db from './db';
import { APP_HISTORY } from './constants/history';
import { useModal } from './components/SafeModal';
import { useSettings } from './SettingsContext';
import { useUIState } from './UIStateContext';

interface AudioContextType {
  tracks: Track[];
  subliminalTracks: Track[];
  playlists: Playlist[];
  addTrack: (file: File, targetPlaylistId?: string) => Promise<string | null>;
  addSubliminalTrack: (file: File) => void;
  removeTrack: (id: string) => void;
  removeSubliminalTrack: (id: string) => void;
  
  createPlaylist: (name: string, initialTrackIds?: string[]) => Promise<string>;
  deletePlaylist: (id: string) => Promise<void>;
  addTrackToPlaylist: (trackId: string, playlistId: string) => Promise<void>;
  addTracksToPlaylist: (trackIds: string[], playlistId: string) => Promise<void>;
  removeTrackFromPlaylist: (trackId: string, playlistId: string) => Promise<void>;
  removeTracksFromPlaylist: (trackIds: string[], playlistId: string) => Promise<void>;
  renamePlaylist: (id: string, name: string) => Promise<void>;
  
  playingPlaylistId: string | null;
  setPlayingPlaylistId: (id: string | null) => void;
  resumePlaylist: (id: string) => void;
  
  exportAppData: () => Promise<void>;
  importAppData: (file: File) => Promise<void>;
  relinkTrack: (trackId: string, file: File, isSubliminal: boolean) => Promise<void>;
  getTrackUrl: (id: string, forceRefresh?: boolean) => Promise<string | null>;
  revokeTrackUrl: (id: string) => void;
  checkTrackPlayable: (id: string) => Promise<boolean>;
  
  currentTrackIndex: number | null;
  setCurrentTrackIndex: (index: number | null) => void;
  currentPlaybackList: Track[];
  playNext: (isAutoEnded?: boolean) => void;
  playPrevious: () => void;
  userPlayNext: () => void;
  userPlayPrevious: () => void;
  userPlayTrack: (index: number, playlistId?: string | null) => void;
  moveTrackInPlaylist: (playlistId: string, fromIndex: number, toIndex: number) => Promise<void>;
  toggleShuffle: () => void;
  toggleLoop: () => void;
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
  userTogglePlayback: () => void;
  
  seekTo: (time: number) => void;
  seekRequest: number | null;
  clearSeekRequest: () => void;
  
  resetServiceWorker: () => Promise<void>;
  clearCacheStorage: () => Promise<void>;
  clearDatabase: () => Promise<void>;
  fullAppReset: () => Promise<void>;
  clearAppCache: () => void;
  healSystem: () => Promise<void>;
}

const AudioContext = createContext<AudioContextType | undefined>(undefined);

export function AudioProvider({ children }: { children: ReactNode }) {
  const modal = useModal();
  const { settings, updateSubliminalSettings, updateSettings } = useSettings();
  const { setIsLoading, setInitError, showToast, isLoading } = useUIState();

  const [tracks, setTracks] = useState<Track[]>([]);
  const [subliminalTracks, setSubliminalTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [currentTrackIndex, setCurrentTrackIndex] = useState<number | null>(null);
  const [playingPlaylistId, setPlayingPlaylistId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [seekRequest, setSeekRequest] = useState<number | null>(null);
  
  const trackUrlCache = useRef<Record<string, string>>({});
  const cacheOrder = useRef<string[]>([]);

  const currentPlaybackList = useMemo(() => {
    if (playingPlaylistId) {
      const playlist = playlists.find(p => p.id === playingPlaylistId);
      if (playlist) {
        return playlist.trackIds.map(tid => tracks.find(t => t.id === tid)).filter(Boolean) as Track[];
      }
    }
    return tracks;
  }, [playingPlaylistId, playlists, tracks]);

  const currentTrack = useMemo(() => {
    if (currentTrackIndex === null) return null;
    return currentPlaybackList[currentTrackIndex] || null;
  }, [currentTrackIndex, currentPlaybackList]);

  // Auto-track last played
  useEffect(() => {
    if (currentTrack?.id && isPlaying) {
      const now = Date.now();
      db.saveTrack({ ...currentTrack, lastPlayedAt: now } as db.DBTrack, false);
      setTracks(prev => prev.map(t => t.id === currentTrack.id ? { ...t, lastPlayedAt: now } : t));
    }
  }, [currentTrack?.id, isPlaying]);

  // Initial Load
  useEffect(() => {
    let isMounted = true;
    const startupGuard = setTimeout(() => {
      if (isMounted && isLoading) {
        setInitError("Environment synchronization delay. Attempting system recovery.");
        setIsLoading(false);
      }
    }, 10000);

    async function loadData() {
      try {
        const [savedTracks, savedSubTracks, savedPlaylists] = await Promise.all([
          db.getTracks(false),
          db.getTracks(true),
          db.getPlaylists()
        ]);

        // iOS 16 Persistence Fix: Validate and potentially repair missing track references
        const validatedTracks = (savedTracks || []).map(t => ({
          ...t,
          isMissing: false // Reset flag on startup to re-validate
        }));
        
        const validatedSubTracks = (savedSubTracks || []).map(t => ({
          ...t,
          isMissing: false
        }));

          if (isMounted) {
            setTracks(validatedTracks);
            setSubliminalTracks(validatedSubTracks);
            setPlaylists(Array.isArray(savedPlaylists) ? savedPlaylists : []);
            
            // Restore playback state
            if (settings.chunking.activePlaylistId) {
              setPlayingPlaylistId(settings.chunking.activePlaylistId);
              if (settings.chunking.currentTrackIndex !== null) {
                setCurrentTrackIndex(settings.chunking.currentTrackIndex);
              }
            }

            // Deep check for binary integrity on boot
            setTimeout(async () => {
             for (const t of validatedTracks) {
               const exists = await db.getTrackBlob(t.id);
               if (!exists || exists.size === 0) {
                 console.warn(`[AudioContext] Track ${t.id} failed binary durability check.`);
                 setTracks(prev => prev.map(pt => pt.id === t.id ? { ...pt, isMissing: true } : pt));
               }
             }
          }, 3000);
        }
      } catch (err) {
        console.warn("Defensive Load Trace:", err);
        if (isMounted) setInitError("Database sync issue.");
      } finally {
        if (isMounted) {
          setIsLoading(false);
          clearTimeout(startupGuard);
        }
      }
    }
    loadData();
    return () => { 
      isMounted = false; 
      clearTimeout(startupGuard); 
      Object.values(trackUrlCache.current).forEach(url => URL.revokeObjectURL(url));
    };
  }, [setIsLoading, setInitError]);

  const getTrackUrl = useCallback(async (id: string, forceRefresh?: boolean) => {
    try {
      if (!forceRefresh && trackUrlCache.current[id]) {
        // Validation: On iOS 16, check if the URL is still likely valid
        // Actually, we'll trust it unless it fails in the actual audio element
        return trackUrlCache.current[id];
      }
      
      if (trackUrlCache.current[id]) {
        URL.revokeObjectURL(trackUrlCache.current[id]);
        delete trackUrlCache.current[id];
      }
  
      // Aggressive cache management: limit concurrent blobs to 3 for iPhone 8 (Very strict)
      if (cacheOrder.current.length >= 3) {
        const oldestId = cacheOrder.current.shift();
        if (oldestId && trackUrlCache.current[oldestId]) {
          URL.revokeObjectURL(trackUrlCache.current[oldestId]);
          delete trackUrlCache.current[oldestId];
        }
      }
  
      const blob = await db.getTrackBlob(id);
      if (blob && blob.size > 0) {
        const url = URL.createObjectURL(blob);
        trackUrlCache.current[id] = url;
        cacheOrder.current.push(id);
        return url;
      }
      
      // Silent Auto-Repair: Check if it's in tracks but blob is gone (shouldn't happen with IDB but for robustness)
      console.warn(`[AudioContext] Blob missing for ${id}.`);
      return null;
    } catch (err) {
      console.error(`[AudioContext] getTrackUrl failed for ${id}:`, err);
      return null;
    }
  }, []);

  const revokeTrackUrl = useCallback((id: string) => {
    if (trackUrlCache.current[id]) {
      URL.revokeObjectURL(trackUrlCache.current[id]);
      delete trackUrlCache.current[id];
      cacheOrder.current = cacheOrder.current.filter(item => item !== id);
    }
  }, []);

  const checkTrackPlayable = useCallback(async (id: string) => {
    try {
      const blob = await db.getTrackBlob(id);
      return !!(blob && blob.size > 0);
    } catch (err) {
      return false;
    }
  }, []);

  const validateAudioFile = (file: File): Promise<boolean> => {
    return new Promise((resolve) => {
      const ext = file.name.split('.').pop()?.toLowerCase();
      const iOSCompatibleExts = ['mp3', 'm4a', 'aac', 'wav', 'mp4', 'm4p', 'm4b', 'aiff'];
      const audio = new Audio();
      const url = URL.createObjectURL(file);
      let timeoutId: any;
      let resolved = false;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        URL.revokeObjectURL(url);
        audio.src = '';
      };
      audio.oncanplaythrough = () => { if (!resolved) { resolved = true; cleanup(); resolve(true); } };
      audio.onerror = () => { if (!resolved) { resolved = true; cleanup(); resolve(ext ? iOSCompatibleExts.includes(ext) : false); } };
      timeoutId = setTimeout(() => { if (!resolved) { resolved = true; cleanup(); resolve(ext ? iOSCompatibleExts.includes(ext) : false); } }, 3000);
      audio.src = url;
      audio.load();
    });
  };

  const getAudioDuration = (file: File): Promise<number> => {
    return new Promise((resolve) => {
      const audio = new Audio();
      const url = URL.createObjectURL(file);
      audio.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve(audio.duration);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(0);
      };
      audio.src = url;
    });
  };

  const addTrack = async (file: File, targetPlaylistId?: string) => {
    if (!(await validateAudioFile(file))) {
      showToast(`Unsupported format: ${file.name}`);
      return null;
    }
    const id = Math.random().toString(36).substr(2, 9);
    const duration = await getAudioDuration(file);
    const newTrack: db.DBTrack = {
      id,
      name: file.name.replace(/\.[^/.]+$/, ""),
      url: '', 
      artist: 'Unknown Artist',
      blob: new Blob([file], { type: file.type }), // Force data copy for IDB durability
      createdAt: Date.now(),
      duration
    };
    await db.saveTrack(newTrack, false);
    const { blob, ...metadata } = newTrack;
    setTracks(prev => [...prev, metadata]);
    if (targetPlaylistId) await addTrackToPlaylist(id, targetPlaylistId);
    if (currentTrackIndex === null) setCurrentTrackIndex(0);
    return id;
  };

  const addSubliminalTrack = async (file: File) => {
    if (!(await validateAudioFile(file))) return;
    const id = Math.random().toString(36).substr(2, 9);
    const duration = await getAudioDuration(file);
    const newTrack: db.DBTrack = { 
      id, 
      name: file.name.replace(/\.[^/.]+$/, ""), 
      url: '', 
      blob: new Blob([file], { type: file.type }), // Force data copy
      createdAt: Date.now(),
      duration
    };
    await db.saveTrack(newTrack, true);
    const { blob, ...metadata } = newTrack;
    setSubliminalTracks(prev => [...prev, metadata]);
    if (!settings.subliminal.selectedTrackId) updateSubliminalSettings({ selectedTrackId: id });
  };

  // Duration Migration & Verification
  useEffect(() => {
    if (!isLoading && tracks.length > 0) {
      const tracksToFix = tracks.filter(t => !t.duration || t.duration === 0);
      if (tracksToFix.length > 0) {
        async function fixDurations() {
          console.log(`[AudioContext] Syncing durations for ${tracksToFix.length} tracks...`);
          for (const track of tracksToFix) {
            const blob = await db.getTrackBlob(track.id);
            if (blob && blob.size > 0) {
              const audio = new Audio();
              const url = URL.createObjectURL(blob);
              await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                  URL.revokeObjectURL(url);
                  resolve();
                }, 5000);
                
                audio.onloadedmetadata = () => {
                  const duration = audio.duration;
                  if (duration && !isNaN(duration)) {
                    db.saveTrack({ ...track, duration } as db.DBTrack, false);
                    setTracks(prev => prev.map(t => t.id === track.id ? { ...t, duration } : t));
                  }
                  clearTimeout(timeout);
                  URL.revokeObjectURL(url);
                  resolve();
                };
                audio.onerror = () => {
                  clearTimeout(timeout);
                  URL.revokeObjectURL(url);
                  resolve();
                };
                audio.src = url;
                audio.load();
              });
            }
          }
        }
        fixDurations();
      }
    }
  }, [isLoading, tracks.length]);

  const removeTrack = async (id: string) => {
    await db.deleteTrack(id, false);
    setTracks(prev => prev.filter(t => t.id !== id));
  };

  const removeSubliminalTrack = async (id: string) => {
    await db.deleteTrack(id, true);
    setSubliminalTracks(prev => prev.filter(t => t.id !== id));
  };

  const createPlaylist = async (name: string, initialTrackIds: string[] = []) => {
    const id = Math.random().toString(36).substr(2, 9);
    const playlist: Playlist = { id, name, trackIds: initialTrackIds, createdAt: Date.now() };
    await db.savePlaylist(playlist);
    setPlaylists(prev => [...prev, playlist]);
    showToast(`Created playlist "${name}"`);
    return id;
  };

  const deletePlaylist = async (id: string) => {
    await db.deletePlaylist(id);
    setPlaylists(prev => prev.filter(p => p.id !== id));
  };

  const addTracksToPlaylist = async (trackIds: string[], playlistId: string) => {
    let updated: Playlist | null = null;
    setPlaylists(prev => {
      const p = prev.find(x => x.id === playlistId);
      if (!p) return prev;
      updated = { ...p, trackIds: Array.from(new Set([...p.trackIds, ...trackIds])) };
      return prev.map(x => x.id === playlistId ? updated! : x);
    });
    if (updated) await db.savePlaylist(updated);
  };

  const addTrackToPlaylist = (tid: string, pid: string) => addTracksToPlaylist([tid], pid);

  const removeTracksFromPlaylist = async (trackIds: string[], playlistId: string) => {
    let updated: Playlist | null = null;
    setPlaylists(prev => {
      const p = prev.find(x => x.id === playlistId);
      if (!p) return prev;
      updated = { ...p, trackIds: p.trackIds.filter(id => !trackIds.includes(id)) };
      return prev.map(x => x.id === playlistId ? updated! : x);
    });
    if (updated) await db.savePlaylist(updated);
  };

  const removeTrackFromPlaylist = (tid: string, pid: string) => removeTracksFromPlaylist([tid], pid);

  const renamePlaylist = async (id: string, name: string) => {
    setPlaylists(prev => prev.map(p => p.id === id ? { ...p, name } : p));
    const p = playlists.find(x => x.id === id);
    if (p) await db.savePlaylist({ ...p, name });
  };

  const resumePlaylist = (id: string) => {
    // Manually trigger unlock event for any listener (like AudioEngine)
    // On iOS, this is crucial for the button to be a valid user gesture
    window.dispatchEvent(new CustomEvent('zen-audio-unlock'));

    const playlist = playlists.find(p => p.id === id);
    if (!playlist || playlist.trackIds.length === 0) return;
    const memory = settings.playlistMemory[id];
    let idx = 0;
    let pos = 0;
    if (memory) {
      const found = playlist.trackIds.indexOf(memory.trackId);
      if (found !== -1) { idx = found; pos = memory.position; }
    }
    setPlayingPlaylistId(id);
    setCurrentTrackIndex(idx);
    if (pos > 0) setTimeout(() => setSeekRequest(pos), 100);
    setIsPlaying(true);
  };

  const toggleShuffle = () => {
    updateSettings({ shuffle: !settings.shuffle });
    showToast(settings.shuffle ? "Shuffle off" : "Shuffle on");
  };

  const toggleLoop = () => {
    const modes: ('none' | 'one' | 'all')[] = ['none', 'one', 'all'];
    const nextMode = modes[(modes.indexOf(settings.loop) + 1) % modes.length];
    updateSettings({ loop: nextMode });
    showToast(`Loop: ${nextMode}`);
  };

  const playNext = useCallback((isAutoEnded = false) => {
    if (currentPlaybackList.length === 0) return;
    if (isAutoEnded && settings.loop === 'one') { setSeekRequest(0); setIsPlaying(true); return; }
    let nextIndex: number;
    if (settings.shuffle) {
      nextIndex = Math.floor(Math.random() * currentPlaybackList.length);
    } else {
      const isLast = currentTrackIndex === null || currentTrackIndex >= currentPlaybackList.length - 1;
      if (isAutoEnded && isLast && settings.loop !== 'all') { setIsPlaying(false); return; }
      nextIndex = isLast ? 0 : (currentTrackIndex || 0) + 1;
    }
    setCurrentTrackIndex(nextIndex);
    setIsPlaying(true);
  }, [currentPlaybackList, currentTrackIndex, settings.loop, settings.shuffle]);

  const playPrevious = useCallback(() => {
    if (currentPlaybackList.length === 0) return;
    const idx = (currentTrackIndex === null || currentTrackIndex === 0) ? currentPlaybackList.length - 1 : currentTrackIndex - 1;
    setCurrentTrackIndex(idx);
    setIsPlaying(true);
  }, [currentPlaybackList, currentTrackIndex]);

  const userPlayNext = useCallback(() => {
    window.dispatchEvent(new CustomEvent('zen-audio-unlock'));
    playNext(false);
  }, [playNext]);

  const userPlayPrevious = useCallback(() => {
    window.dispatchEvent(new CustomEvent('zen-audio-unlock'));
    playPrevious();
  }, [playPrevious]);

  const userPlayTrack = useCallback((index: number, playlistId: string | null = null) => {
    window.dispatchEvent(new CustomEvent('zen-audio-unlock'));
    setPlayingPlaylistId(playlistId);
    setCurrentTrackIndex(index);
    setIsPlaying(true);
  }, []);

  const exportAppData = async () => {
    try {
      const [tData, sData, pData, sSet] = await Promise.all([db.getTracksWithBlobs(false), db.getTracksWithBlobs(true), db.getPlaylists(), db.getSettings()]);
      const blob = new Blob([JSON.stringify({ version: "Refactored", tracks: tData, subliminalTracks: sData, playlists: pData, settings: sSet })], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `mindful_backup_${Date.now()}.json`; a.click();
    } catch (e) { showToast("Export failed"); }
  };

  const importAppData = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (!data.tracks) throw new Error("Invalid");
      if (!(await modal.confirm({ title: "Import Data", subtitle: "Settings will be overwritten." }))) return;
      setIsLoading(true);
      if (data.settings) { await db.saveSettings(data.settings); updateSettings(data.settings); }
      for (const t of data.tracks) await db.saveTrack(t, false);
      for (const t of data.subliminalTracks || []) await db.saveTrack(t, true);
      for (const p of data.playlists || []) await db.savePlaylist(p);
      window.location.reload();
    } catch (e) { setIsLoading(false); showToast("Import failed"); }
  };

  const moveTrackInPlaylist = async (playlistId: string, fromIndex: number, toIndex: number) => {
    let updated: Playlist | null = null;
    setPlaylists(prev => {
      const p = prev.find(x => x.id === playlistId);
      if (!p) return prev;
      const newTrackIds = [...p.trackIds];
      const [moved] = newTrackIds.splice(fromIndex, 1);
      newTrackIds.splice(toIndex, 0, moved);
      updated = { ...p, trackIds: newTrackIds };
      return prev.map(x => x.id === playlistId ? updated! : x);
    });
    if (updated) await db.savePlaylist(updated);
  };

  const relinkTrack = async (id: string, file: File, sub: boolean) => {
    try {
      if (!(await validateAudioFile(file))) return;
      const track = (sub ? subliminalTracks : tracks).find(t => t.id === id);
      if (track) { 
        await db.saveTrack({ ...track, blob: new Blob([file], { type: file.type }) } as any, sub); 
        await getTrackUrl(id, true); 
        showToast("Relinked"); 
      }
    } catch (e) { showToast("Relink failed"); }
  };

  const resetServiceWorker = async () => { if ('serviceWorker' in navigator) { const regs = await navigator.serviceWorker.getRegistrations(); for (const r of regs) await r.unregister(); showToast("SW Unregistered"); } };
  const clearCacheStorage = async () => { if ('caches' in window) { const keys = await caches.keys(); for (const k of keys) await caches.delete(k); showToast("Cache Cleared"); } };
  const clearDatabase = async () => { if (await modal.confirm({ title: "Clear Database", isDestructive: true })) { await db.clearAllData(); setTracks([]); setSubliminalTracks([]); setPlaylists([]); } };
  const fullAppReset = async () => { if (await modal.confirm({ title: "Factory Reset", isDestructive: true })) { await resetServiceWorker(); await clearCacheStorage(); await db.clearAllData(); localStorage.clear(); window.location.reload(); } };
  const clearAppCache = () => { trackUrlCache.current = {}; cacheOrder.current = []; showToast("Mem cache cleared"); };

  const healSystem = async () => {
    try {
      setIsLoading(true);
      console.log("[AudioContext] Initiating System Healing...");
      
      // 1. Clear all live object URLs
      Object.keys(trackUrlCache.current).forEach(id => {
        URL.revokeObjectURL(trackUrlCache.current[id]);
      });
      trackUrlCache.current = {};
      cacheOrder.current = [];
      
      // 2. Re-fetch all data from DB to ensure synced state
      const [savedTracks, savedSubTracks, savedPlaylists] = await Promise.all([
        db.getTracks(false),
        db.getTracks(true),
        db.getPlaylists()
      ]);
      
      setTracks(savedTracks || []);
      setSubliminalTracks(savedSubTracks || []);
      setPlaylists(savedPlaylists || []);
      
      showToast("System Healed & Synced");
    } catch (err) {
      console.error("[AudioContext] Healing failed:", err);
      showToast("Healing failed.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSetIsPlaying = useCallback((val: boolean) => {
    setIsPlaying(val);
  }, []);

  const userTogglePlayback = useCallback(() => {
    // 1. Manually trigger unlock event for any listener (like AudioEngine)
    // On iOS, this is crucial for the Play button to be a valid user gesture
    window.dispatchEvent(new CustomEvent('zen-audio-unlock'));
    
    // 2. Toggle the playing state
    setIsPlaying(prev => !prev);
  }, []);

  return (
    <AudioContext.Provider value={{
      tracks, subliminalTracks, playlists, addTrack, addSubliminalTrack, removeTrack, removeSubliminalTrack,
      createPlaylist, deletePlaylist, addTrackToPlaylist, addTracksToPlaylist, removeTrackFromPlaylist, removeTracksFromPlaylist, renamePlaylist,
      playingPlaylistId, setPlayingPlaylistId, resumePlaylist, exportAppData, importAppData, relinkTrack, getTrackUrl, revokeTrackUrl, checkTrackPlayable,
      currentTrackIndex, setCurrentTrackIndex, currentPlaybackList, playNext, playPrevious, toggleShuffle, toggleLoop, isPlaying, setIsPlaying: handleSetIsPlaying,
      userTogglePlayback, userPlayNext, userPlayPrevious, userPlayTrack, moveTrackInPlaylist,
      seekTo: setSeekRequest, seekRequest, clearSeekRequest: () => setSeekRequest(null),
      resetServiceWorker, clearCacheStorage, clearDatabase, fullAppReset, clearAppCache, healSystem
    }}>
      {children}
    </AudioContext.Provider>
  );
}

export function useAudio() {
  const context = useContext(AudioContext);
  if (context === undefined) throw new Error('useAudio must be used within an AudioProvider');
  return context;
}
