import * as db from '../db';
import { Track } from '../types';

const MAX_CHUNK_DURATION = 5 * 60; // 5 minutes - Safe for iPhone 8 RAM
const SAMPLE_RATE = 44100;

export interface ChunkPlan {
  playlistId: string;
  chunks: {
    index: number;
    trackIds: string[];
    startOffsetInFirstTrack: number; // For partial tracks if we ever need them
  }[];
}

export class ChunkManager {
  static async createChunkPlan(playlistId: string, tracks: Track[], maxDurationMinutes: number = 5): Promise<ChunkPlan> {
    const maxDurationSeconds = maxDurationMinutes * 60;
    const plan: ChunkPlan = { playlistId, chunks: [] };
    let currentChunkTracks: string[] = [];
    let currentChunkDuration = 0;
    let chunkIndex = 0;

    for (const track of tracks) {
      let duration = track.duration || 0;
      if (duration === 0) {
        duration = await this.getAudioDuration(track.id);
      }
      
      if (currentChunkDuration + duration > maxDurationSeconds && currentChunkTracks.length > 0) {
        plan.chunks.push({
          index: chunkIndex++,
          trackIds: currentChunkTracks,
          startOffsetInFirstTrack: 0
        });
        currentChunkTracks = [track.id];
        currentChunkDuration = duration;
      } else {
        currentChunkTracks.push(track.id);
        currentChunkDuration += duration;
      }
    }

    if (currentChunkTracks.length > 0) {
      plan.chunks.push({
        index: chunkIndex++,
        trackIds: currentChunkTracks,
        startOffsetInFirstTrack: 0
      });
    }

    return plan;
  }

  private static durationCache: Record<string, number> = {};

  public static async getAudioDuration(trackId: string): Promise<number> {
    if (this.durationCache[trackId]) return this.durationCache[trackId];
    
    const blob = await db.getTrackBlob(trackId);
    if (!blob) return 0;

    return new Promise((resolve) => {
      const audio = new Audio();
      const url = URL.createObjectURL(blob);
      audio.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        this.durationCache[trackId] = audio.duration;
        resolve(audio.duration);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(0);
      };
      audio.src = url;
    });
  }

  static async renderChunk(playlistId: string, chunkIndex: number, trackIds: string[]): Promise<{ blob: Blob; duration: number } | null> {
    try {
      const chunkId = `chunk_${playlistId}_${chunkIndex}`;
      console.log(`[ChunkManager] Rendering ${chunkId}...`);

      const buffers: AudioBuffer[] = [];
      let totalDuration = 0;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();

      for (const tid of trackIds) {
        const blob = await db.getTrackBlob(tid);
        if (!blob) continue;
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        buffers.push(audioBuffer);
        totalDuration += audioBuffer.duration;
      }

      const OfflineCtx = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
      const offlineCtx = new OfflineCtx(2, Math.ceil(totalDuration * SAMPLE_RATE), SAMPLE_RATE);

      let offset = 0;
      for (const buffer of buffers) {
        const source = offlineCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(offlineCtx.destination);
        source.start(offset);
        offset += buffer.duration;
      }

      const renderedBuffer = await offlineCtx.startRendering();
      await ctx.close();

      const blob = this.audioBufferToWav(renderedBuffer);
      return { blob, duration: totalDuration };
    } catch (err) {
      console.error("[ChunkManager] Render failed:", err);
      return null;
    }
  }

  private static audioBufferToWav(buffer: AudioBuffer): Blob {
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
  }
}
