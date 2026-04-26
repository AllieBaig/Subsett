import React, { useState, useMemo } from 'react';
import { useAudio } from '../AudioContext';
import { useUIState } from '../UIStateContext';
import { Search, X, Music, Play, Plus, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useSettings } from '../SettingsContext';
import { ArtworkImage } from '../components/ArtworkImage';

export default function SearchView() {
  const { tracks, userPlayTrack, currentTrackIndex, currentPlaybackList } = useAudio();
  const { navigateTo } = useUIState();
  const { settings } = useSettings();
  const [searchQuery, setSearchQuery] = useState('');

  const filteredTracks = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return tracks.filter(t => 
      t.name.toLowerCase().includes(q) || 
      (t.artist && t.artist.toLowerCase().includes(q))
    );
  }, [tracks, searchQuery]);

  return (
    <div className="flex flex-col h-full bg-system-background">
      <header className="px-6 pt-10 pb-4">
        <h1 className="text-3xl font-[900] tracking-tight text-system-label mb-6">Search</h1>
        <div className="relative group">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-system-secondary-label pointer-events-none">
            <Search size={20} />
          </div>
          <input 
            type="text"
            placeholder="Search for tracks or artists"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-14 bg-secondary-system-background border-none pl-12 pr-12 py-4 rounded-2xl text-base font-medium outline-none transition-all placeholder:text-system-tertiary-label text-system-label focus:ring-2 focus:ring-apple-blue/20"
            autoFocus
          />
          {searchQuery && (
            <button 
              onClick={() => setSearchQuery('')}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-1 bg-system-tertiary-label/20 rounded-full text-system-secondary-label"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto no-scrollbar px-6 pb-40">
        {!searchQuery.trim() ? (
          <div className="flex flex-col items-center justify-center pt-24 gap-6 text-center">
            <div className="w-20 h-20 bg-secondary-system-background rounded-[2rem] flex items-center justify-center text-system-tertiary-label/30">
              <Search size={40} />
            </div>
            <div className="space-y-2">
              <h3 className="text-lg font-bold text-system-label">Search Everything</h3>
              <p className="text-sm text-system-secondary-label max-w-[240px]">
                Search through all your imported tracks and collections instantly.
              </p>
            </div>
          </div>
        ) : filteredTracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center pt-24 gap-6 text-center">
            <div className="w-16 h-16 bg-secondary-system-background rounded-2xl flex items-center justify-center text-system-tertiary-label/50">
              <X size={32} />
            </div>
            <p className="text-sm font-medium text-system-secondary-label">No results for "{searchQuery}"</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 mt-6">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-system-secondary-label px-2 mb-2">Track Results</h3>
            {filteredTracks.map((track) => {
              const trueIndex = tracks.findIndex(t => t.id === track.id);
              const isActive = currentTrackIndex !== null && currentPlaybackList[currentTrackIndex]?.id === track.id;
              
              return (
                <button
                  key={track.id}
                  onClick={() => {
                    userPlayTrack(trueIndex, null);
                    navigateTo('player');
                  }}
                  className={`w-full flex items-center justify-between p-3 rounded-2xl transition-all group ${isActive ? 'bg-apple-blue/5' : 'bg-secondary-system-background/50 hover:bg-secondary-system-background'}`}
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-12 h-12 rounded-xl flex-shrink-0 overflow-hidden bg-system-background border border-apple-border relative">
                      <ArtworkImage src={track.artwork} className="w-full h-full" iconSize={20} />
                      {isActive && (
                        <div className="absolute inset-0 bg-apple-blue/20 flex items-center justify-center">
                          <div className="flex gap-0.5 items-end h-3">
                            <div className="w-0.5 bg-apple-blue animate-bounce" style={{ animationDelay: '0ms' }} />
                            <div className="w-0.5 bg-apple-blue animate-bounce" style={{ animationDelay: '200ms' }} />
                            <div className="w-0.5 bg-apple-blue animate-bounce" style={{ animationDelay: '400ms' }} />
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-start min-w-0 text-left">
                      <span className={`text-sm font-bold truncate w-full ${isActive ? 'text-apple-blue' : 'text-system-label'}`}>{track.name}</span>
                      <span className="text-[10px] font-bold text-system-secondary-label/60 uppercase tracking-tight truncate w-full">{track.artist || 'Unknown Artist'}</span>
                    </div>
                  </div>
                  <ChevronRight size={16} className={`${isActive ? 'text-apple-blue' : 'text-system-tertiary-label'} opacity-30`} />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
