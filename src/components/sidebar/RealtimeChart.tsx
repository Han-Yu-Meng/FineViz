import React, { useEffect, useRef } from 'react';

interface RealtimeChartProps {
  topic: string;
  type?: string; 
  fields: string[];
  colors: string[];
  messages: any[];
}

function getNestedValue(obj: any, path: string): number {
  if (!obj) return 0;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      return 0;
    }
  }
  return typeof current === 'number' ? current : 0;
}

// 定义显示的时间跨度：10秒
const TIME_WINDOW_MS = 10000; 

export const RealtimeChart = React.memo(function RealtimeChart({ topic, type, fields, colors, messages }: RealtimeChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<{ time: number; values: number[] }[]>([]);
  const lastTimeRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);

  const performDraw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);

    const data = historyRef.current;
    
    // --- 时间轴逻辑核心 ---
    // 即使没有数据，也要以当前时间作为终点，实现“平滑滚动”
    const now = Date.now();
    const tMax = now;
    const tMin = now - TIME_WINDOW_MS;

    // 1. 计算 Y 轴缩放
    let min = Infinity;
    let max = -Infinity;
    
    // 只根据当前可见窗口内的数据计算 Y 轴高度
    const visibleData = data.filter(d => d.time > tMin);
    
    if (visibleData.length > 0) {
      visibleData.forEach(d => {
        d.values.forEach(v => {
          if (v < min) min = v;
          if (v > max) max = v;
        });
      });
    }

    if (max - min < 0.1) {
      const avg = visibleData.length > 0 ? (max + min) / 2 : 0;
      min = avg - 0.5;
      max = avg + 0.5;
    } else {
      const pad = (max - min) * 0.2;
      min -= pad;
      max += pad;
    }

    const padding = { top: 10, right: 10, bottom: 10, left: 35 };
    const drawW = width - padding.left - padding.right;
    const drawH = height - padding.top - padding.bottom;

    // 2. 绘制网格线
    ctx.strokeStyle = '#f1f5f9';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      const yPos = padding.top + (i / 4) * drawH;
      ctx.moveTo(padding.left, yPos);
      ctx.lineTo(width - padding.right, yPos);
      
      ctx.fillStyle = '#94a3b8';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      const val = max - (i / 4) * (max - min);
      ctx.fillText(val.toFixed(2), padding.left - 4, yPos + 3);
    }
    ctx.stroke();

    // 3. 绘制折线
    if (visibleData.length > 1) {
      fields.forEach((_, fIdx) => {
        ctx.beginPath();
        ctx.strokeStyle = colors[fIdx] || '#8884d8';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';

        visibleData.forEach((d, i) => {
          // 根据时间戳计算 X 坐标：(当前点时间 - 窗口起点) / 窗口总长度
          const x = padding.left + ((d.time - tMin) / TIME_WINDOW_MS) * drawW;
          const y = padding.top + drawH - ((d.values[fIdx] - min) / (max - min)) * drawH;
          
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      });
    }
  };

  useEffect(() => {
    // 处理新消息
    if (messages && messages.length > 0) {
      const lastReceived = lastTimeRef.current;
      const newItems = messages.filter(msg => msg.receivedAt > lastReceived);

      if (newItems.length > 0) {
        newItems.forEach(msg => {
          lastTimeRef.current = Math.max(lastTimeRef.current, msg.receivedAt);
          const values = fields.map(f => getNestedValue(msg.data, f));
          historyRef.current.push({ time: msg.receivedAt, values });
        });
      }
    }

    // 清理过期数据（超过窗口 2 秒的数据彻底删除，防止内存增长）
    const now = Date.now();
    const cutoff = now - TIME_WINDOW_MS - 2000;
    if (historyRef.current.length > 0 && historyRef.current[0].time < cutoff) {
      historyRef.current = historyRef.current.filter(d => d.time > cutoff);
    }

    // 启动/维持渲染循环
    // 因为是基于时间的，即使没有新消息，我们也需要重绘来让曲线向左滚动
    if (!animationFrameRef.current) {
      const loop = () => {
        performDraw();
        animationFrameRef.current = requestAnimationFrame(loop);
      };
      animationFrameRef.current = requestAnimationFrame(loop);
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [messages, fields, topic]);

  useEffect(() => {
    const observer = new ResizeObserver(() => performDraw());
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="h-32 w-full mt-2 relative border-t border-slate-100/50 overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />
    </div>
  );
});