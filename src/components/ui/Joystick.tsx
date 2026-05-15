import React, { useRef, useEffect } from 'react';
import { motion, useMotionValue, useSpring } from 'framer-motion';

interface JoystickProps {
  size?: number;
  stickSize?: number;
  onMove?: (data: { x: number; y: number }) => void;
  onEnd?: () => void;
  disabled?: boolean;
  value?: { x: number; y: number }; // -1 to 1
  label?: string;
  axis?: 'both' | 'x' | 'y';
}

export function Joystick({
  size = 120,
  stickSize = 40,
  onMove,
  onEnd,
  disabled = false,
  value,
  label,
  axis = 'both'
}: JoystickProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  
  // 使用 spring 使回归原点更平滑
  const springConfig = { damping: 20, stiffness: 200 };
  const springX = useSpring(x, springConfig);
  const springY = useSpring(y, springConfig);

  const maxDistance = (size - stickSize) / 2;
  const lastEmitTimeRef = useRef<number>(0);

  // 当外部 value 变化时（手柄模式），同步位置
  useEffect(() => {
    if (value && disabled) {
      x.set(value.x * maxDistance);
      y.set(value.y * maxDistance);
    }
  }, [value, disabled, maxDistance, x, y]);

  const handleDrag = (_: any, info: any) => {
    if (disabled) return;
    
    let dx = info.offset.x;
    let dy = info.offset.y;

    if (axis === 'x') dy = 0;
    if (axis === 'y') dx = 0;

    // 限制在圆圈内
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > maxDistance) {
      const angle = Math.atan2(dy, dx);
      dx = Math.cos(angle) * maxDistance;
      dy = Math.sin(angle) * maxDistance;
    }

    x.set(dx);
    y.set(dy);

    const now = Date.now();
    if (onMove && now - lastEmitTimeRef.current > 30) {
      lastEmitTimeRef.current = now;
      onMove({
        x: dx / maxDistance,
        y: -dy / maxDistance // 取反，因为屏幕 Y 向下
      });
    }
  };

  const handleDragEnd = () => {
    if (disabled) return;
    x.set(0);
    y.set(0);
    if (onEnd) onEnd();
  };

  return (
    <div className="flex flex-col items-center gap-2">
      {label && <span className="text-[10px] font-bold text-slate-400 uppercase">{label}</span>}
      <div 
        ref={containerRef}
        className="relative bg-slate-100 rounded-full border border-slate-200 flex items-center justify-center touch-none"
        style={{ width: size, height: size }}
      >
        {/* 背景十字线 */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-full h-[1px] bg-slate-200" />
          <div className="h-full w-[1px] bg-slate-200" />
        </div>

        {/* 摇杆头 */}
        <motion.div
          drag={!disabled}
          dragConstraints={containerRef}
          dragElastic={0}
          dragMomentum={false}
          onDrag={handleDrag}
          onDragEnd={handleDragEnd}
          style={{ 
            x: disabled ? springX : x, 
            y: disabled ? springY : y,
            width: stickSize,
            height: stickSize
          }}
          className={`rounded-full shadow-lg cursor-grab active:cursor-grabbing z-10 transition-colors ${
            disabled ? 'bg-blue-500/50' : 'bg-white border border-slate-200'
          }`}
        >
          <div className={`w-full h-full rounded-full flex items-center justify-center ${disabled ? 'opacity-50' : ''}`}>
            <div className="w-2 h-2 rounded-full bg-slate-300" />
          </div>
        </motion.div>
      </div>
    </div>
  );
}
