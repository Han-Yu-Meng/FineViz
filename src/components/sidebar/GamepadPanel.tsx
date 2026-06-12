import React from 'react';
import { Gamepad2, Cpu, Activity, MousePointer2, Settings2, AlertTriangle } from 'lucide-react';
import { Joystick } from '../ui/Joystick';

interface GamepadPanelProps {
  gamepadConnected: boolean;
  gamepadId: string;
  v: { x: number; y: number; w: number };
  axes: number[];
  controlMode: 'velocity' | 'target_pose';
  setControlMode: (mode: 'velocity' | 'target_pose') => void;
  eStop: boolean;
  setEStop: (val: boolean) => void;
  manualV: { x: number; y: number; w: number };
  setManualV: React.Dispatch<React.SetStateAction<{ x: number; y: number; w: number }>>;
}

export function GamepadPanel({
  gamepadConnected,
  gamepadId,
  v,
  axes,
  controlMode,
  setControlMode,
  eStop,
  setEStop,
  manualV,
  setManualV
}: GamepadPanelProps) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-4 text-sm text-slate-700 space-y-6 flex-shrink-0">
        <div className="space-y-4">
          
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

        <div className="space-y-4">
          <div className="flex bg-slate-100 p-1 rounded-lg">
            <button
              onClick={() => setControlMode('velocity')}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
                controlMode === 'velocity'
                  ? 'bg-white text-blue-600 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              /cmd_vel
            </button>
            <button
              onClick={() => setControlMode('target_pose')}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
                controlMode === 'target_pose'
                  ? 'bg-white text-blue-600 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              /target_pose
            </button>
          </div>
        </div>

        {/* 急停模式 */}
        <div className="space-y-4">
          <button
            onClick={() => setEStop(!eStop)}
            className={`w-full py-3 px-4 rounded-lg font-bold text-sm transition-all duration-200 ${
              eStop
                ? 'bg-red-600 text-white shadow-lg shadow-red-200 animate-pulse'
                : 'bg-white text-red-600 border-2 border-red-400 hover:bg-red-50 hover:border-red-500'
            }`}
          >
            {eStop ? '⚠ E-STOP ACTIVE — RELEASE' : 'E-STOP'}
          </button>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            <VelocityCard 
              label={controlMode === 'velocity' ? "VX" : "X"} 
              value={v.x} 
              unit={controlMode === 'velocity' ? "m/s" : "m"} 
              color="text-blue-600" 
            />
            <VelocityCard 
              label={controlMode === 'velocity' ? "VY" : "Y"} 
              value={v.y} 
              unit={controlMode === 'velocity' ? "m/s" : "m"} 
              color="text-indigo-600" 
            />
            <VelocityCard 
              label={controlMode === 'velocity' ? "W" : "Yaw"} 
              value={v.w} 
              unit={controlMode === 'velocity' ? "rad/s" : "rad"} 
              color="text-amber-600" 
            />
          </div>
        </div>
      </div>

      {/* Visual Joysticks Area - Full screen height for mobile layout */}
      <div className="flex-1 relative bg-slate-50/50 m-2 rounded-2xl border-2 border-dashed border-slate-200 overflow-hidden flex items-center justify-around px-4 min-h-[300px] touch-none select-none overflow-x-hidden">
        <div className={`flex flex-col items-center justify-center w-1/2 h-full transition-opacity duration-300 ${controlMode === 'target_pose' ? 'opacity-30' : 'opacity-100'}`}>
          <Joystick
            label="Angular (Left)"
            axis="x"
            size={140}
            stickSize={48}
            disabled={eStop || gamepadConnected || controlMode === 'target_pose'}
            value={{ x: gamepadConnected ? (axes[0] || 0) : -manualV.w, y: 0 }}
            onMove={(data) => setManualV(prev => ({ ...prev, w: -data.x }))}
            onEnd={() => setManualV(prev => ({ ...prev, w: 0 }))}
          />
        </div>
        <div className="flex flex-col items-center justify-center w-1/2 h-full">
          <Joystick
            label={controlMode === 'velocity' ? "Linear (Right)" : "Target (Right)"}
            size={140}
            stickSize={48}
            disabled={eStop || gamepadConnected}
            value={{
              x: gamepadConnected ? (axes[2] || 0) : -manualV.y, 
              y: gamepadConnected ? (axes[3] || 0) : -manualV.x 
            }}
            onMove={(data) => setManualV(prev => ({ ...prev, x: data.y, y: -data.x }))}
            onEnd={() => setManualV(prev => ({ ...prev, x: 0, y: 0 }))}
          />
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
