import React, { useRef, useEffect, useState, useCallback } from 'react';
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
  const pointerIdRef = useRef<number | null>(null);
  
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  
  const springConfig = { damping: 25, stiffness: 300 };
  const springX = useSpring(x, springConfig);
  const springY = useSpring(y, springConfig);

  const maxDistance = (size - stickSize) / 2;

  // 当外部 value 变化时（手柄模式），同步位置
  useEffect(() => {
    if (value && disabled) {
      x.set(value.x * maxDistance);
      y.set(value.y * maxDistance);
    }
  }, [value, disabled, maxDistance, x, y]);

  const updatePosition = useCallback((clientX: number, clientY: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    let dx = clientX - centerX;
    let dy = clientY - centerY;

    if (axis === 'x') dy = 0;
    if (axis === 'y') dx = 0;

    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > maxDistance) {
      const angle = Math.atan2(dy, dx);
      dx = Math.cos(angle) * maxDistance;
      dy = Math.sin(angle) * maxDistance;
    }

    x.set(dx);
    y.set(dy);

    if (onMove) {
      onMove({
        x: dx / maxDistance,
        y: -dy / maxDistance
      });
    }
  }, [axis, maxDistance, onMove, x, y]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    pointerIdRef.current = e.pointerId;
    // 捕获指针，确保即使手指离开元素范围也能继续接收事件
    e.currentTarget.setPointerCapture(e.pointerId);
    updatePosition(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (disabled || pointerIdRef.current !== e.pointerId) return;
    updatePosition(e.clientX, e.clientY);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (disabled || pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    x.set(0);
    y.set(0);
    if (onEnd) onEnd();
  };

  return (
    <div className="flex flex-col items-center gap-2 select-none">
      {label && <span className="text-[10px] font-bold text-slate-400 uppercase pointer-events-none">{label}</span>}
      <div 
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="relative bg-slate-100/80 backdrop-blur-sm rounded-full border border-slate-200 flex items-center justify-center touch-none"
        style={{ 
          width: size, 
          height: size,
          cursor: disabled ? 'default' : 'crosshair'
        }}
      >
        {/* 背景十字线 */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-[1px] h-1/2 bg-slate-200/50" />
          <div className="h-[1px] w-1/2 bg-slate-200/50" />
        </div>

        {/* 摇杆头 */}
        <motion.div
          style={{ 
            x: springX, 
            y: springY,
            width: stickSize,
            height: stickSize
          }}
          className={`rounded-full shadow-lg pointer-events-none transition-colors ${
            disabled ? 'bg-blue-500/50' : 'bg-white border border-slate-200'
          }`}
        >
          <div className="w-full h-full rounded-full flex items-center justify-center">
            <div className={`w-3 h-3 rounded-full ${disabled ? 'bg-white/50' : 'bg-slate-200'}`} />
          </div>
        </motion.div>
      </div>
    </div>
  );
}

