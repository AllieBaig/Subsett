import React from 'react';
import { useSettings } from '../SettingsContext';
import { useAudio } from '../AudioContext';
import { LayerAccordion, HzSelector } from './LayerUI';
import { NATURE_SOUNDS } from '../constants';
import { 
  Volume2, Activity, CloudRain, Wind, 
  Music as MusicIcon, Zap, Sliders, Ear
} from 'lucide-react';
import { PickerWheel } from './PickerWheel';

export const AudioLayerLibrary = () => {
  const { 
    settings, 
    updateSubliminalSettings,
    updateBinauralSettings,
    updateNatureSettings,
    updateNoiseSettings,
    updateDidgeridooSettings,
    updatePureHzSettings,
    updateIsochronicSettings,
    updateSolfeggioSettings
  } = useSettings();

  const { playlists, tracks } = useAudio();

  const applyLayerPreset = (layer: string, preset: 'soft' | 'night' | 'focus') => {
    // Shared preset logic
    const updateFnMap: any = {
      subliminal: updateSubliminalSettings,
      binaural: updateBinauralSettings,
      nature: updateNatureSettings,
      noise: updateNoiseSettings,
      didgeridoo: updateDidgeridooSettings,
      pureHz: updatePureHzSettings,
      isochronic: updateIsochronicSettings,
      solfeggio: updateSolfeggioSettings
    };

    const updateFn = updateFnMap[layer];
    if (!updateFn) return;

    if (preset === 'soft') {
      updateFn({ volume: 0.15, gainDb: -12, normalize: true });
    } else if (preset === 'night') {
      updateFn({ volume: 0.1, gainDb: -18, normalize: true });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 1. Subliminal */}
      <LayerAccordion 
        id="subliminal" icon={Volume2} label="Subliminal Audio" 
        isEnabled={settings.subliminal.isEnabled} 
        onToggle={(v: boolean) => updateSubliminalSettings({ isEnabled: v })}
        vol={settings.subliminal.volume}
        setVol={(v: number) => updateSubliminalSettings({ volume: v })}
        gainDb={settings.subliminal.gainDb}
        setGainDb={(v: number) => updateSubliminalSettings({ gainDb: v })}
        normalize={settings.subliminal.normalize}
        setNormalize={(v: boolean) => updateSubliminalSettings({ normalize: v })}
        playInBackground={settings.subliminal.playInBackground}
        setPlayInBackground={(v: boolean) => updateSubliminalSettings({ playInBackground: v })}
        color="text-apple-blue"
        subtitle={settings.subliminal.isPlaylistMode ? 'Playlist Mode' : 'Track Mode'}
        onApplyPreset={(p: any) => applyLayerPreset('subliminal', p)}
      >
        <div className="flex flex-col gap-6">
          <div className="bg-secondary-system-background p-1 rounded-xl flex items-center h-8">
            <button 
              onClick={() => updateSubliminalSettings({ isPlaylistMode: false })}
              className={`flex-1 h-full text-[9px] font-bold uppercase tracking-widest rounded-lg transition-all ${!settings.subliminal.isPlaylistMode ? 'bg-system-background shadow-sm text-apple-blue' : 'text-system-secondary-label'}`}
            >
              Track
            </button>
            <button 
              onClick={() => updateSubliminalSettings({ isPlaylistMode: true })}
              className={`flex-1 h-full text-[9px] font-bold uppercase tracking-widest rounded-lg transition-all ${settings.subliminal.isPlaylistMode ? 'bg-system-background shadow-sm text-apple-blue' : 'text-system-secondary-label'}`}
            >
              Playlist
            </button>
          </div>

          {!settings.subliminal.isPlaylistMode && settings.subliminal.sourcePlaylistId && (
            <div className="flex flex-col gap-3">
              {(() => {
                const sourcePlaylist = playlists.find(p => p.id === settings.subliminal.sourcePlaylistId);
                if (!sourcePlaylist || sourcePlaylist.trackIds.length === 0) return null;

                const pickerItems = sourcePlaylist.trackIds.map(tid => ({
                  id: tid,
                  label: tracks.find(mt => mt.id === tid)?.name || 'Unknown Track'
                }));

                return (
                  <PickerWheel 
                    items={pickerItems}
                    selectedValue={settings.subliminal.selectedTrackId}
                    onValueChange={(id) => updateSubliminalSettings({ selectedTrackId: id })}
                    height={140}
                    itemHeight={36}
                  />
                );
              })()}
            </div>
          )}
        </div>
      </LayerAccordion>

      {/* 2. Binaural */}
      <LayerAccordion 
        id="binaural" icon={Activity} label="Binaural Beats" 
        isEnabled={settings.binaural.isEnabled} 
        onToggle={(v: boolean) => updateBinauralSettings({ isEnabled: v })}
        vol={settings.binaural.volume}
        setVol={(v: number) => updateBinauralSettings({ volume: v })}
        gainDb={settings.binaural.gainDb}
        setGainDb={(v: number) => updateBinauralSettings({ gainDb: v })}
        normalize={settings.binaural.normalize}
        setNormalize={(v: boolean) => updateBinauralSettings({ normalize: v })}
        playInBackground={settings.binaural.playInBackground}
        setPlayInBackground={(v: boolean) => updateBinauralSettings({ playInBackground: v })}
        color="text-purple-500"
        subtitle={`${settings.binaural.leftFreq}Hz / ${settings.binaural.rightFreq}Hz`}
        onApplyPreset={(p: any) => applyLayerPreset('binaural', p)}
      >
        <div className="flex flex-col gap-6">
           <div className="space-y-4">
              <div className="space-y-2">
                 <div className="flex justify-between items-center px-1">
                    <span className="text-[9px] font-black text-system-tertiary-label uppercase">Left (Hz)</span>
                 </div>
                 <HzSelector 
                   value={settings.binaural.leftFreq} 
                   onChange={(v) => updateBinauralSettings({ leftFreq: v })} 
                   color="purple"
                 />
              </div>
              <div className="space-y-2">
                 <div className="flex justify-between items-center px-1">
                    <span className="text-[9px] font-black text-system-tertiary-label uppercase">Right (Hz)</span>
                 </div>
                 <HzSelector 
                   value={settings.binaural.rightFreq} 
                   onChange={(v) => updateBinauralSettings({ rightFreq: v })} 
                   color="purple"
                 />
              </div>
           </div>
        </div>
      </LayerAccordion>

      {/* 3. Nature */}
      <LayerAccordion 
        id="nature" icon={CloudRain} label="Nature Ambience" 
        isEnabled={settings.nature.isEnabled} 
        onToggle={(v: boolean) => updateNatureSettings({ isEnabled: v })}
        vol={settings.nature.volume}
        setVol={(v: number) => updateNatureSettings({ volume: v })}
        gainDb={settings.nature.gainDb}
        setGainDb={(v: number) => updateNatureSettings({ gainDb: v })}
        normalize={settings.nature.normalize}
        setNormalize={(v: boolean) => updateNatureSettings({ normalize: v })}
        playInBackground={settings.nature.playInBackground}
        setPlayInBackground={(v: boolean) => updateNatureSettings({ playInBackground: v })}
        color="text-green-500"
        subtitle={settings.nature.type}
        onApplyPreset={(p: any) => applyLayerPreset('nature', p)}
      >
        <div className="grid grid-cols-3 gap-2">
          {NATURE_SOUNDS.map(sound => (
            <button 
              key={sound.id}
              onClick={() => updateNatureSettings({ type: sound.id as any })}
              className={`py-2 px-1 rounded-xl text-[9px] font-bold uppercase transition-all border ${settings.nature.type === sound.id ? 'bg-green-500 text-white border-green-500 shadow-sm' : 'bg-system-background border-apple-border text-system-secondary-label'}`}
            >
              {sound.name}
            </button>
          ))}
        </div>
      </LayerAccordion>

      {/* 4. Noise */}
      <LayerAccordion 
        id="noise" icon={Wind} label="Noise Colors" 
        isEnabled={settings.noise.isEnabled} 
        onToggle={(v: boolean) => updateNoiseSettings({ isEnabled: v })}
        vol={settings.noise.volume}
        setVol={(v: number) => updateNoiseSettings({ volume: v })}
        gainDb={settings.noise.gainDb}
        setGainDb={(v: number) => updateNoiseSettings({ gainDb: v })}
        normalize={settings.noise.normalize}
        setNormalize={(v: boolean) => updateNoiseSettings({ normalize: v })}
        playInBackground={settings.noise.playInBackground}
        setPlayInBackground={(v: boolean) => updateNoiseSettings({ playInBackground: v })}
        color="text-orange-500"
        subtitle={`${settings.noise.type} noise`}
        onApplyPreset={(p: any) => applyLayerPreset('noise', p)}
      >
        <div className="grid grid-cols-3 gap-2">
            {['white', 'pink', 'brown'].map(type => (
              <button 
                key={type}
                onClick={() => updateNoiseSettings({ type: type as any })}
                className={`py-2 px-1 rounded-xl text-[9px] font-bold uppercase transition-all border ${settings.noise.type === type ? 'bg-orange-500 text-white border-orange-500 shadow-sm' : 'bg-system-background border-apple-border text-system-secondary-label'}`}
              >
                {type}
              </button>
            ))}
          </div>
      </LayerAccordion>

      {/* 5. Didgeridoo */}
      <LayerAccordion 
        id="didgeridoo" icon={MusicIcon} label="Didgeridoo" 
        isEnabled={settings.didgeridoo.isEnabled} 
        onToggle={(v: boolean) => updateDidgeridooSettings({ isEnabled: v })}
        vol={settings.didgeridoo.volume}
        setVol={(v: number) => updateDidgeridooSettings({ volume: v })}
        gainDb={settings.didgeridoo.gainDb}
        setGainDb={(v: number) => updateDidgeridooSettings({ gainDb: v })}
        normalize={settings.didgeridoo.normalize}
        setNormalize={(v: boolean) => updateDidgeridooSettings({ normalize: v })}
        playInBackground={settings.didgeridoo.playInBackground}
        setPlayInBackground={(v: boolean) => updateDidgeridooSettings({ playInBackground: v })}
        color="text-amber-800"
        subtitle={`${Math.round(settings.didgeridoo.frequency)}Hz Drone`}
        onApplyPreset={(p: any) => applyLayerPreset('didgeridoo', p)}
      >
        <div className="space-y-4">
           <p className="text-[9px] font-black text-system-tertiary-label uppercase tracking-widest pl-1">Target Frequency (Hz)</p>
           <HzSelector 
             value={settings.didgeridoo.frequency} 
             onChange={(v) => updateDidgeridooSettings({ 
               frequency: v,
               playbackRate: v / 65 
             })} 
             color="amber"
           />
        </div>
      </LayerAccordion>

      {/* 6. Pure Hz */}
      <LayerAccordion 
        id="pureHz" icon={Activity} label="Pure Hz" 
        isEnabled={settings.pureHz.isEnabled} 
        onToggle={(v: boolean) => updatePureHzSettings({ isEnabled: v })}
        vol={settings.pureHz.volume}
        setVol={(v: number) => updatePureHzSettings({ volume: v })}
        gainDb={settings.pureHz.gainDb}
        setGainDb={(v: number) => updatePureHzSettings({ gainDb: v })}
        normalize={settings.pureHz.normalize}
        setNormalize={(v: boolean) => updatePureHzSettings({ normalize: v })}
        playInBackground={settings.pureHz.playInBackground}
        setPlayInBackground={(v: boolean) => updatePureHzSettings({ playInBackground: v })}
        color="text-rose-600"
        subtitle={`${settings.pureHz.frequency}Hz`}
        onApplyPreset={(p: any) => applyLayerPreset('pureHz', p)}
      >
        <HzSelector 
          value={settings.pureHz.frequency} 
          onChange={(v) => updatePureHzSettings({ frequency: v })} 
          color="rose"
        />
      </LayerAccordion>

      {/* 7. Isochronic */}
      <LayerAccordion 
        id="isochronic" icon={Zap} label="Isochronic Tones" 
        isEnabled={settings.isochronic.isEnabled} 
        onToggle={(v: boolean) => updateIsochronicSettings({ isEnabled: v })}
        vol={settings.isochronic.volume}
        setVol={(v: number) => updateIsochronicSettings({ volume: v })}
        gainDb={settings.isochronic.gainDb}
        setGainDb={(v: number) => updateIsochronicSettings({ gainDb: v })}
        normalize={settings.isochronic.normalize}
        setNormalize={(v: boolean) => updateIsochronicSettings({ normalize: v })}
        playInBackground={settings.isochronic.playInBackground}
        setPlayInBackground={(v: boolean) => updateIsochronicSettings({ playInBackground: v })}
        color="text-blue-600"
        subtitle={`${settings.isochronic.frequency}Hz pulse`}
        onApplyPreset={(p: any) => applyLayerPreset('isochronic', p)}
      >
        <div className="space-y-4">
           <HzSelector 
             value={settings.isochronic.frequency} 
             onChange={(v) => updateIsochronicSettings({ frequency: v })} 
             color="blue"
           />
        </div>
      </LayerAccordion>

      {/* 8. Solfeggio */}
      <LayerAccordion 
        id="solfeggio" icon={Ear} label="Solfeggio Layers" 
        isEnabled={settings.solfeggio.isEnabled} 
        onToggle={(v: boolean) => updateSolfeggioSettings({ isEnabled: v })}
        vol={settings.solfeggio.volume}
        setVol={(v: number) => updateSolfeggioSettings({ volume: v })}
        gainDb={settings.solfeggio.gainDb}
        setGainDb={(v: number) => updateSolfeggioSettings({ gainDb: v })}
        normalize={settings.solfeggio.normalize}
        setNormalize={(v: boolean) => updateSolfeggioSettings({ normalize: v })}
        playInBackground={settings.solfeggio.playInBackground}
        setPlayInBackground={(v: boolean) => updateSolfeggioSettings({ playInBackground: v })}
        color="text-emerald-600"
        subtitle={`${settings.solfeggio.frequency}Hz Healing`}
        onApplyPreset={(p: any) => applyLayerPreset('solfeggio', p)}
      >
        <HzSelector 
          value={settings.solfeggio.frequency} 
          onChange={(v) => updateSolfeggioSettings({ frequency: v })} 
          color="emerald"
        />
      </LayerAccordion>
    </div>
  );
};
