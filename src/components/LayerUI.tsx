import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useSettings } from '../SettingsContext';
import { usePlayback } from '../PlaybackContext';
import { FREQUENCY_PRESETS } from '../constants';
import { PickerWheel } from './PickerWheel';
import { Activity, Sliders, ChevronDown, ChevronRight } from 'lucide-react';

export const LayerProgress = ({ layerId }: { layerId: string }) => {
  const { layerProgress } = usePlayback();
  const progress = layerProgress[layerId];
  
  if (!progress || progress.duration === 0) return null;
  
  const percentage = (progress.currentTime / progress.duration) * 100;
  
  return (
    <div className="w-full h-0.5 bg-system-tertiary-label/20 rounded-full overflow-hidden">
      <motion.div 
        className="h-full bg-apple-blue"
        initial={{ width: 0 }}
        animate={{ width: `${percentage}%` }}
        transition={{ type: "spring", bounce: 0, duration: 0.5 }}
      />
    </div>
  );
};

export const HzSelector = ({ value, onChange, color }: { value: number, onChange: (v: number) => void, color: string }) => {
  const { settings, updateSettings } = useSettings();
  const inputMode = settings.hzInputMode || 'slider';

  const colorClass = color === 'purple' ? 'text-purple-600' : 
                    color === 'blue' ? 'text-apple-blue' : 
                    color === 'green' ? 'text-green-600' : 
                    color === 'amber' ? 'text-amber-800' : 
                    color === 'rose' ? 'text-rose-600' : 
                    'text-orange-600';

  const bgActiveColorClass = color === 'purple' ? 'accent-purple-600' : 
                            color === 'blue' ? 'accent-apple-blue' : 
                            color === 'green' ? 'accent-green-600' : 
                            color === 'amber' ? 'accent-amber-800' : 
                            color === 'rose' ? 'accent-rose-600' : 
                            'accent-orange-600';

  const renderManual = () => (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <input 
          type="number"
          value={value}
          onChange={(e) => onChange(Math.max(0.1, Math.min(1900, parseFloat(e.target.value) || 0.1)))}
          className="w-full h-12 bg-secondary-system-background border border-apple-border rounded-2xl px-5 text-sm font-black tabular-nums focus:ring-1 focus:ring-apple-blue"
        />
        <div className="absolute right-4 top-1/2 -translate-y-1/2">
           <span className="text-[10px] font-black text-system-tertiary-label">Hz</span>
        </div>
      </div>
    </div>
  );

  const renderSlider = () => (
    <div className="space-y-4">
      <div className="flex justify-between items-center px-1">
         <span className={`text-xl font-black tabular-nums ${colorClass}`}>{value} Hz</span>
         <div className="flex bg-secondary-system-background rounded-full p-0.5 border border-apple-border">
            <button onClick={() => onChange(Math.max(0.1, value - 1))} className="w-8 h-6 flex items-center justify-center text-system-label hover:bg-system-background rounded-full transition-colors">-</button>
            <div className="w-px h-3 bg-apple-border my-auto" />
            <button onClick={() => onChange(Math.min(1900, value + 1))} className="w-8 h-6 flex items-center justify-center text-system-label hover:bg-system-background rounded-full transition-colors">+</button>
         </div>
      </div>
      <input 
        type="range" min={20} max={1900} step={1} value={value}
        onChange={(e) => onChange(parseInt(e.target.value))}
        className={`w-full h-1 bg-apple-border rounded-full appearance-none ${bgActiveColorClass}`}
      />
    </div>
  );

  const renderPicker = () => {
    const pickerItems = FREQUENCY_PRESETS.map(hz => ({
      id: hz,
      label: `${hz} Hz`
    }));

    // Find nearest preset if current value is not in presets
    const currentVal = value;
    const isPreset = FREQUENCY_PRESETS.includes(currentVal);

    return (
      <div className="space-y-4">
        {!isPreset && (
          <div className="flex items-center justify-between px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-2xl mb-2">
            <span className="text-[9px] font-bold text-amber-700 uppercase">Custom Hz Active</span>
            <span className="text-[10px] font-black text-amber-700 tabular-nums">{currentVal}Hz</span>
          </div>
        )}
        <PickerWheel 
          items={pickerItems}
          selectedValue={isPreset ? currentVal : -1}
          onValueChange={(hz) => onChange(hz)}
          height={160}
          itemHeight={40}
        />
        <div className="flex justify-center">
           <button 
            onClick={() => updateSettings({ hzInputMode: 'manual' })}
            className="text-[9px] font-black text-apple-blue uppercase tracking-widest hover:underline"
           >
             Set Custom Frequency
           </button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex bg-secondary-system-background p-1 rounded-2xl h-10 border border-apple-border">
        {(['picker', 'slider', 'manual'] as const).map(mode => (
          <button
            key={mode}
            onClick={() => updateSettings({ hzInputMode: mode })}
            className={`flex-1 h-full rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${inputMode === mode ? 'bg-system-background text-apple-blue shadow-sm' : 'text-system-secondary-label hover:text-system-label'}`}
          >
            {mode}
          </button>
        ))}
      </div>

      <div className="pt-2">
        {inputMode === 'picker' && renderPicker()}
        {inputMode === 'slider' && renderSlider()}
        {inputMode === 'manual' && renderManual()}
      </div>
    </div>
  );
};

export const LayerAccordion = ({ 
  id, icon: Icon, label, isEnabled, onToggle, vol, setVol, 
  gainDb, setGainDb, normalize, setNormalize, 
  playInBackground, setPlayInBackground,
  color, subtitle, children, onApplyPreset 
}: any) => {
  const [isToolsExpanded, setIsToolsExpanded] = useState(false);

  return (
    <div className="bg-secondary-system-background border border-apple-border rounded-[2.5rem] overflow-hidden transition-all shadow-sm">
      <div className="p-5 flex items-center justify-between">
        <div className="flex items-center gap-4 min-w-0">
          <div className={`w-12 h-12 ${isEnabled ? 'bg-system-background shadow-sm' : 'bg-system-background/50'} rounded-2xl flex-shrink-0 flex items-center justify-center ${isEnabled ? color : 'text-system-tertiary-label'} transition-all`}>
            <Icon size={24} />
          </div>
          <div className="min-w-0 flex-1">
            <h5 className="text-sm font-black tracking-tight truncate text-system-label">{label}</h5>
            {subtitle && <p className="text-[9px] text-system-secondary-label uppercase font-black tracking-widest truncate">{subtitle}</p>}
          </div>
        </div>
        <button 
          onClick={() => onToggle(!isEnabled)}
          className={`flex-shrink-0 w-12 h-7 rounded-full relative transition-colors ${isEnabled ? (color.includes('blue') ? 'bg-apple-blue' : color.includes('purple') ? 'bg-purple-500' : color.includes('green') ? 'bg-green-500' : color.includes('amber') ? 'bg-amber-800' : color.includes('rose') ? 'bg-rose-600' : 'bg-orange-500') : 'bg-system-tertiary-label'}`}
        >
          <motion.div className="absolute top-1 left-1 bg-white w-5 h-5 rounded-full" animate={{ x: isEnabled ? 20 : 0 }} />
        </button>
      </div>

      {isEnabled && <div className="px-5 pb-3"><LayerProgress layerId={id} /></div>}
      
      <AnimatePresence>
        {isEnabled && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="px-5 pb-8 space-y-8"
          >
            {/* Background Play Support */}
            <div className="flex items-center justify-between p-5 bg-system-background rounded-[2rem] border border-apple-border shadow-sm">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-apple-blue/5 text-apple-blue rounded-2xl flex items-center justify-center">
                  <Activity size={18} />
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-black text-system-label uppercase tracking-widest">Background Mode</span>
                  <span className="text-[8px] font-bold text-system-tertiary-label uppercase">Stable Playback</span>
                </div>
              </div>
              <button 
                onClick={() => setPlayInBackground(!playInBackground)}
                className={`w-10 h-6 rounded-full relative transition-colors ${playInBackground ? 'bg-apple-blue' : 'bg-system-tertiary-label'}`}
              >
                <motion.div className="absolute top-1 left-1 bg-white w-4 h-4 rounded-full" animate={{ x: playInBackground ? 16 : 0 }} />
              </button>
            </div>

            {/* Volume Section */}
            <div className="space-y-4">
              <div className="flex justify-between items-center px-1">
                <span className="text-[10px] font-black text-system-tertiary-label uppercase tracking-widest">Volume (%)</span>
                <input 
                  type="number"
                  value={Math.round(vol * 100)}
                  onChange={(e) => setVol(Math.min(1, Math.max(0, (parseInt(e.target.value) || 0) / 100)))}
                  className="w-12 h-7 bg-system-background border border-apple-border rounded-lg text-[10px] font-black text-center focus:outline-none tabular-nums"
                />
              </div>
              <div className="flex items-center gap-4">
                <input 
                  type="range" min={0} max={1} step={0.01} value={vol}
                  onChange={(e) => setVol(parseFloat(e.target.value))}
                  className="flex-1 h-1 bg-apple-border rounded-full appearance-none accent-system-label"
                />
              </div>
            </div>

            {/* Gain Section */}
            <div className="space-y-4">
              <div className="flex justify-between items-center px-1">
                <span className="text-[10px] font-black text-system-tertiary-label uppercase tracking-widest">Gain (dB)</span>
                <input 
                  type="number"
                  value={gainDb}
                  onChange={(e) => setGainDb(Math.min(0, Math.max(-60, parseInt(e.target.value) || 0)))}
                  className="w-12 h-7 bg-system-background border border-apple-border rounded-lg text-[10px] font-black text-center focus:outline-none tabular-nums"
                />
              </div>
              <div className="flex items-center gap-4">
                <input 
                  type="range" min={-60} max={0} step={1} value={gainDb}
                  onChange={(e) => setGainDb(parseInt(e.target.value))}
                  className="flex-1 h-1 bg-apple-border rounded-full appearance-none accent-apple-blue"
                />
              </div>
            </div>

            {children && (
              <div className="pt-2 border-t border-apple-border/50">
                {children}
              </div>
            )}

            <div className="pt-2 border-t border-apple-border/50">
              <button 
                onClick={() => setIsToolsExpanded(!isToolsExpanded)}
                className="w-full flex items-center justify-between py-3 group"
              >
                <div className="flex items-center gap-4">
                   <div className="w-8 h-8 bg-apple-blue/10 text-apple-blue rounded-xl flex items-center justify-center">
                      <Sliders size={14} />
                   </div>
                   <span className="text-[10px] font-black text-system-label uppercase tracking-widest">Audio Optimization</span>
                </div>
                <ChevronRight size={16} className={`text-system-tertiary-label transition-transform ${isToolsExpanded ? 'rotate-90 text-apple-blue' : ''}`} />
              </button>

              <AnimatePresence>
                {isToolsExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden space-y-5 pt-5"
                  >
                     <div className="flex items-center justify-between p-4 bg-system-background rounded-2xl border border-apple-border shadow-sm">
                        <div className="flex flex-col">
                           <span className="text-[9px] font-black text-system-label uppercase tracking-widest">Normalization</span>
                           <span className="text-[8px] font-bold text-system-secondary-label uppercase">{normalize ? 'Perfect Balance' : 'Raw Output'}</span>
                        </div>
                        <button 
                          onClick={() => setNormalize(!normalize)}
                          className={`w-8 h-5 rounded-full relative transition-colors ${normalize ? 'bg-apple-blue' : 'bg-system-tertiary-label'}`}
                        >
                          <motion.div className="absolute top-0.5 left-0.5 bg-white w-4 h-4 rounded-full" animate={{ x: normalize ? 12 : 0 }} />
                        </button>
                     </div>
                     {onApplyPreset && (
                       <div className="grid grid-cols-2 gap-3">
                         <button 
                           onClick={() => onApplyPreset('soft')}
                           className="py-3 rounded-2xl bg-system-background border border-apple-border text-[9px] font-black uppercase tracking-widest text-system-label hover:bg-secondary-system-background transition-all"
                         >
                           Soft Mix
                         </button>
                         <button 
                           onClick={() => onApplyPreset('night')}
                           className="py-3 rounded-2xl bg-system-background border border-apple-border text-[9px] font-black uppercase tracking-widest text-system-label hover:bg-secondary-system-background transition-all"
                         >
                           Binaural Night
                         </button>
                       </div>
                     )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
