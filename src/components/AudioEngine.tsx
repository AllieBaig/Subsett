import { useEffect, useRef, useMemo, useState } from 'react';
import { useAudio } from '../AudioContext';
import { usePlayback } from '../PlaybackContext';
import { useSettings } from '../SettingsContext';
import { useUIState } from '../UIStateContext';
import { NATURE_SOUNDS } from '../constants';
import { ChunkManager } from '../utils/ChunkManager';
import * as db from '../db';

export default function AudioEngine() {
  const { 
    tracks, 
    subliminalTracks, 
    currentTrackIndex, 
    setCurrentTrackIndex,
    isPlaying, 
    playlists,
    setIsPlaying,
    playNext,
    playPrevious,
    seekTo,
    currentPlaybackList,
    playingPlaylistId,
    getTrackUrl,
    revokeTrackUrl,
    checkTrackPlayable,
    healSystem,
    seekRequest,
    clearSeekRequest
  } = useAudio();

  const { currentTime, setCurrentTime, setDuration, updateLayerProgress, layerProgress } = usePlayback();

  const { settings, updateSettings, updateAudioTools } = useSettings();
  const { isLoading, showToast, isOffline, navigateTo, activeTabRequest, clearTabRequest } = useUIState();
  const [isRenderingChunk, setIsRenderingChunk] = useState(false);
  const chunkPlanRef = useRef<any>(null);
  const lastBgGenTime = useRef<Record<string, number>>({});
  const activeChunkIdRef = useRef<string | null>(null);
  const nextChunkIdRef = useRef<string | null>(null);
  const chunkUrlsRef = useRef<Record<string, string>>({});
  const chunkCleanupRef = useRef<Set<string>>(new Set());

  // Detect Foreground/Background
  const [isForeground, setIsForeground] = useState(document.visibilityState === 'visible');
  useEffect(() => {
    const handleVisibility = () => setIsForeground(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // Heartbeat Mechanism for iOS 16 Background Persistence
  const heartbeatAudioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const audio = new Audio();
    // 10 seconds of silence (WAV) for better stability and lower CPU
    audio.src = "data:audio/wav;base64,UklGRqAIAABXQVZFRm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YfAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; 
    audio.loop = true;
    audio.volume = 0.0001; // Silent but keeps session active
    (audio as any).playsInline = true;
    (audio as any).webkitPlaysInline = true;
    heartbeatAudioRef.current = audio;
    return () => {
      audio.pause();
      audio.src = "";
    };
  }, []);

  useEffect(() => {
    if (isPlaying && (settings.chunking.mode === 'heartbeat' || settings.chunking.mode === 'merge')) {
      // HEARTBEAT should run in BOTH modes to ensure background gapless on iOS 16
      heartbeatAudioRef.current?.play().catch(() => {});
    } else {
      heartbeatAudioRef.current?.pause();
    }
  }, [isPlaying, settings.chunking.mode]);

  // Update Chunk Plan when Playlist changes
  useEffect(() => {
    if (!playingPlaylistId || currentPlaybackList.length === 0) {
      chunkPlanRef.current = null;
      return;
    }

    const updatePlan = async () => {
      const plan = await ChunkManager.createChunkPlan(playingPlaylistId, currentPlaybackList, settings.chunking.sizeMinutes);
      chunkPlanRef.current = plan;
      
      // Determine current chunk and position based on currentTrackIndex
      if (currentTrackIndex !== null) {
        let cumulativeTracks = 0;
        let cumulativeDuration = 0;
        let foundIdx = 0;
        let trackStartOffset = 0;

        for (let i = 0; i < plan.chunks.length; i++) {
          const chunk = plan.chunks[i];
          let chunkDuration = 0;
          let trackFoundInThisChunk = false;
          let offsetInChunk = 0;

          for (let j = 0; j < chunk.trackIds.length; j++) {
            const trackId = chunk.trackIds[j];
            const duration = await ChunkManager.getAudioDuration(trackId);
            
            if (cumulativeTracks === currentTrackIndex) {
              trackFoundInThisChunk = true;
              trackStartOffset = offsetInChunk;
            }
            
            offsetInChunk += duration;
            chunkDuration += duration;
            cumulativeTracks++;
          }

          if (trackFoundInThisChunk) {
            foundIdx = i;
            break;
          }
        }
        
        const isSameChunk = settings.chunking.activePlaylistId === playingPlaylistId && 
                            settings.chunking.currentChunkIndex === foundIdx;

        updateSettings({
          chunking: {
            ...settings.chunking,
            activePlaylistId: playingPlaylistId,
            currentChunkIndex: foundIdx,
            lastChunkPosition: trackStartOffset,
            currentTrackIndex: currentTrackIndex
          }
        });

        // Forced seek if same chunk
        if (isSameChunk && mainAudioRef.current) {
          mainAudioRef.current.currentTime = trackStartOffset;
        }
      }
    };
    updatePlan();
  }, [playingPlaylistId, currentPlaybackList.length, currentTrackIndex]);

  // Foreground Rendering Loop
  useEffect(() => {
    if (!isForeground || !chunkPlanRef.current || isRenderingChunk) return;

    const renderNextIfNeeded = async () => {
      const plan = chunkPlanRef.current;
      const { activePlaylistId, currentChunkIndex } = settings.chunking;
      
      if (activePlaylistId !== plan.playlistId) return;

      const currentId = `chunk_${activePlaylistId}_${currentChunkIndex}`;
      const nextIdx = (currentChunkIndex + 1) >= plan.chunks.length ? (settings.playbackMode === 'loop' ? 0 : -1) : currentChunkIndex + 1;
      
      // Check if current chunk exists
      const currentMeta = await db.getChunkMetadata(currentId);
      if (!currentMeta) {
        setIsRenderingChunk(true);
        const rendered = await ChunkManager.renderChunk(activePlaylistId!, currentChunkIndex, plan.chunks[currentChunkIndex].trackIds);
        if (rendered) {
          await db.saveChunk({
            id: currentId,
            playlistId: activePlaylistId!,
            index: currentChunkIndex,
            trackIds: plan.chunks[currentChunkIndex].trackIds,
            duration: rendered.duration,
            expiresAt: Date.now() + 3600000
          }, rendered.blob);
        }
        setIsRenderingChunk(false);
        return;
      }

      // Pre-render next chunk
      if (nextIdx !== -1) {
        const nextId = `chunk_${activePlaylistId}_${nextIdx}`;
        const nextMeta = await db.getChunkMetadata(nextId);
        if (!nextMeta) {
          setIsRenderingChunk(true);
          const rendered = await ChunkManager.renderChunk(activePlaylistId!, nextIdx, plan.chunks[nextIdx].trackIds);
          if (rendered) {
            await db.saveChunk({
              id: nextId,
              playlistId: activePlaylistId!,
              index: nextIdx,
              trackIds: plan.chunks[nextIdx].trackIds,
              duration: rendered.duration,
              expiresAt: Date.now() + 3600000
            }, rendered.blob);
          }
          setIsRenderingChunk(false);
        }
      }

      // Cleanup old chunks: Keep only current + next
      const chunksInDb = await db.getAllChunkMetadata();
      const nextId = nextIdx !== -1 ? `chunk_${activePlaylistId}_${nextIdx}` : null;
      for (const meta of chunksInDb) {
        if (meta.id !== currentId && meta.id !== nextId) {
          await db.deleteChunk(meta.id);
        }
      }
    };

    const interval = setInterval(renderNextIfNeeded, 5000);
    return () => clearInterval(interval);
  }, [isForeground, isRenderingChunk, settings.chunking, settings.playbackMode]);

  // Track current URL to revoke it later
  const lastMainUrlRef = useRef<string | null>(null);

  const cleanupLastUrl = () => {
    if (lastMainUrlRef.current) {
      URL.revokeObjectURL(lastMainUrlRef.current);
      lastMainUrlRef.current = null;
    }
  };

  // Save chunk position periodically
  useEffect(() => {
    if (!isPlaying || !mainAudioRef.current) return;
    const interval = setInterval(() => {
      if (mainAudioRef.current) {
        updateSettings({
          chunking: {
            ...settings.chunking,
            lastChunkPosition: mainAudioRef.current.currentTime
          }
        });
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [isPlaying, settings.chunking.activePlaylistId, settings.chunking.currentChunkIndex]);
  const [preparedUrl, setPreparedUrl] = useState<string | null>(null);
  const [preparedSubUrl, setPreparedSubUrl] = useState<string | null>(null);
  const mainAudioRef = useRef<HTMLAudioElement | null>(null);
  const subAudioRef = useRef<HTMLAudioElement | null>(null);
  const delayTimeoutRef = useRef<number | null>(null);
  const subPlaylistIndexRef = useRef<number>(0);
  const tracksPlayedInSessionRef = useRef<number>(0);
  const lastSkipTimeRef = useRef<number>(0);
  const skipCountRef = useRef<number>(0);

  // Binaural Web Audio Refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const leftOscRef = useRef<OscillatorNode | null>(null);
  const rightOscRef = useRef<OscillatorNode | null>(null);
  const binauralGainRef = useRef<GainNode | null>(null);
  
  // Audio Tools Refs
  const mainSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const mainGainRef = useRef<GainNode | null>(null);
  const subSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const subSpecificGainRef = useRef<GainNode | null>(null);
  const toolGainRef = useRef<GainNode | null>(null);
  const toolCompressorRef = useRef<DynamicsCompressorNode | null>(null);

  // Noise & Nature Refs
  const noiseNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const noiseGainRef = useRef<GainNode | null>(null);
  const natureAudioRef = useRef<HTMLAudioElement | null>(null);
  const natureSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const natureGainRef = useRef<GainNode | null>(null);
  const natureCompRef = useRef<DynamicsCompressorNode | null>(null);

  // Background HTML Audio Refs for iOS 16 Persistence - Double Buffered for Gapless
  const bgAudioRefs = useRef<Record<string, HTMLAudioElement>>({});
  const bgAudioRefs2 = useRef<Record<string, HTMLAudioElement>>({});
  const activeBgRef = useRef<Record<string, 1 | 2>>({});
  const bgAudioUrls = useRef<Record<string, string>>({});
  const bgAudioParams = useRef<Record<string, string>>({});

  // Helper: Simple WAV Encoder
  const audioBufferToWav = (buffer: AudioBuffer) => {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;
    const numSamples = buffer.length;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numSamples * blockAlign;
    const headerSize = 44;
    const arrayBuffer = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(arrayBuffer);

    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    const offset = 44;
    for (let i = 0; i < numSamples; i++) {
      for (let channel = 0; channel < numChannels; channel++) {
        const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i]));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset + (i * blockAlign) + (channel * bytesPerSample), intSample, true);
      }
    }
    return new Blob([arrayBuffer], { type: 'audio/wav' });
  };

  // Helper: Generate Tone Blob
  const generateToneBlob = async (type: string, options: any) => {
    const OfflineCtx = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    const duration = 30; // 30s for smoother looping and stability
    const sampleRate = 44100;
    const numChannels = type === 'binaural' ? 2 : 1;
    const ctx = new OfflineCtx(numChannels, sampleRate * duration, sampleRate);
    
    // Calculate baked gain (Volume % + Gain dB + Master Gain dB)
    // This solves the iOS 16 background bug where <audio> volume property is ignored or unreliable
    const bakedGainValue = (options.volume || 1.0) * Math.pow(10, (options.gainDb || 0) / 20);
    const masterGainMultiplier = (options.masterGainDb !== undefined) ? Math.pow(10, options.masterGainDb / 20) : 1.0;
    const finalGainValue = bakedGainValue * masterGainMultiplier;

    // Create a final baked-in gain node for the offline context
    const masterGainNode = ctx.createGain();
    masterGainNode.gain.setValueAtTime(finalGainValue, 0);
    masterGainNode.connect(ctx.destination);

    // Setup layer specific offline graph
    if (type === 'pureHz' || type === 'solfeggio') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(options.frequency, 0);
      const gain = ctx.createGain();
      // Base sensitivity for these tones (0.08 was original for headroom)
      gain.gain.setValueAtTime(0.08, 0); 
      osc.connect(gain);
      gain.connect(masterGainNode);
      osc.start(0);
    } 
    else if (type === 'binaural') {
      const left = ctx.createOscillator();
      const right = ctx.createOscillator();
      const merger = ctx.createChannelMerger(2);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.08, 0);
      left.frequency.setValueAtTime(options.leftFreq, 0);
      right.frequency.setValueAtTime(options.rightFreq, 0);
      left.connect(merger, 0, 0);
      right.connect(merger, 0, 1);
      merger.connect(gain);
      gain.connect(masterGainNode);
      left.start(0);
      right.start(0);
    }
    else if (type === 'noise') {
      const bufferSize = sampleRate * duration;
      const buffer = ctx.createBuffer(1, bufferSize, sampleRate);
      const output = buffer.getChannelData(0);
      
      if (options.noiseType === 'white') {
        for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1;
      } else if (options.noiseType === 'pink') {
        let b0, b1, b2, b3, b4, b5, b6;
        b0 = b1 = b2 = b3 = b4 = b5 = b6 = 0.0;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.96900 * b2 + white * 0.1538520;
          b3 = 0.86650 * b3 + white * 0.3102503;
          b4 = 0.55000 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.0168980;
          output[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
          output[i] *= 0.11;
          b6 = white * 0.115926;
        }
      } else {
        let lastOut = 0.0;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          const out = (lastOut + (0.02 * white)) / 1.02;
          lastOut = out;
          output[i] = out * 3.5;
        }
      }
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.06, 0); // Base sensitivity
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain);
      gain.connect(masterGainNode);
      source.start(0);
    }
    else if (type === 'isochronic') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const outGain = ctx.createGain();
      const lfo = ctx.createOscillator();
      outGain.gain.setValueAtTime(0.08, 0); // Base sensitivity
      osc.frequency.setValueAtTime(options.frequency, 0);
      lfo.type = 'square';
      lfo.frequency.setValueAtTime(options.pulseRate, 0);
      const lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(0.5, 0);
      const constant = ctx.createConstantSource();
      constant.offset.setValueAtTime(0.5, 0);
      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain);
      constant.connect(gain.gain);
      osc.connect(gain);
      gain.connect(outGain);
      outGain.connect(masterGainNode);
      lfo.start(0);
      constant.start(0);
      osc.start(0);
    }
    else if (type === 'didgeridoo') {
      const osc = ctx.createOscillator();
      const sub = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const outGain = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      outGain.gain.setValueAtTime(0.06, 0); // Base sensitivity
      osc.type = 'sawtooth';
      sub.type = 'sine';
      osc.frequency.setValueAtTime(options.frequency, 0);
      sub.frequency.setValueAtTime(options.frequency, 0);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(options.frequency * 2.7 * (1 + options.depth), 0);
      filter.Q.setValueAtTime(15, 0);
      lfo.frequency.setValueAtTime(0.15, 0);
      lfoGain.gain.setValueAtTime(60 * options.depth, 0);
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      osc.connect(filter);
      sub.connect(filter);
      filter.connect(outGain);
      outGain.connect(masterGainNode);
      lfo.start(0);
      osc.start(0);
      sub.start(0);
    }

    const renderedBuffer = await ctx.startRendering();
    return audioBufferToWav(renderedBuffer);
  };

  // Per-layer Compressor Refs for Normalization
  const subCompRef = useRef<DynamicsCompressorNode | null>(null);
  const binCompRef = useRef<DynamicsCompressorNode | null>(null);
  const noiseCompRef = useRef<DynamicsCompressorNode | null>(null);
  const didgCompRef = useRef<DynamicsCompressorNode | null>(null);
  const pureHzCompRef = useRef<DynamicsCompressorNode | null>(null);

  // Master Gain & Limiter for Stable Parallel Mixing
  const masterGainRef = useRef<GainNode | null>(null);
  const masterLimiterRef = useRef<DynamicsCompressorNode | null>(null);

  // Didgeridoo Refs
  const didgOscRef = useRef<OscillatorNode | null>(null);
  const didgSubOscRef = useRef<OscillatorNode | null>(null);
  const didgFilterRef = useRef<BiquadFilterNode | null>(null);
  const didgGainRef = useRef<GainNode | null>(null);
  const didgLfoRef = useRef<OscillatorNode | null>(null);

  // Pure Hz Refs
  const pureHzOscRef = useRef<OscillatorNode | null>(null);
  const pureHzGainRef = useRef<GainNode | null>(null);

  // Isochronic Refs
  const isoOscRef = useRef<OscillatorNode | null>(null);
  const isoGainRef = useRef<GainNode | null>(null);
  const isoLfoRef = useRef<OscillatorNode | null>(null);
  const isoLfoGainRef = useRef<GainNode | null>(null);
  const isoCompRef = useRef<DynamicsCompressorNode | null>(null);

  // Solfeggio Refs
  const solOscRef = useRef<OscillatorNode | null>(null);
  const solGainRef = useRef<GainNode | null>(null);
  const solCompRef = useRef<DynamicsCompressorNode | null>(null);

  // iOS Background Audio & Media Session Setup
  useEffect(() => {
    // Helper to ensure AudioContext is ready on any media session action
    const withResume = (fn: () => void) => {
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }
      fn();
    };

    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => withResume(() => setIsPlaying(true)));
      navigator.mediaSession.setActionHandler('pause', () => setIsPlaying(false));
      navigator.mediaSession.setActionHandler('nexttrack', () => withResume(() => playNext()));
      navigator.mediaSession.setActionHandler('previoustrack', () => withResume(() => playPrevious()));
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined) seekTo(details.seekTime);
        if (details.fastSeek && mainAudioRef.current) {
          mainAudioRef.current.currentTime = details.seekTime || 0;
        }
      });
      
      // iOS 16 fallback seek handlers
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        const offset = details.seekOffset || 10;
        if (mainAudioRef.current) seekTo(Math.max(0, mainAudioRef.current.currentTime - offset));
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        const offset = details.seekOffset || 10;
        if (mainAudioRef.current) seekTo(Math.min(mainAudioRef.current.duration, mainAudioRef.current.currentTime + offset));
      });
    }

    return () => {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.setActionHandler('nexttrack', null);
        navigator.mediaSession.setActionHandler('previoustrack', null);
        navigator.mediaSession.setActionHandler('seekto', null);
        navigator.mediaSession.setActionHandler('seekbackward', null);
        navigator.mediaSession.setActionHandler('seekforward', null);
      }
    };
  }, [playNext, playPrevious, setIsPlaying, seekTo]);

  // Playlist Memory Tracker - Isolated from global UI updates
  useEffect(() => {
    if (!playingPlaylistId || isLoading || currentTrackIndex === null || !isPlaying) return;
    
    const playlist = playlists.find(p => p.id === playingPlaylistId);
    if (!playlist) return;

    const currentTrackId = playlist.trackIds[currentTrackIndex];
    if (!currentTrackId) return;

    // Use a timeout to throttle updates to once every 5 seconds
    const timer = setTimeout(() => {
      updateSettings({
        playlistMemory: {
          ...settings.playlistMemory,
          [playingPlaylistId]: {
            trackId: currentTrackId,
            position: currentTime,
            timestamp: Date.now()
          }
        }
      });
    }, 5000);

    return () => clearTimeout(timer);
  }, [playingPlaylistId, currentTrackIndex, Math.floor(currentTime / 5), isPlaying, isLoading, updateSettings, settings.playlistMemory, playlists]);

  // Sync Media Session Metadata
  useEffect(() => {
    if ('mediaSession' in navigator) {
      if (currentTrackIndex !== null && tracks[currentTrackIndex]) {
        const track = tracks[currentTrackIndex];
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.name,
          artist: track.artist || 'Unknown Artist',
          album: 'Subliminal Journey',
          artwork: [
            { src: track.artwork || 'https://picsum.photos/seed/music/512/512', sizes: '512x512', type: 'image/png' }
          ]
        });
      } else {
        // Find active Hz layer to show in metadata if no track is playing
        const activeLayer = Object.entries(settings).find(([key, val]: [string, any]) => 
          val?.isEnabled && val?.playInBackground && ['pureHz', 'binaural', 'isochronic', 'solfeggio', 'didgeridoo', 'noise', 'nature'].includes(key)
        );

        if (activeLayer) {
          const [id, s] = activeLayer;
          let title = id.charAt(0).toUpperCase() + id.slice(1);
          let subtitle = 'Active Ambient Layer';
          
          if (id === 'pureHz') subtitle = `${s.frequency}Hz Pure Tone`;
          else if (id === 'solfeggio') subtitle = `${s.frequency}Hz Solfeggio`;
          else if (id === 'binaural') subtitle = `Binaural: ${s.leftFreq}Hz / ${s.rightFreq}Hz`;
          else if (id === 'isochronic') subtitle = `Isochronic: ${s.pulseRate}Hz Pulse`;
          
          navigator.mediaSession.metadata = new MediaMetadata({
            title: title,
            artist: subtitle,
            album: 'Silent Journey',
            artwork: [
              { src: 'https://picsum.photos/seed/meditation/512/512', sizes: '512x512', type: 'image/png' }
            ]
          });
        }
      }
    }
  }, [currentTrackIndex, tracks, settings, isPlaying]);

  // Update background layers volume with master gain
  useEffect(() => {
    const masterGainMultiplier = settings.audioTools.gainDb !== 0 ? Math.pow(10, settings.audioTools.gainDb / 20) : 1.0;

    Object.entries(bgAudioRefs.current).forEach(([id, el]) => {
      const s = (settings as any)[id];
      if (s) {
        const layerGain = Math.pow(10, (s.gainDb || 0) / 20);
        const volume = s.volume * layerGain * masterGainMultiplier;
        el.volume = Math.min(1.0, Math.max(0.0, volume));
      }
    });

    if (natureAudioRef.current) {
      const s = settings.nature;
      const layerGain = Math.pow(10, (s.gainDb || 0) / 20);
      const volume = s.volume * layerGain * masterGainMultiplier;
      natureAudioRef.current.volume = Math.min(1.0, Math.max(0.0, volume));
    }
  }, [settings.audioTools.gainDb, settings.pureHz, settings.binaural, settings.isochronic, settings.solfeggio, settings.didgeridoo, settings.noise, settings.nature]);

  // Consolidate Audio Elements Lifecycle & iOS Unlock
  useEffect(() => {
    // Initialize elements
    const mainAudio = new Audio();
    const subAudio = new Audio();
    const natureAudio = new Audio();
    
    [mainAudio, subAudio, natureAudio].forEach(a => {
      (a as any).playsInline = true;
      (a as any).webkitPlaysInline = true;
      a.preload = 'auto';
    });

    natureAudio.loop = true;

    mainAudioRef.current = mainAudio;
    subAudioRef.current = subAudio;
    natureAudioRef.current = natureAudio;

    // iOS Safari Audio Unlock Helper
    const initCtx = () => {
      if (!audioCtxRef.current) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
          audioCtxRef.current = new AudioContextClass();
        }
      }
      return audioCtxRef.current;
    };

    const unlockAudio = () => {
      const ctx = initCtx();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().then(() => {
          console.log('[AudioEngine] Context resumed via interaction');
          const buffer = ctx.createBuffer(1, 1, 22050);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          source.start(0);
        }).catch(err => console.warn('[AudioEngine] Resume failed:', err));
      }
      
      // Unlock HTML Audio elements by playing/pausing
      [mainAudio, subAudio, natureAudio].forEach(a => {
        a.play().then(() => a.pause()).catch(() => {});
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setIsForeground(true);
        console.log('[AudioEngine] System visibility changed to visible - Resuming session');
        // Pre-emptively resume context if needed
        if (audioCtxRef.current && needsWebAudio) {
          audioCtxRef.current.resume().catch(() => {});
        }
        
        // Force sync element state
        if (isPlaying && mainAudioRef.current && mainAudioRef.current.paused) {
          mainAudioRef.current.play().catch(err => console.warn('[AudioEngine] Resume-on-visible failed:', err));
        }
      } else {
        setIsForeground(false);
      }
    };

    window.addEventListener('click', unlockAudio, { passive: true });
    window.addEventListener('touchstart', unlockAudio, { passive: true });
    window.addEventListener('zen-audio-unlock', unlockAudio);
    window.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('click', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
      window.removeEventListener('zen-audio-unlock', unlockAudio);
      window.removeEventListener('visibilitychange', handleVisibilityChange);
      
      [mainAudio, subAudio, natureAudio].forEach(a => {
        a.pause();
        a.src = '';
      });

      // Cleanup Background Audio
      Object.entries(bgAudioRefs.current).forEach(([id, a]) => {
        a.pause();
        a.src = '';
        a.load();
      });
      Object.values(bgAudioUrls.current).forEach(url => {
        URL.revokeObjectURL(url);
      });
      bgAudioRefs.current = {};
      bgAudioRefs2.current = {};
      bgAudioUrls.current = {};
      bgAudioParams.current = {};
      
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(console.error);
      }
      
      mainAudioRef.current = null;
      subAudioRef.current = null;
      natureAudioRef.current = null;
    };
  }, []); // Run once on mount

  // Determine if we actually need Web Audio active
  const needsWebAudio = useMemo(() => {
    return (isPlaying && (
      !settings.subliminal.playInBackground ||
      !settings.binaural.playInBackground ||
      !settings.noise.playInBackground ||
      !settings.nature.playInBackground ||
      !settings.didgeridoo.playInBackground ||
      !settings.pureHz.playInBackground ||
      !settings.isochronic.playInBackground ||
      !settings.solfeggio.playInBackground
    )) || false;
  }, [isPlaying, settings]);

  // Audio Context Heartbeat & Battery Management
  useEffect(() => {
    const interval = setInterval(() => {
      if (!audioCtxRef.current) return;
      const ctx = audioCtxRef.current;

      if (needsWebAudio && isPlaying) {
        if (ctx.state === 'suspended') {
          console.log('[AudioEngine] Power Save: Resuming context for active layer');
          ctx.resume().catch(() => {});
        }
      } else {
        if (ctx.state === 'running') {
          console.log('[AudioEngine] Power Save: Suspending idle context');
          ctx.suspend().catch(() => {});
        }
      }
      
      // Playback State Nudge (iOS 16 Safety)
      if (isPlaying && mainAudioRef.current) {
        const audio = mainAudioRef.current;
        if (audio.paused && !audio.ended && audio.readyState > 2) {
          console.log('[AudioEngine] Heartbeat: Restoring interrupted playback');
          audio.play().catch(() => {});
        }
      }
    }, 10000); // 10s is enough for power saving check

    return () => clearInterval(interval);
  }, [isPlaying, needsWebAudio]);

  const createNoiseBuffer = (type: 'white' | 'pink' | 'brown') => {
    if (!audioCtxRef.current) return null;
    const ctx = audioCtxRef.current;
    const bufferSize = 2 * ctx.sampleRate;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = buffer.getChannelData(0);

    if (type === 'white') {
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }
    } else if (type === 'pink') {
      let b0, b1, b2, b3, b4, b5, b6;
      b0 = b1 = b2 = b3 = b4 = b5 = b6 = 0.0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3102503;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        output[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        output[i] *= 0.11; // (roughly) apply gain
        b6 = white * 0.115926;
      }
    } else if (type === 'brown') {
      let lastOut = 0.0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        const out = (lastOut + (0.02 * white)) / 1.02;
        lastOut = out;
        output[i] = out * 3.5; // (roughly) apply gain
      }
    }
    return buffer;
  };

  // Helper: Sync Background Layer with Gapless Looping (Double Buffering)
  const syncBgLayer = async (layerId: string, isLayerPlaying: boolean, isBg: boolean, type: string, params: any, volume: number, gainDb: number) => {
    if (isLayerPlaying && isBg) {
      if (!bgAudioRefs.current[layerId]) {
        const createEl = () => {
          const el = new Audio();
          (el as any).playsInline = true;
          (el as any).webkitPlaysInline = true;
          return el;
        };
        bgAudioRefs.current[layerId] = createEl();
        bgAudioRefs2.current[layerId] = createEl();
        activeBgRef.current[layerId] = 1;

        // Progress tracking on both
        [bgAudioRefs.current[layerId], bgAudioRefs2.current[layerId]].forEach(el => {
          el.addEventListener('timeupdate', () => {
            if (activeBgRef.current[layerId] === (el === bgAudioRefs.current[layerId] ? 1 : 2)) {
              // THROTTLE: Only update UI progress if foreground or every ~2s if background to keep it alive
              const now = Date.now();
              const lastUpdate = (el as any).lastProgressTime || 0;
              const throttleMs = document.visibilityState === 'visible' ? 250 : 2000;
              
              if (now - lastUpdate > throttleMs) {
                updateLayerProgress(layerId, {
                  currentTime: el.currentTime,
                  duration: el.duration || 30
                });
                (el as any).lastProgressTime = now;
              }
              
              // Gapless Logic: Trigger next buffer 0.5s before end (safer for iPhone 8)
              if (el.duration > 0 && el.currentTime > el.duration - 0.5) {
                 const otherIdx = activeBgRef.current[layerId] === 1 ? 2 : 1;
                 const otherEl = otherIdx === 1 ? bgAudioRefs.current[layerId] : bgAudioRefs2.current[layerId];
                 if (otherEl.paused) {
                   console.log(`[AudioEngine] Gapless Swap for ${layerId} to buffer ${otherIdx}`);
                   otherEl.currentTime = 0;
                   otherEl.play().catch(() => {});
                   activeBgRef.current[layerId] = otherIdx;
                   
                   // crossfade
                   const fadeOutEl = el;
                   const fadeInEl = otherEl;
                   let fadeStep = 0;
                   const steps = 10;
                   const fadeInterval = setInterval(() => {
                      fadeStep++;
                      const vol = 1.0;
                      fadeInEl.volume = (fadeStep / steps) * vol;
                      fadeOutEl.volume = (1 - (fadeStep / steps)) * vol;
                      if (fadeStep >= steps) {
                        clearInterval(fadeInterval);
                        fadeOutEl.pause();
                        fadeOutEl.currentTime = 0;
                      }
                   }, 30);
                 }
              }
            }
          });
          el.addEventListener('ended', () => {
            // Backup for timeupdate miss
            const otherIdx = el === bgAudioRefs.current[layerId] ? 2 : 1;
            const otherEl = otherIdx === 1 ? bgAudioRefs.current[layerId] : bgAudioRefs2.current[layerId];
            if (otherEl.paused) {
              otherEl.currentTime = 0;
              otherEl.play().catch(() => {});
              activeBgRef.current[layerId] = otherIdx;
            }
          });
        });
      }

    const activeIdx = activeBgRef.current[layerId];
    const el = activeIdx === 1 ? bgAudioRefs.current[layerId] : bgAudioRefs2.current[layerId];
    const otherEl = activeIdx === 1 ? bgAudioRefs2.current[layerId] : bgAudioRefs.current[layerId];

    // Master Gain Multiplier for baking
    const masterGainDb = settings.audioTools.gainDb;
    const masterGainMultiplier = masterGainDb !== 0 ? Math.pow(10, masterGainDb / 20) : 1.0;

    // Trigger regeneration if Hz, Volume, or Gain changes
    const extendedParams = { 
      ...params, 
      volume, 
      gainDb, 
      masterGainDb 
    };
    const paramKey = JSON.stringify(extendedParams);
    
    if (bgAudioParams.current[layerId] !== paramKey) {
      // Debounce generation for slider smoothness on iPhone 8
      const now = Date.now();
      const lastGen = lastBgGenTime.current[layerId] || 0;
      if (now - lastGen < 350) return; // Wait for user to stop sliding
      
      lastBgGenTime.current[layerId] = now;
      
      if (bgAudioUrls.current[layerId]) URL.revokeObjectURL(bgAudioUrls.current[layerId]);
      
      const blob = await generateToneBlob(type, extendedParams);
      const url = URL.createObjectURL(blob);
      bgAudioUrls.current[layerId] = url;
      bgAudioParams.current[layerId] = paramKey;
      
      [bgAudioRefs.current[layerId], bgAudioRefs2.current[layerId]].forEach(a => {
        a.src = url;
        a.load();
      });
    }

    // Since gain is BAKED into the file, we keep the HTML element at 1.0 volume
    // This bypasses the unreliable iOS 16 <audio> volume property in background
    el.volume = 1.0;
    if (el.paused && otherEl.paused) {
      el.play().catch(() => {});
    }
    } else {
      const el1 = bgAudioRefs.current[layerId];
      const el2 = bgAudioRefs2.current[layerId];
      if (el1) el1.pause();
      if (el2) el2.pause();
      
      if (!isLayerPlaying) {
        if (el1) { el1.src = ''; el1.load(); }
        if (el2) { el2.src = ''; el2.load(); }
        if (bgAudioUrls.current[layerId]) {
          URL.revokeObjectURL(bgAudioUrls.current[layerId]);
          delete bgAudioUrls.current[layerId];
        }
        delete bgAudioParams.current[layerId];
        updateLayerProgress(layerId, { currentTime: 0, duration: 0 });
      }
    }
  };

  const setupNoise = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContextClass();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      
      setupAudioTools(); // Ensure master routing is ready

      if (!noiseGainRef.current) {
        const gain = ctx.createGain();
        const comp = ctx.createDynamicsCompressor();
        
        comp.threshold.setValueAtTime(-24, ctx.currentTime);
        comp.ratio.setValueAtTime(12, ctx.currentTime);
        
        gain.gain.setValueAtTime(0, ctx.currentTime);
        comp.connect(gain);
        
        // Connect to Master Gain instead of direct destination
        if (masterGainRef.current) {
          gain.connect(masterGainRef.current);
        } else {
          gain.connect(ctx.destination);
        }
        
        noiseGainRef.current = gain;
        noiseCompRef.current = comp;
      }
    } catch (err) {
      console.error("Failed to setup noise context:", err);
    }
  };

  const setupBinaural = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContextClass();
      }
      const ctx = audioCtxRef.current;

      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      setupAudioTools(); // Ensure master routing is ready

      if (!leftOscRef.current || !rightOscRef.current) {
        // Create Nodes
        const leftOsc = ctx.createOscillator();
        const rightOsc = ctx.createOscillator();
        const merger = ctx.createChannelMerger(2);
        const gainNode = ctx.createGain();
        const comp = ctx.createDynamicsCompressor();

        comp.threshold.setValueAtTime(-24, ctx.currentTime);
        comp.ratio.setValueAtTime(12, ctx.currentTime);

        leftOsc.type = 'sine';
        rightOsc.type = 'sine';

        // Initial frequencies
        leftOsc.frequency.setValueAtTime(settings.binaural.leftFreq, ctx.currentTime);
        rightOsc.frequency.setValueAtTime(settings.binaural.rightFreq, ctx.currentTime);

        // Route: Left -> Channel 0, Right -> Channel 1 (Explicit Stereo)
        leftOsc.connect(merger, 0, 0);
        rightOsc.connect(merger, 0, 1);

        merger.connect(comp);
        comp.connect(gainNode);
        
        // Connect to Master Gain instead of direct destination
        if (masterGainRef.current) {
          gainNode.connect(masterGainRef.current);
        } else {
          gainNode.connect(ctx.destination);
        }

        gainNode.gain.setValueAtTime(0, ctx.currentTime);
        leftOsc.start();
        rightOsc.start();

        leftOscRef.current = leftOsc;
        rightOscRef.current = rightOsc;
        binauralGainRef.current = gainNode;
        binCompRef.current = comp;
      }
    } catch (err) {
      console.error("Binaural setup failed:", err);
    }
  };

  const setupDidgeridoo = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContextClass();
      }
      const ctx = audioCtxRef.current;

      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      setupAudioTools();

      if (!didgOscRef.current) {
        const osc = ctx.createOscillator();
        const subOsc = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        const gain = ctx.createGain();
        const comp = ctx.createDynamicsCompressor();

        comp.threshold.setValueAtTime(-24, ctx.currentTime);
        comp.ratio.setValueAtTime(12, ctx.currentTime);

        // Deep drone fundamental
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(settings.didgeridoo.frequency, ctx.currentTime);

        subOsc.type = 'sine';
        subOsc.frequency.setValueAtTime(settings.didgeridoo.frequency, ctx.currentTime);

        // Vocalizing filter
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(180 * (1 + settings.didgeridoo.depth), ctx.currentTime);
        filter.Q.setValueAtTime(15, ctx.currentTime);

        // Slow modulation for "breath"
        lfo.type = 'sine';
        lfo.frequency.setValueAtTime(0.15, ctx.currentTime);
        lfoGain.gain.setValueAtTime(60 * settings.didgeridoo.depth, ctx.currentTime);

        lfo.connect(lfoGain);
        lfoGain.connect(filter.frequency);

        osc.connect(filter);
        subOsc.connect(filter);
        filter.connect(comp);
        comp.connect(gain);
        
        // Connect to Master Gain
        if (masterGainRef.current) {
          gain.connect(masterGainRef.current);
        } else {
          gain.connect(ctx.destination);
        }

        gain.gain.setValueAtTime(0, ctx.currentTime);

        osc.start();
        subOsc.start();
        lfo.start();

        didgOscRef.current = osc;
        didgSubOscRef.current = subOsc;
        didgFilterRef.current = filter;
        didgGainRef.current = gain;
        didgLfoRef.current = lfo;
      }
    } catch (err) {
      console.error("Didgeridoo setup failed:", err);
    }
  };

  const setupPureHz = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContextClass();
      }
      const ctx = audioCtxRef.current;

      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      setupAudioTools();

      if (!pureHzOscRef.current) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const comp = ctx.createDynamicsCompressor();

        comp.threshold.setValueAtTime(-24, ctx.currentTime);
        comp.ratio.setValueAtTime(12, ctx.currentTime);

        osc.type = 'sine'; // Always sine for pure tones
        osc.frequency.setValueAtTime(settings.pureHz.frequency, ctx.currentTime);

        osc.connect(comp);
        comp.connect(gain);
        
        // Connect to Master Gain
        if (masterGainRef.current) {
          gain.connect(masterGainRef.current);
        } else {
          gain.connect(ctx.destination);
        }

        gain.gain.setValueAtTime(0, ctx.currentTime);
        osc.start();

        pureHzOscRef.current = osc;
        pureHzGainRef.current = gain;
        pureHzCompRef.current = comp;
      }
    } catch (err) {
      console.error("Pure Hz setup failed:", err);
    }
  };

  const setupIsochronic = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContextClass();
      }
      const ctx = audioCtxRef.current;

      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      setupAudioTools();

      if (!isoOscRef.current) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        const comp = ctx.createDynamicsCompressor();

        comp.threshold.setValueAtTime(-24, ctx.currentTime);
        comp.ratio.setValueAtTime(12, ctx.currentTime);

        osc.type = 'sine';
        osc.frequency.setValueAtTime(settings.isochronic.frequency, ctx.currentTime);

        // Isochronic pulse (square wave LFO on gain)
        lfo.type = 'square';
        lfo.frequency.setValueAtTime(settings.isochronic.pulseRate, ctx.currentTime);
        
        // Connect LFO to Gain.gain via an offset
        // In Web Audio, LFO on gain usually goes 0 to 1
        lfoGain.gain.setValueAtTime(0.5, ctx.currentTime);
        const constantSource = ctx.createConstantSource();
        constantSource.offset.setValueAtTime(0.5, ctx.currentTime);
        constantSource.start();
        
        lfo.connect(lfoGain);
        lfoGain.connect(gain.gain);
        constantSource.connect(gain.gain);

        osc.connect(comp);
        comp.connect(gain);
        
        // Connect to Master Gain
        if (masterGainRef.current) {
          gain.connect(masterGainRef.current);
        } else {
          gain.connect(ctx.destination);
        }

        osc.start();
        lfo.start();

        isoOscRef.current = osc;
        isoGainRef.current = gain;
        isoLfoRef.current = lfo;
        isoLfoGainRef.current = lfoGain;
        isoCompRef.current = comp;
      }
    } catch (err) {
      console.error("Isochronic setup failed:", err);
    }
  };

  const setupSolfeggio = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContextClass();
      }
      const ctx = audioCtxRef.current;

      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      setupAudioTools();

      if (!solOscRef.current) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const comp = ctx.createDynamicsCompressor();

        comp.threshold.setValueAtTime(-24, ctx.currentTime);
        comp.ratio.setValueAtTime(12, ctx.currentTime);

        osc.type = 'sine';
        osc.frequency.setValueAtTime(settings.solfeggio.frequency, ctx.currentTime);

        osc.connect(comp);
        comp.connect(gain);
        
        // Connect to Master Gain
        if (masterGainRef.current) {
          gain.connect(masterGainRef.current);
        } else {
          gain.connect(ctx.destination);
        }

        gain.gain.setValueAtTime(0, ctx.currentTime);
        osc.start();

        solOscRef.current = osc;
        solGainRef.current = gain;
        solCompRef.current = comp;
      }
    } catch (err) {
      console.error("Solfeggio setup failed:", err);
    }
  };

  const setupNature = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContextClass();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      setupAudioTools(); // Ensure master routing is ready

      if (natureAudioRef.current && !natureSourceRef.current) {
        natureSourceRef.current = ctx.createMediaElementSource(natureAudioRef.current);
        natureGainRef.current = ctx.createGain();
        natureCompRef.current = ctx.createDynamicsCompressor();
        
        natureCompRef.current.threshold.setValueAtTime(-24, ctx.currentTime);
        natureCompRef.current.ratio.setValueAtTime(12, ctx.currentTime);
        
        natureSourceRef.current.connect(natureCompRef.current);
        natureCompRef.current.connect(natureGainRef.current);
        
        // Connect to Master Gain
        if (masterGainRef.current) {
          natureGainRef.current.connect(masterGainRef.current);
        } else {
          natureGainRef.current.connect(ctx.destination);
        }
      }
    } catch (err) {
      console.error("Nature setup failed:", err);
    }
  };

  // Handle Seek Request
  useEffect(() => {
    if (seekRequest !== null && mainAudioRef.current) {
      mainAudioRef.current.currentTime = seekRequest;
      clearSeekRequest();
    }
  }, [seekRequest]);

  const currentTrack = currentTrackIndex !== null ? currentPlaybackList[currentTrackIndex] : null;

  // Resolve Main URL
  useEffect(() => {
    if (currentTrack && !currentTrack.isMissing) {
      getTrackUrl(currentTrack.id).then(url => {
        setPreparedUrl(url);
      });
    } else {
      setPreparedUrl(null);
    }
  }, [currentTrack?.id, getTrackUrl]);

  // Unified sourcing: Check both lists for the subliminal track
  const subTrack = useMemo(() => {
    // If playlist mode is on, we derive track from the selected playlist and our internal index
    if (settings.subliminal.isPlaylistMode && settings.subliminal.sourcePlaylistId) {
      const playlist = playlists.find(p => p.id === settings.subliminal.sourcePlaylistId);
      if (playlist && playlist.trackIds.length > 0) {
        // Ensure index is within bounds
        const trackId = playlist.trackIds[subPlaylistIndexRef.current % playlist.trackIds.length];
        return (tracks.find(t => t.id === trackId) || subliminalTracks.find(t => t.id === trackId));
      }
    }
    
    return subliminalTracks.find(t => t.id === settings.subliminal.selectedTrackId) || 
           tracks.find(t => t.id === settings.subliminal.selectedTrackId);
  }, [subliminalTracks, tracks, settings.subliminal.selectedTrackId, settings.subliminal.isPlaylistMode, settings.subliminal.sourcePlaylistId, playlists]);

  // Resolve Sub URL
  useEffect(() => {
    if (subTrack && !subTrack.isMissing) {
      getTrackUrl(subTrack.id).then(url => {
        setPreparedSubUrl(url);
      });
    } else {
      setPreparedSubUrl(null);
    }
  }, [subTrack?.id, getTrackUrl]);

  // Reset Subliminal Index on mode/playlist change
  useEffect(() => {
    subPlaylistIndexRef.current = 0;
  }, [settings.subliminal.sourcePlaylistId, settings.subliminal.isPlaylistMode]);

  // Initialize main audio element
  useEffect(() => {
    const audio = new Audio();
    (audio as any).playsInline = true;
    (audio as any).webkitPlaysInline = true;
    mainAudioRef.current = audio;

    return () => {
      audio.pause();
      audio.src = '';
      mainAudioRef.current = null;
    };
  }, []);

  // Sync state and duration from main audio
  useEffect(() => {
    const audio = mainAudioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      
      // Update Media Session position state for lock screen parity
      if ('mediaSession' in navigator && (navigator.mediaSession as any).setPositionState && isPlaying) {
        try {
          (navigator.mediaSession as any).setPositionState({
            duration: audio.duration || 0,
            playbackRate: audio.playbackRate || 1,
            position: audio.currentTime || 0,
          });
        } catch (e) {
          // Ignore state sync errors if duration is NaN
        }
      }
    };
    const onLoadedMetadata = () => setDuration(audio.duration);
    
    // Bidirectional sync: If iOS pauses the audio element (e.g. system interrupt), sync state
    const onPause = () => {
      if (isPlaying) {
        console.log('[AudioEngine] System paused audio, syncing state');
        setIsPlaying(false);
      }
    };
    const onPlay = () => {
      if (!isPlaying) {
        console.log('[AudioEngine] System resumed audio, syncing state');
        setIsPlaying(true);
      }
    };
    
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('play', onPlay);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('play', onPlay);
    };
  }, [setCurrentTime, setDuration, isPlaying, setIsPlaying]);

  // Handle track ending and errors
  useEffect(() => {
    const audio = mainAudioRef.current;
    if (!audio) return;

    const onEnded = () => {
      console.log("AudioEngine: Track ended, advancing...");
      tracksPlayedInSessionRef.current += 1;
      
      // Periodic reset after long sessions (every 10 tracks)
      if (tracksPlayedInSessionRef.current % 10 === 0) {
        console.log("[AudioEngine] Long session detected, resetting audio elements for stability");
        if (mainAudioRef.current) {
          mainAudioRef.current.src = "";
          mainAudioRef.current.load();
        }
      }

      if (settings.loop === 'one') {
        if (mainAudioRef.current) {
          mainAudioRef.current.currentTime = 0;
          mainAudioRef.current.play().catch(err => {
            console.warn("Loop one play failed:", err);
            setIsPlaying(false);
          });
        }
      } else {
        playNext(true);
      }
    };

    const onSubEnded = () => {
      if (settings.subliminal.isPlaylistMode && settings.subliminal.sourcePlaylistId) {
        const playlist = playlists.find(p => p.id === settings.subliminal.sourcePlaylistId);
        if (playlist && playlist.trackIds.length > 0) {
          let found = false;
          let attempts = 0;
          while (!found && attempts < playlist.trackIds.length) {
            subPlaylistIndexRef.current = (subPlaylistIndexRef.current + 1) % playlist.trackIds.length;
            const nextTrackId = playlist.trackIds[subPlaylistIndexRef.current];
            const nextTrack = tracks.find(t => t.id === nextTrackId);
            if (nextTrack && !nextTrack.isMissing && subAudioRef.current) {
              if (isPlaying) {
                // Pre-validate Sub track before assigning src
                getTrackUrl(nextTrack.id).then(url => {
                  if (url && subAudioRef.current) {
                    subAudioRef.current.src = url;
                    subAudioRef.current.load();
                    subAudioRef.current.play().catch(console.error);
                  }
                });
              }
              found = true;
            }
            attempts++;
          }
        }
      }
    };

    let errorCount = 0;
    let isRecovering = false;

    const onError = async (e: any) => {
      const error = mainAudioRef.current?.error;
      console.warn("[AudioEngine] Playback error encountered:", error?.code, error?.message);
      
      if (!isPlaying || isRecovering) return;

      const now = Date.now();
      // Check for rapid skipping within 2 seconds
      if (now - lastSkipTimeRef.current < 2000) {
        skipCountRef.current += 1;
      } else {
        skipCountRef.current = 0;
      }
      lastSkipTimeRef.current = now;

      // Protection against infinite skip loops
      if (skipCountRef.current > 5) {
        console.error("[AudioEngine] Extreme skip-loop detected.");
        // setIsPlaying(false); // DO NOT stop playback, just log and allow recovery
        // showToast("System stabilized. Please tap play again.");
        skipCountRef.current = 0;
        return;
      }

      // iOS 16 Recovery Logic:
      // If code is 4 (SRC_NOT_SUPPORTED) or 3 (DECODE), it effectively means the Blob URL was likely revoked
      if (error?.code === 4 || error?.code === 3) {
        if (currentTrack && errorCount < 2) {
          console.log("[AudioEngine] Attempting URL recovery for track:", currentTrack.id);
          isRecovering = true;
          errorCount++;
          
          try {
            // Check if file still exists in DB
            const exists = await checkTrackPlayable(currentTrack.id);
            if (!exists) {
              console.error("[AudioEngine] Track file literally missing from database.");
              showToast("Error: Track file lost. Please re-import.");
              playNext(true);
              isRecovering = false;
              return;
            }

            const freshUrl = await getTrackUrl(currentTrack.id, true);
            if (freshUrl && mainAudioRef.current) {
              console.log("[AudioEngine] Fresh URL obtained, re-injecting source");
              mainAudioRef.current.pause();
              mainAudioRef.current.src = "";
              mainAudioRef.current.load();
              
              setTimeout(async () => {
                if (mainAudioRef.current) {
                  mainAudioRef.current.src = freshUrl;
                  mainAudioRef.current.load();
                  await mainAudioRef.current.play();
                }
                isRecovering = false;
                errorCount = 0; 
              }, 100);
              return;
            }
          } catch (recoveryErr) {
            console.error("[AudioEngine] Recovery failed:", recoveryErr);
          }
          isRecovering = false;
        }
      }

      // If recovery failed or it's another error, do the standard skip
      errorCount++;
      if (errorCount > 2) {
        console.error("[AudioEngine] Multiple playback failures. Initiating system healing.");
        errorCount = 0;
        await healSystem();
        playNext(true);
      } else {
        setTimeout(() => {
          if (isPlaying && mainAudioRef.current) {
            mainAudioRef.current.play().catch(() => {});
          }
        }, 1000);
      }
    };

    const handleStalled = () => {
      console.warn("Main Engine: Playback stalled.");
      if (isPlaying) {
        setTimeout(() => {
          if (isPlaying && mainAudioRef.current && mainAudioRef.current.paused) {
             mainAudioRef.current.play().catch(() => {});
          }
        }, 1500);
      }
    };

    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    audio.addEventListener('stalled', handleStalled);

    if (subAudioRef.current) {
      subAudioRef.current.addEventListener('ended', onSubEnded);
    }

    return () => {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('stalled', handleStalled);
      if (subAudioRef.current) {
        subAudioRef.current.removeEventListener('ended', onSubEnded);
      }
    };
  }, [playNext, isPlaying, playlists, tracks, settings.subliminal.isPlaylistMode, settings.subliminal.sourcePlaylistId]);

  // Handle Subliminal Source Sync
  useEffect(() => {
    if (subAudioRef.current && subTrack && preparedSubUrl) {
      if (subAudioRef.current.src !== preparedSubUrl) {
        subAudioRef.current.src = preparedSubUrl;
        subAudioRef.current.load();
      }
    }
  }, [subTrack, preparedSubUrl]);

  const setupAudioTools = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContextClass();
      }
      const ctx = audioCtxRef.current;

      // 1. Setup Master Routing (The Final Gate)
      if (!masterGainRef.current) {
        masterGainRef.current = ctx.createGain();
        masterLimiterRef.current = ctx.createDynamicsCompressor();
        
        // Safety Limiter to prevent clipping across all layers
        const limiter = masterLimiterRef.current;
        limiter.threshold.setValueAtTime(-1.0, ctx.currentTime);
        limiter.knee.setValueAtTime(0, ctx.currentTime);
        limiter.ratio.setValueAtTime(20, ctx.currentTime);
        limiter.attack.setValueAtTime(0.001, ctx.currentTime);
        limiter.release.setValueAtTime(0.1, ctx.currentTime);
        
        masterGainRef.current.connect(limiter);
        limiter.connect(ctx.destination);
        
        // Default master gain is 1.0 (individual layers have their own gains)
        masterGainRef.current.gain.setValueAtTime(1.0, ctx.currentTime);
      }
      
      // 2. Setup Tool Routing (Playlist & Subliminal)
      if (!toolGainRef.current) {
        toolGainRef.current = ctx.createGain();
        toolCompressorRef.current = ctx.createDynamicsCompressor();
        
        const comp = toolCompressorRef.current;
        comp.threshold.setValueAtTime(settings.audioTools.normalizeTargetDb !== null ? settings.audioTools.normalizeTargetDb : 0, ctx.currentTime);
        comp.knee.setValueAtTime(0, ctx.currentTime);
        comp.ratio.setValueAtTime(20, ctx.currentTime);
        comp.attack.setValueAtTime(0.003, ctx.currentTime);
        comp.release.setValueAtTime(0.25, ctx.currentTime);
        
        toolGainRef.current.connect(comp);
        // Connect tool chain to master gain
        comp.connect(masterGainRef.current);
      }
      
      if (mainAudioRef.current && !mainSourceRef.current && !settings.audioTools.playInBackground) {
        mainSourceRef.current = ctx.createMediaElementSource(mainAudioRef.current);
        if (!mainGainRef.current) {
          mainGainRef.current = ctx.createGain();
        }
        mainSourceRef.current.connect(mainGainRef.current);
        mainGainRef.current.connect(toolGainRef.current);
      }
      
      if (subAudioRef.current && !subSourceRef.current && !settings.subliminal.playInBackground) {
        subSourceRef.current = ctx.createMediaElementSource(subAudioRef.current);
        
        if (!subSpecificGainRef.current) {
          subSpecificGainRef.current = ctx.createGain();
        }
        if (!subCompRef.current) {
          subCompRef.current = ctx.createDynamicsCompressor();
          subCompRef.current.threshold.setValueAtTime(-24, ctx.currentTime);
          subCompRef.current.ratio.setValueAtTime(12, ctx.currentTime);
        }
        
        subSourceRef.current.connect(subCompRef.current);
        subCompRef.current.connect(subSpecificGainRef.current);
        subSpecificGainRef.current.connect(toolGainRef.current);
      }
    } catch (err) {
      console.error("Audio tools setup failed:", err);
    }
  };

  // Handle Audio Tools Real-time Updates - Throttled for stability on iPhone 8
  const lastAppliedGainRef = useRef<number>(-999);
  const gainThrottleTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (audioCtxRef.current) {
      const ctx = audioCtxRef.current;
      
      const updateNodes = () => {
        // Update Master Gain - Applying to ALL layers via masterGainRef
        if (masterGainRef.current) {
          const gainDb = Math.max(-60, Math.min(0, settings.audioTools.gainDb));
          const gainValue = Math.pow(10, gainDb / 20);
          masterGainRef.current.gain.setTargetAtTime(gainValue, ctx.currentTime, 0.05);
          lastAppliedGainRef.current = settings.audioTools.gainDb;
        }
        
        // Update Main Volume
        if (mainGainRef.current && !settings.audioTools.playInBackground) {
          mainGainRef.current.gain.setTargetAtTime(settings.mainVolume, ctx.currentTime, 0.05);
        }

        // Update Subliminal Specific Gain & Normalize
        if (subSpecificGainRef.current) {
          const subGainValue = Math.pow(10, settings.subliminal.gainDb / 20);
          subSpecificGainRef.current.gain.setTargetAtTime(subGainValue, ctx.currentTime, 0.05);
        }
        if (subCompRef.current) {
          const threshold = settings.subliminal.normalize ? -24 : 0;
          subCompRef.current.threshold.setTargetAtTime(threshold, ctx.currentTime, 0.1);
        }
        
        // Update Normalization Compressor (Master)
        if (toolCompressorRef.current) {
          const targetDb = settings.audioTools.normalizeTargetDb !== null ? settings.audioTools.normalizeTargetDb : 0;
          toolCompressorRef.current.threshold.setTargetAtTime(targetDb, ctx.currentTime, 0.1);
        }
      };

      if (gainThrottleTimeoutRef.current) {
        clearTimeout(gainThrottleTimeoutRef.current);
      }

      // If it's a big jump or first time, update immediately
      if (Math.abs(lastAppliedGainRef.current - settings.audioTools.gainDb) > 2) {
        updateNodes();
      } else {
        // Otherwise throttle for smoothness and to prevent layout/engine thrashing
        gainThrottleTimeoutRef.current = window.setTimeout(updateNodes, 50);
      }
    }
    return () => {
      if (gainThrottleTimeoutRef.current) clearTimeout(gainThrottleTimeoutRef.current);
    };
  }, [settings.audioTools.gainDb, settings.audioTools.normalizeTargetDb, settings.subliminal.gainDb, settings.subliminal.normalize, settings.mainVolume, settings.audioTools.playInBackground]);

  // Handle Background Toggles (Main/Sub) - Flush to un-hijack from Web Audio if needed
  useEffect(() => {
    if (mainAudioRef.current && mainSourceRef.current) {
      const curTime = mainAudioRef.current.currentTime;
      const wasPlaying = isPlaying;
      
      // We must neutralize the source ref and refresh the element to detach from Web Audio
      mainSourceRef.current.disconnect();
      mainSourceRef.current = null;
      mainGainRef.current = null;
      
      mainAudioRef.current.pause();
      mainAudioRef.current.src = "";
      mainAudioRef.current.load();
      
      setTimeout(() => {
        if (mainAudioRef.current && preparedUrl) {
          mainAudioRef.current.src = preparedUrl;
          mainAudioRef.current.currentTime = curTime;
          if (wasPlaying) mainAudioRef.current.play().catch(() => {});
        }
      }, 100);
    }
  }, [settings.audioTools.playInBackground]);

  useEffect(() => {
    if (subAudioRef.current && subSourceRef.current) {
      subSourceRef.current.disconnect();
      subSourceRef.current = null;
      subSpecificGainRef.current = null;
      
      subAudioRef.current.pause();
      subAudioRef.current.src = "";
      subAudioRef.current.load();
      
      setTimeout(() => {
        if (subAudioRef.current && preparedSubUrl) {
          subAudioRef.current.src = preparedSubUrl;
          if (isPlaying) subAudioRef.current.play().catch(() => {});
        }
      }, 100);
    }
  }, [settings.subliminal.playInBackground]);

  // Main Audio Playback Loop - Chunk or Direct Path
  useEffect(() => {
    if (!mainAudioRef.current) return;
    const audio = mainAudioRef.current;

    const handleTimeUpdate = async () => {
      // Chunk Transition Logic (Only if Merge Mode)
      if (settings.chunking.mode === 'merge' && audio.duration > 0 && audio.currentTime > audio.duration - 0.5) {
        // Prepare next chunk transition
        const { activePlaylistId, currentChunkIndex } = settings.chunking;
        const plan = chunkPlanRef.current;
        if (!plan || activePlaylistId !== plan.playlistId) return;

        const nextIdx = (currentChunkIndex + 1) >= plan.chunks.length ? (settings.playbackMode === 'loop' ? 0 : -1) : currentChunkIndex + 1;
        
        if (nextIdx === -1) {
          setIsPlaying(false);
          return;
        }

        const nextId = `chunk_${activePlaylistId}_${nextIdx}`;
        const nextBlob = await db.getTrackBlob(nextId);
        
        if (nextBlob) {
          console.log(`[AudioEngine] Transitioning to next chunk: ${nextId}`);
          const oldChunkId = `chunk_${activePlaylistId}_${currentChunkIndex}`;
          
          cleanupLastUrl();
          const url = URL.createObjectURL(nextBlob);
          lastMainUrlRef.current = url;
          audio.src = url;
          audio.load();
          audio.play().catch(console.error);

          // Calculate new track index
          let newTrackIdx = 0;
          for (let i = 0; i < nextIdx; i++) {
            newTrackIdx += plan.chunks[i].trackIds.length;
          }
          setCurrentTrackIndex(newTrackIdx);

          updateSettings({
            chunking: {
              ...settings.chunking,
              currentChunkIndex: nextIdx,
              lastChunkPosition: 0,
              currentTrackIndex: newTrackIdx
            }
          });

          await db.deleteChunk(oldChunkId);
        }
      }

      setCurrentTime(audio.currentTime);
      setDuration(audio.duration);

      // Sync currentTrackIndex within chunk (if Merge Mode)
      if (settings.chunking.mode === 'merge') {
        const plan = chunkPlanRef.current;
        if (plan && settings.chunking.activePlaylistId === plan.playlistId) {
          if (Math.floor(audio.currentTime) !== Math.floor(currentTime)) {
            const chunk = plan.chunks[settings.chunking.currentChunkIndex];
            let offset = 0;
            let foundIdxInChunk = 0;
            for (let i = 0; i < chunk.trackIds.length; i++) {
              const d = await ChunkManager.getAudioDuration(chunk.trackIds[i]);
              if (audio.currentTime >= offset && audio.currentTime < offset + d) {
                foundIdxInChunk = i;
                break;
              }
              offset += d;
              if (i === chunk.trackIds.length - 1) foundIdxInChunk = i;
            }
            
            let absoluteIdx = 0;
            for (let i = 0; i < settings.chunking.currentChunkIndex; i++) {
              absoluteIdx += plan.chunks[i].trackIds.length;
            }
            absoluteIdx += foundIdxInChunk;
            
            if (absoluteIdx !== currentTrackIndex) {
              setCurrentTrackIndex(absoluteIdx);
            }
          }
        }
      }
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    
    // Auto Play Next in Heartbeat Mode
    const handleEnded = () => {
      if (settings.chunking.mode === 'heartbeat') {
        playNext(true);
      }
    };
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [isPlaying, settings.chunking, settings.playbackMode, settings.loop, playNext]);

  // Handle Main Track Source Change (Mode Aware)
  useEffect(() => {
    if (!mainAudioRef.current) return;
    const audio = mainAudioRef.current;
    
    const applySources = async () => {
      if (settings.chunking.mode === 'merge') {
        const { activePlaylistId, currentChunkIndex, lastChunkPosition } = settings.chunking;
        if (!activePlaylistId) {
          audio.pause();
          audio.src = "";
          return;
        }

        const chunkId = `chunk_${activePlaylistId}_${currentChunkIndex}`;
        if (activeChunkIdRef.current === chunkId) return;

        const blob = await db.getTrackBlob(chunkId);
        if (blob) {
          cleanupLastUrl();
          const url = URL.createObjectURL(blob);
          lastMainUrlRef.current = url;
          audio.src = url;
          audio.currentTime = lastChunkPosition;
          audio.load();
          if (isPlaying) audio.play().catch(console.error);
          activeChunkIdRef.current = chunkId;
        }
      } else {
        // Heartbeat / Standard Mode: Use track URLs directly
        if (preparedUrl) {
          if (audio.src !== preparedUrl) {
            console.log(`[AudioEngine] Setting direct source: ${preparedUrl}`);
            audio.src = preparedUrl;
            audio.load();
            if (isPlaying) audio.play().catch(console.error);
            activeChunkIdRef.current = null; // Clear chunk tracking
          }
        } else {
          // No track prepared, but we might be in middle of something
          if (!isPlaying && !currentTrack) {
            audio.pause();
            audio.src = "";
          }
        }
      }
    };
    
    applySources();
  }, [settings.chunking.activePlaylistId, settings.chunking.currentChunkIndex, settings.chunking.mode, isPlaying, preparedUrl]);

  // Handle Main Play/Pause and MediaSession State
  useEffect(() => {
    if (!mainAudioRef.current) return;

    const resumeContext = () => {
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }
    };

    if (isPlaying) {
      if (currentTrack?.isMissing) {
        setIsPlaying(false);
        showToast("Track file missing. Please relink.");
        return;
      }
      
      resumeContext();
      setupAudioTools();
      
      if (mainAudioRef.current && currentTrack && mainAudioRef.current.paused) {
        resumeContext();
        mainAudioRef.current.play().catch(e => {
          console.error("Playback error:", e);
          if (e.name === 'NotAllowedError') {
            showToast("Tap screen to enable audio");
          }
          setIsPlaying(false);
        });
      }
      
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
      }
    } else {
      if (mainAudioRef.current) mainAudioRef.current.pause();
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
    }
  }, [isPlaying, currentTrack, settings.audioTools.playInBackground]);

  // Handle Subliminal Playback State (Independent from Main if Background is ON)
  useEffect(() => {
    if (!subAudioRef.current) return;
    
    const isLayerPlaying = (isPlaying || settings.subliminal.playInBackground) && settings.subliminal.isEnabled;
    const audio = subAudioRef.current;

    if (isLayerPlaying && subTrack && preparedSubUrl && !subTrack.isMissing) {
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }

      const playSub = () => {
        if (audio.src !== preparedSubUrl) {
          audio.src = preparedSubUrl;
          audio.load();
        }
        audio.loop = settings.subliminal.isPlaylistMode ? false : settings.subliminal.isLooping;
        
        // Background support for Subliminal
        if (settings.subliminal.playInBackground) {
          if (subSourceRef.current) {
             try { subSourceRef.current.disconnect(); } catch (e) {}
          }
          const gainValue = settings.subliminal.volume * Math.pow(10, settings.subliminal.gainDb / 20);
          audio.volume = Math.min(1, Math.max(0, gainValue));
        } else {
          setupAudioTools();
          if (subSourceRef.current && subCompRef.current) {
            subSourceRef.current.connect(subCompRef.current);
          }
          audio.volume = 1.0;
        }

        if (audio.paused) {
          audio.play().catch(console.error);
        }
      };

      if (isPlaying) {
        delayTimeoutRef.current = window.setTimeout(playSub, settings.subliminal.delayMs);
      } else {
        playSub();
      }
    } else {
      audio.pause();
      if (delayTimeoutRef.current) clearTimeout(delayTimeoutRef.current);
    }
    
    return () => {
        if (delayTimeoutRef.current) clearTimeout(delayTimeoutRef.current);
    };
  }, [isPlaying, settings.subliminal.isEnabled, settings.subliminal.playInBackground, settings.subliminal.isLooping, settings.subliminal.isPlaylistMode, subTrack, preparedSubUrl]);

  // Handle Binaural Playback and Fading
  useEffect(() => {
    const isBg = settings.binaural.playInBackground;
    const isLayerPlaying = settings.binaural.isEnabled && (isPlaying || isBg);

    // 1. Manage Web Audio State
    if (isLayerPlaying && !isBg) {
      setupBinaural();
      if (binauralGainRef.current && audioCtxRef.current) {
        const ctx = audioCtxRef.current;
        const fadeTime = settings.fadeInOut ? 3 : 0.1;
        const gainValue = settings.binaural.volume * Math.pow(10, settings.binaural.gainDb / 20);
        const threshold = settings.binaural.normalize ? -24 : 0;
        
        if (binCompRef.current) binCompRef.current.threshold.setTargetAtTime(threshold, ctx.currentTime, 0.1);
        binauralGainRef.current.gain.setTargetAtTime(gainValue, ctx.currentTime, fadeTime / 2);
      }
    } else {
      if (binauralGainRef.current && audioCtxRef.current) {
        const ctx = audioCtxRef.current;
        const fadeTime = settings.fadeInOut ? 3 : 0.1;
        binauralGainRef.current.gain.setTargetAtTime(0, ctx.currentTime, fadeTime / 2);
      }
    }

    // 2. Manage HTML Background Audio State (Binaural)
    const syncBinauralBg = async () => {
      const isBg = settings.binaural.playInBackground;
      const isLayerPlaying = settings.binaural.isEnabled && (isPlaying || isBg);
      
      const params = { 
        leftFreq: settings.binaural.leftFreq, 
        rightFreq: settings.binaural.rightFreq 
      };

      await syncBgLayer(
        'binaural', 
        isLayerPlaying, 
        isBg, 
        'binaural', 
        params, 
        settings.binaural.volume, 
        settings.binaural.gainDb
      );
    };
    syncBinauralBg();
  }, [isPlaying, settings.binaural.isEnabled, settings.binaural.playInBackground, settings.fadeInOut, settings.binaural.leftFreq, settings.binaural.rightFreq, settings.binaural.volume, settings.binaural.gainDb, settings.binaural.normalize, settings.audioTools.gainDb]);

  // Handle Binaural Frequency/Volume Updates
  useEffect(() => {
    if (leftOscRef.current && rightOscRef.current && audioCtxRef.current && !settings.binaural.playInBackground) {
      const ctx = audioCtxRef.current;
      // Safety: Difference <= 30Hz
      const diff = Math.abs(settings.binaural.leftFreq - settings.binaural.rightFreq);
      let lFreq = settings.binaural.leftFreq;
      let rFreq = settings.binaural.rightFreq;
      
      if (diff > 30) {
        rFreq = lFreq + 30; // Force limit
      }

      leftOscRef.current.frequency.setTargetAtTime(lFreq, ctx.currentTime, 0.1);
      rightOscRef.current.frequency.setTargetAtTime(rFreq, ctx.currentTime, 0.1);
    }
    
    if (binauralGainRef.current && audioCtxRef.current && isPlaying && settings.binaural.isEnabled) {
      const ctx = audioCtxRef.current;
      const gainValue = settings.binaural.volume * Math.pow(10, settings.binaural.gainDb / 20);
      const threshold = settings.binaural.normalize ? -24 : 0;
      
      if (binCompRef.current) binCompRef.current.threshold.setTargetAtTime(threshold, ctx.currentTime, 0.1);
      binauralGainRef.current.gain.setTargetAtTime(gainValue, ctx.currentTime, 0.1);
    }
  }, [settings.binaural.leftFreq, settings.binaural.rightFreq, settings.binaural.volume, settings.binaural.gainDb, settings.binaural.normalize]);

  // Handle Noise Layer
  useEffect(() => {
    const isBg = settings.noise.playInBackground;
    const isLayerPlaying = settings.noise.isEnabled && (isPlaying || isBg);

    if (isLayerPlaying && !isBg) {
      setupNoise();
      const ctx = audioCtxRef.current!;
      
      // Stop old noise if type changed
      if (noiseNodeRef.current) {
        noiseNodeRef.current.stop();
        noiseNodeRef.current = null;
      }

      const buffer = createNoiseBuffer(settings.noise.type);
      const source = ctx.createBufferSource();
      source.buffer = buffer!;
      source.loop = true;
      source.connect(noiseCompRef.current!);
      source.start();
      noiseNodeRef.current = source;

      const fadeTime = settings.fadeInOut ? 3 : 0.1;
      const gainValue = settings.noise.volume * Math.pow(10, settings.noise.gainDb / 20);
      const threshold = settings.noise.normalize ? -24 : 0;
      
      if (noiseCompRef.current) noiseCompRef.current.threshold.setTargetAtTime(threshold, ctx.currentTime, 0.1);
      noiseGainRef.current!.gain.setTargetAtTime(gainValue, ctx.currentTime, fadeTime / 2);
    } else {
      if (noiseGainRef.current && audioCtxRef.current) {
        const ctx = audioCtxRef.current;
        const fadeTime = settings.fadeInOut ? 3 : 0.1;
        noiseGainRef.current.gain.setTargetAtTime(0, ctx.currentTime, fadeTime / 2);
        
        const timer = setTimeout(() => {
           if ((!settings.noise.isEnabled || isBg) && noiseNodeRef.current) {
             noiseNodeRef.current.stop();
             noiseNodeRef.current = null;
           }
        }, fadeTime * 1000);
      }
    }

    const syncBg = async () => {
      syncBgLayer('noise', isLayerPlaying, isBg, 'noise', { noiseType: settings.noise.type }, settings.noise.volume, settings.noise.gainDb);
    };
    syncBg();
  }, [isPlaying, settings.noise.isEnabled, settings.noise.playInBackground, settings.noise.type, settings.noise.volume, settings.noise.gainDb, settings.noise.normalize, settings.audioTools.gainDb]);

  // Handle Didgeridoo Layer
  useEffect(() => {
    const isBg = settings.didgeridoo.playInBackground;
    const isLayerPlaying = settings.didgeridoo.isEnabled && settings.didgeridoo.isLooping && (isPlaying || isBg);

    if (isLayerPlaying && !isBg) {
      setupDidgeridoo();
      if (didgGainRef.current && audioCtxRef.current) {
        const ctx = audioCtxRef.current;
        const fadeTime = settings.fadeInOut ? 3 : 0.1;
        // Apply both volume and gainDb for precision control
        const gainValue = settings.didgeridoo.volume * Math.pow(10, settings.didgeridoo.gainDb / 20);
        const threshold = settings.didgeridoo.normalize ? -24 : 0;
        
        if (didgCompRef.current) didgCompRef.current.threshold.setTargetAtTime(threshold, ctx.currentTime, 0.1);
        didgGainRef.current.gain.setTargetAtTime(gainValue, ctx.currentTime, fadeTime / 2);
      }
    } else {
      if (didgGainRef.current && audioCtxRef.current) {
        const ctx = audioCtxRef.current;
        const fadeTime = settings.fadeInOut ? 3 : 0.1;
        didgGainRef.current.gain.setTargetAtTime(0, ctx.currentTime, fadeTime / 2);
      }
    }

    const syncBg = async () => {
      syncBgLayer('didgeridoo', isLayerPlaying, isBg, 'didgeridoo', { 
        frequency: settings.didgeridoo.frequency, 
        depth: settings.didgeridoo.depth 
      }, settings.didgeridoo.volume, settings.didgeridoo.gainDb);
    };
    syncBg();
  }, [isPlaying, settings.didgeridoo.isEnabled, settings.didgeridoo.isLooping, settings.didgeridoo.playInBackground, settings.fadeInOut, settings.didgeridoo.volume, settings.didgeridoo.gainDb, settings.didgeridoo.normalize, settings.didgeridoo.frequency, settings.didgeridoo.depth, settings.audioTools.gainDb]);

  // Handle Pure Hz Layer
  useEffect(() => {
    const isBg = settings.pureHz.playInBackground;
    const isLayerPlaying = settings.pureHz.isEnabled && settings.pureHz.isLooping && (isPlaying || isBg);

    if (isLayerPlaying && !isBg) {
      setupPureHz();
      if (pureHzGainRef.current && pureHzOscRef.current && audioCtxRef.current) {
        const ctx = audioCtxRef.current;
        const fadeTime = settings.fadeInOut ? 3 : 0.4;
        const gainValue = settings.pureHz.volume * Math.pow(10, settings.pureHz.gainDb / 20);
        pureHzOscRef.current.frequency.setTargetAtTime(settings.pureHz.frequency, ctx.currentTime, 0.1);
        pureHzGainRef.current.gain.setTargetAtTime(gainValue, ctx.currentTime, fadeTime / 2);
      }
    } else {
      if (pureHzGainRef.current && audioCtxRef.current) {
        const ctx = audioCtxRef.current;
        const fadeTime = settings.fadeInOut ? 3 : 0.4;
        pureHzGainRef.current.gain.setTargetAtTime(0, ctx.currentTime, fadeTime / 2);
      }
    }

    const syncBg = async () => {
      syncBgLayer('pureHz', isLayerPlaying, isBg, 'pureHz', { frequency: settings.pureHz.frequency }, settings.pureHz.volume, settings.pureHz.gainDb);
    };
    syncBg();
  }, [isPlaying, settings.pureHz.isEnabled, settings.pureHz.isLooping, settings.pureHz.playInBackground, settings.fadeInOut, settings.pureHz.volume, settings.pureHz.frequency, settings.pureHz.gainDb, settings.audioTools.gainDb]);

  // Handle Isochronic Layer
  useEffect(() => {
    const isBg = settings.isochronic.playInBackground;
    const isLayerPlaying = settings.isochronic.isEnabled && (isPlaying || isBg);

    if (isLayerPlaying && !isBg) {
      setupIsochronic();
      if (isoGainRef.current && isoOscRef.current && isoLfoRef.current && audioCtxRef.current) {
        const ctx = audioCtxRef.current;
        const fadeTime = settings.fadeInOut ? 3 : 0.4;
        const gainValue = settings.isochronic.volume * Math.pow(10, settings.isochronic.gainDb / 20);
        isoOscRef.current.frequency.setTargetAtTime(settings.isochronic.frequency, ctx.currentTime, 0.1);
        isoLfoRef.current.frequency.setTargetAtTime(settings.isochronic.pulseRate, ctx.currentTime, 0.1);
        isoGainRef.current.gain.setTargetAtTime(gainValue, ctx.currentTime, fadeTime / 2);
      }
    } else {
      if (isoGainRef.current && audioCtxRef.current) {
        const ctx = audioCtxRef.current;
        const fadeTime = settings.fadeInOut ? 3 : 0.4;
        isoGainRef.current.gain.setTargetAtTime(0, ctx.currentTime, fadeTime / 2);
      }
    }

    const syncBg = async () => {
      syncBgLayer('isochronic', isLayerPlaying, isBg, 'isochronic', { 
        frequency: settings.isochronic.frequency, 
        pulseRate: settings.isochronic.pulseRate 
      }, settings.isochronic.volume, settings.isochronic.gainDb);
    };
    syncBg();
  }, [isPlaying, settings.isochronic.isEnabled, settings.isochronic.playInBackground, settings.fadeInOut, settings.isochronic.volume, settings.isochronic.frequency, settings.isochronic.pulseRate, settings.isochronic.gainDb, settings.audioTools.gainDb]);

  // Handle Solfeggio Layer
  useEffect(() => {
    const isBg = settings.solfeggio.playInBackground;
    const isLayerPlaying = settings.solfeggio.isEnabled && (isPlaying || isBg);

    if (isLayerPlaying && !isBg) {
      setupSolfeggio();
      if (solGainRef.current && solOscRef.current && audioCtxRef.current) {
        const ctx = audioCtxRef.current;
        const fadeTime = settings.fadeInOut ? 3 : 0.4;
        const gainValue = settings.solfeggio.volume * Math.pow(10, settings.solfeggio.gainDb / 20);
        solOscRef.current.frequency.setTargetAtTime(settings.solfeggio.frequency, ctx.currentTime, 0.1);
        solGainRef.current.gain.setTargetAtTime(gainValue, ctx.currentTime, fadeTime / 2);
      }
    } else {
      if (solGainRef.current && audioCtxRef.current) {
        const ctx = audioCtxRef.current;
        const fadeTime = settings.fadeInOut ? 3 : 0.4;
        solGainRef.current.gain.setTargetAtTime(0, ctx.currentTime, fadeTime / 2);
      }
    }

    const syncBg = async () => {
      syncBgLayer('solfeggio', isLayerPlaying, isBg, 'solfeggio', { frequency: settings.solfeggio.frequency }, settings.solfeggio.volume, settings.solfeggio.gainDb);
    };
    syncBg();
  }, [isPlaying, settings.solfeggio.isEnabled, settings.solfeggio.playInBackground, settings.fadeInOut, settings.solfeggio.volume, settings.solfeggio.frequency, settings.solfeggio.gainDb, settings.audioTools.gainDb]);

  // Handle Display Always On (WakeLock)
  const wakeLockRef = useRef<any>(null);

  useEffect(() => {
    const requestWakeLock = async () => {
      if ('wakeLock' in navigator && settings.displayAlwaysOn && isPlaying) {
        try {
          if (wakeLockRef.current) return; // Already active
          wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
          console.log('[AudioEngine] Wake Lock is active');
          
          wakeLockRef.current.addEventListener('release', () => {
            console.log('[AudioEngine] Wake Lock released by system');
            wakeLockRef.current = null;
          });
        } catch (err) {
          console.warn(`[AudioEngine] Wake Lock request failed: ${err.name}, ${err.message}`);
          wakeLockRef.current = null;
        }
      }
    };

    const releaseWakeLock = async () => {
      if (wakeLockRef.current) {
        try {
          await wakeLockRef.current.release();
          wakeLockRef.current = null;
          console.log('[AudioEngine] Wake Lock released intentionally');
        } catch (err) {
          console.warn(`[AudioEngine] Wake Lock release failed: ${err.message}`);
        }
      }
    };

    if (settings.displayAlwaysOn && isPlaying) {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && settings.displayAlwaysOn && isPlaying) {
        requestWakeLock();
      }
      
      // Recovery logic for iOS: if we return to the app and audio is supposed to be playing but context is suspended
      if (document.visibilityState === 'visible' && isPlaying && audioCtxRef.current) {
        if (audioCtxRef.current.state === 'suspended') {
          audioCtxRef.current.resume().catch(() => {});
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      releaseWakeLock();
    };
  }, [settings.displayAlwaysOn, isPlaying]);

  // Handle Didgeridoo Real-time Updates (Frequency)
  useEffect(() => {
    if (didgOscRef.current && didgSubOscRef.current && didgFilterRef.current && audioCtxRef.current) {
      const ctx = audioCtxRef.current;
      didgOscRef.current.frequency.setTargetAtTime(settings.didgeridoo.frequency, ctx.currentTime, 0.2);
      didgSubOscRef.current.frequency.setTargetAtTime(settings.didgeridoo.frequency, ctx.currentTime, 0.2);
      
      // Update filter to follow frequency for consistent timbre
      const filterBase = settings.didgeridoo.frequency * 2.7;
      didgFilterRef.current.frequency.setTargetAtTime(filterBase * (1 + settings.didgeridoo.depth), ctx.currentTime, 0.2);
    }
  }, [settings.didgeridoo.frequency, settings.didgeridoo.depth]);

  // Handle Nature Layer
  useEffect(() => {
    const isBg = settings.nature.playInBackground;
    const isLayerPlaying = settings.nature.isEnabled && (isPlaying || isBg);
    const layerId = 'nature';

    if (isLayerPlaying) {
      setupNature();
      const audio = natureAudioRef.current!;
      const sound = NATURE_SOUNDS.find(s => s.id === settings.nature.type);
      
      if (sound) {
        if (audio.src !== sound.url) {
          audio.src = sound.url;
          audio.load();
          
          const onProgress = () => {
            const now = Date.now();
            const lastUpdate = (audio as any).lastProgressTime || 0;
            const throttleMs = document.visibilityState === 'visible' ? 250 : 5000;

            if (now - lastUpdate > throttleMs) {
              updateLayerProgress(layerId, {
                currentTime: audio.currentTime,
                duration: audio.duration || 0
              });
              (audio as any).lastProgressTime = now;
            }
          };
          audio.addEventListener('timeupdate', onProgress);
        }
        
        if (isBg) {
          // If playing in background, we avoid Web Audio routing for maximum reliability on iOS 16
          // We must disconnect if it was connected
          if (natureSourceRef.current) {
            try { natureSourceRef.current.disconnect(); } catch (e) {}
          }
          const gainValue = settings.nature.volume * Math.pow(10, settings.nature.gainDb / 20);
          audio.volume = Math.min(1, Math.max(0, gainValue));
        } else {
          // Normal mode: Reconnect to Web Audio graph
          if (natureSourceRef.current && natureGainRef.current) {
            natureSourceRef.current.connect(natureCompRef.current!);
          }
          audio.volume = 1.0; // Control per-layer via GainNode
          
          if (natureGainRef.current && audioCtxRef.current) {
            const ctx = audioCtxRef.current;
            const fadeTime = settings.fadeInOut ? 3 : 0.1;
            const gainValue = settings.nature.volume * Math.pow(10, settings.nature.gainDb / 20);
            const threshold = settings.nature.normalize ? -24 : 0;
            if (natureCompRef.current) natureCompRef.current.threshold.setTargetAtTime(threshold, ctx.currentTime, 0.1);
            natureGainRef.current.gain.setTargetAtTime(gainValue, ctx.currentTime, fadeTime / 2);
          }
        }

        if (audio.paused && (isPlaying || isBg)) audio.play().catch(console.error);
      }
    } else {
      if (natureAudioRef.current) {
        updateLayerProgress(layerId, { currentTime: 0, duration: 0 });
        if (natureGainRef.current && audioCtxRef.current && !isBg) {
          const ctx = audioCtxRef.current;
          const fadeTime = settings.fadeInOut ? 3 : 0.1;
          natureGainRef.current.gain.setTargetAtTime(0, ctx.currentTime, fadeTime / 2);
          setTimeout(() => {
            if (!settings.nature.isEnabled && natureAudioRef.current) natureAudioRef.current.pause();
          }, fadeTime * 1000);
        } else {
          natureAudioRef.current.pause();
        }
      }
    }
  }, [isPlaying, settings.nature.isEnabled, settings.nature.playInBackground, settings.nature.type, settings.nature.volume, settings.nature.gainDb, settings.nature.normalize, settings.fadeInOut]);

  // Heartbeat & Stability Sync
  useEffect(() => {
    if (!isPlaying) return;

    const interval = setInterval(() => {
      // 1. Recover AudioContext if suspended
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }

      // 2. Ensure active background layers are actually playing
      Object.entries(bgAudioRefs.current).forEach(([id, el]) => {
        const layerSettings = (settings as any)[id];
        if (layerSettings?.isEnabled && layerSettings?.playInBackground && el.paused) {
          console.log(`[AudioEngine] Heartbeat: Resuming stalled background layer: ${id}`);
          el.play().catch(() => {});
        }
      });

      // 3. Main Audio recovery if stalled
      if (currentTrack && mainAudioRef.current && mainAudioRef.current.paused && isPlaying) {
        // Only attempt if not already in an error state
        if (!mainAudioRef.current.error) {
           mainAudioRef.current.play().catch(() => {});
        }
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [isPlaying, currentTrack, settings]);

  // Handle Volume Balance
  useEffect(() => {
    if (audioCtxRef.current) {
      const ctx = audioCtxRef.current;
      const fadeTime = 0.1;

      if (mainGainRef.current) {
        const gainValue = settings.mainVolume; // Slider 0-1
        mainGainRef.current.gain.setTargetAtTime(gainValue, ctx.currentTime, fadeTime);
      }
      
      if (subSpecificGainRef.current) {
        // Respect both volume and gain(dB) for Web Audio
        const gainValue = settings.subliminal.volume * Math.pow(10, settings.subliminal.gainDb / 20);
        subSpecificGainRef.current.gain.setTargetAtTime(gainValue, ctx.currentTime, fadeTime);
      }
    }

    // Handle HTML Audio Element Volume directly
    // This ensures Gain dB works even when Web Audio is suspended or bypassed
    const masterGainMultiplier = settings.audioTools.gainDb !== 0 ? Math.pow(10, settings.audioTools.gainDb / 20) : 1.0;

    if (mainAudioRef.current) {
      if (settings.audioTools.playInBackground) {
        const finalVolume = settings.mainVolume * masterGainMultiplier;
        mainAudioRef.current.volume = Math.min(1.0, Math.max(0.0, finalVolume));
      } else {
        // Use 1.0 because volume is handled by WebAudio gain node
        mainAudioRef.current.volume = 1.0; 
      }
    }

    if (subAudioRef.current) {
      const subGainMultiplier = Math.pow(10, settings.subliminal.gainDb / 20);
      if (settings.subliminal.playInBackground) {
        const finalVolume = settings.subliminal.volume * subGainMultiplier * masterGainMultiplier;
        subAudioRef.current.volume = Math.min(1.0, Math.max(0.0, finalVolume));
      } else {
        subAudioRef.current.volume = 1.0;
      }
    }
  }, [settings.mainVolume, settings.subliminal.volume, settings.subliminal.gainDb, settings.audioTools.gainDb, settings.audioTools.playInBackground, settings.subliminal.playInBackground, currentTrack]);

  // Handle Playback Rate
  useEffect(() => {
    if (mainAudioRef.current) {
      mainAudioRef.current.playbackRate = settings.playbackRate;
    }
  }, [settings.playbackRate, currentTrack]);

  // Sync Subliminal with Main Track if enabled
  useEffect(() => {
    if (isPlaying && settings.syncPlayback && settings.subliminal.isEnabled && mainAudioRef.current && subAudioRef.current && !settings.subliminal.isPlaylistMode) {
      const syncInterval = setInterval(() => {
        if (mainAudioRef.current && subAudioRef.current && subAudioRef.current.readyState >= 2) {
          const mainTime = mainAudioRef.current.currentTime;
          const subTime = subAudioRef.current.currentTime;
          const duration = subAudioRef.current.duration;
          
          if (duration > 0) {
             const targetTime = mainTime % duration;
             const diff = Math.abs(targetTime - subTime);
             
             // Only sync if they drift by more than 0.5s to avoid stutter
             if (diff > 0.5) {
               subAudioRef.current.currentTime = targetTime;
             }
          }
        }
      }, 2000);
      return () => clearInterval(syncInterval);
    }
  }, [isPlaying, settings.syncPlayback, settings.subliminal.isEnabled, settings.subliminal.isPlaylistMode]);

  // Handle Subliminal Looping State
  useEffect(() => {
    if (subAudioRef.current) {
      subAudioRef.current.loop = settings.subliminal.isPlaylistMode ? false : settings.subliminal.isLooping;
    }
  }, [settings.subliminal.isLooping, settings.subliminal.isPlaylistMode]);

  // Audio Context Heartbeat & Playback Safety
  useEffect(() => {
    if (!isPlaying) return;
    
    const interval = setInterval(() => {
      // 1. Context Nudge
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        console.log('[AudioEngine] Heartbeat: Resuming suspended context');
        audioCtxRef.current.resume().catch(() => {});
      }
      
      // 2. Playback Safety: If supposed to be playing but both are paused, attempt nudge
      // Enhanced for iOS 16: Check readyState and stalled state
      if (mainAudioRef.current && isPlaying) {
         const { paused, readyState, networkState, error } = mainAudioRef.current;
         
         if (paused) {
            console.warn('[AudioEngine] Heartbeat: Playback desync detected, nudging...');
            mainAudioRef.current.play().catch(() => {});
         }
         
         // If stuck in a "stalled" but not paused state with no meta
         if (readyState < 1 && networkState === 2) { // 2 = NETWORK_LOADING
            console.warn('[AudioEngine] Heartbeat: Media stuck in loading state, reloading...');
            mainAudioRef.current.load();
         }
      }
      
      // 3. MediaSession State Sync
      if ('mediaSession' in navigator && isPlaying) {
        navigator.mediaSession.playbackState = 'playing';
      }
    }, 3000); // 3s heartbeats for tight sync on iPhone 8
    
    return () => clearInterval(interval);
  }, [isPlaying]);

  return null;
}
