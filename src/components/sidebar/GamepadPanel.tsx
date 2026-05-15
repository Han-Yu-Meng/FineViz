import React from 'react';
import { Gamepad2, Cpu, Activity, MousePointer2 } from 'lucide-react';
import { Joystick } from '../ui/Joystick';

interface GamepadPanelProps {
  gamepadConnected: boolean;
  gamepadId: string;
  v: { x: number; y: number; w: number };
  axes: number[];
  manualV: { x: number; y: number; w: number };
  setManualV: React.Dispatch<React.SetStateAction<{ x: number; y: number; w: number }>>;
}

export function GamepadPanel({
  gamepadConnected,
  gamepadId,
  v,
  axes,
  manualV,
  setManualV
}: GamepadPanelProps) {
  return (
    <div className="p-4 text-sm text-slate-700 space-y-6">
      <div className="space-y-4">
        <h3 className="font-semibold text-slate-900 border-b border-slate-100 pb-2 flex items-center gap-2">
          {gamepadConnected ? (
            <Gamepad2 size={18} className="text-blue-600" />
          ) : (
            <MousePointer2 size={18} className="text-blue-600" />
          )}
          {gamepadConnected ? 'Gamepad Status' : 'Virtual Joystick'}
        </h3>
        
        <div className="bg-slate-50 rounded-lg p-3 border border-slate-200 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Mode</span>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${gamepadConnected ? 'bg-green-500 animate-pulse' : 'bg-blue-500'}`} />
              <span className="font-medium">
                {gamepadConnected ? 'Gamepad Active' : 'Web Virtual Control'}
              </span>
            </div>
          </div>
          
          {gamepadConnected && (
            <div className="pt-2 border-t border-slate-100">
              <div className="text-[10px] uppercase font-bold text-slate-400 mb-1">Device ID</div>
              <div className="text-xs font-mono text-slate-600 break-all bg-white p-2 rounded border border-slate-100">
                {gamepadId}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Visual Joysticks */}
      <div className="grid grid-cols-2 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200">
        <Joystick 
          label="Angular (Left)"
          axis="x"
          size={100}
          stickSize={32}
          disabled={gamepadConnected}
          value={{ x: gamepadConnected ? (axes[0] || 0) : -manualV.w, y: 0 }}
          onMove={(data) => setManualV(prev => ({ ...prev, w: -data.x }))}
          onEnd={() => setManualV(prev => ({ ...prev, w: 0 }))}
        />
        <Joystick 
          label="Linear (Right)"
          size={100}
          stickSize={32}
          disabled={gamepadConnected}
          value={{ 
            x: gamepadConnected ? (axes[2] || 0) : -manualV.y, 
            y: gamepadConnected ? (axes[3] || 0) : -manualV.x 
          }}
          onMove={(data) => setManualV(prev => ({ ...prev, x: data.y, y: -data.x }))}
          onEnd={() => setManualV(prev => ({ ...prev, x: 0, y: 0 }))}
        />
      </div>

      <div className="space-y-4">
        <h3 className="font-semibold text-slate-900 border-b border-slate-100 pb-2 flex items-center gap-2">
          <Activity size={18} className="text-blue-600" />
          Velocity Output
        </h3>
        <div className="grid grid-cols-3 gap-2">
          <VelocityCard label="VX" value={v.x} unit="m/s" color="text-blue-600" />
          <VelocityCard label="VY" value={v.y} unit="m/s" color="text-indigo-600" />
          <VelocityCard label="W" value={v.w} unit="rad/s" color="text-amber-600" />
        </div>
      </div>
    </div>
  );
}

function VelocityCard({ label, value, unit, color }: { label: string; value: number; unit: string; color: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-2 text-center shadow-sm">
      <div className="text-[10px] font-bold text-slate-400 uppercase">{label}</div>
      <div className={`text-sm font-mono font-bold ${color}`}>
        {value.toFixed(2)}
      </div>
      <div className="text-[9px] text-slate-400">{unit}</div>
    </div>
  );
}
