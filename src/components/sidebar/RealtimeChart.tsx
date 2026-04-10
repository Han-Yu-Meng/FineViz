import React, { useEffect, useRef } from 'react';

interface RealtimeChartProps {
  topic: string;
  fields: string[];
  colors: string[];
  messages: any[];
}

function getNestedValue(obj: any, path: string): number {
  return path.split('.').reduce((o, key) => (o && o[key] !== undefined ? o[key] : 0), obj) || 0;
}

// 采用 React.memo + HTML5 Canvas 是高频实时图表解决内存溢出/掉帧的终极方案
export const RealtimeChart = React.memo(function RealtimeChart({ topic, fields, colors, messages }: RealtimeChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // 单一数组维护历史数据，不触发 React 状态重绘，绕过 VDOM Diff
  const historyRef = useRef<{ time: number; values: number[] }[]>([]);
  const lastTimeRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);

  const drawChart = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 获取设备物理像素比，防止 Retina 高分屏模糊
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    
    // 如果尺寸为0（例如所在 Tab 隐藏时），直接跳过渲染
    if (rect.width === 0 || rect.height === 0) return;

    // 缩放画布以适应屏幕像素密度
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;

    // 清空画布
    ctx.clearRect(0, 0, width, height);

    const data = historyRef.current;
    if (data.length === 0) return;

    // 计算 Y 轴最大最小值用于自适应缩放
    let min = Infinity;
    let max = -Infinity;
    data.forEach(d => {
      d.values.forEach(v => {
        if (v < min) min = v;
        if (v > max) max = v;
      });
    });

    // 处理无波动或极值情况
    if (min === max) {
      min -= 1;
      max += 1;
    } else if (min === Infinity || max === -Infinity) {
      min = 0;
      max = 1;
    }
    
    // 增加 10% 的上下边距，防止线条贴边
    const pad = (max - min) * 0.1;
    min -= pad;
    max += pad;

    // 绘图区域留白
    const padding = { top: 5, right: 5, bottom: 5, left: 15 };
    const drawW = width - padding.left - padding.right;
    const drawH = height - padding.top - padding.bottom;

    // --- 绘制虚线网格和 Y 轴标签 ---
    ctx.strokeStyle = '#e2e8f0';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const yVal = min + (max - min) * (i / steps);
      const yPos = padding.top + drawH - (i / steps) * drawH;

      // 网格线
      ctx.beginPath();
      ctx.moveTo(padding.left, yPos);
      ctx.lineTo(width - padding.right, yPos);
      ctx.stroke();

      // 轴刻度
      let label = yVal.toFixed(2);
      if (Math.abs(yVal) >= 1000) label = (yVal / 1000).toFixed(1) + 'k';
      ctx.fillText(label, padding.left - 5, yPos);
    }
    ctx.setLineDash([]); // 重置虚线模式，准备画实线

    // --- 绘制数据折线 ---
    if (data.length > 1) {
      const tMin = data[0].time;
      const tMax = data[data.length - 1].time;
      const tRange = Math.max(tMax - tMin, 1);

      fields.forEach((_, fIdx) => {
        ctx.beginPath();
        ctx.strokeStyle = colors[fIdx] || '#8884d8';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        data.forEach((d, i) => {
          const x = padding.left + ((d.time - tMin) / tRange) * drawW;
          const y = padding.top + drawH - ((d.values[fIdx] - min) / (max - min)) * drawH;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        });
        ctx.stroke();
      });
    }
  };

  useEffect(() => {
    if (!messages || messages.length === 0) return;

    let hasNew = false;
    const currentHistory = historyRef.current;
    
    // 只处理未被提取过的新消息
    const newItems = messages.filter(msg => msg.receivedAt > lastTimeRef.current);

    if (newItems.length > 0) {
      newItems.forEach(msg => {
        lastTimeRef.current = Math.max(lastTimeRef.current, msg.receivedAt);
        const values = fields.map(f => getNestedValue(msg.data, f));
        // 将解构出来的轻量级基础数字存入，彻底放手释放原始大体积 msg.data 对象
        currentHistory.push({ time: msg.receivedAt, values });
      });
      hasNew = true;
    }

    if (hasNew) {
      // 限制渲染点数。Canvas渲染极快，这里可以放宽到 150 提升视觉平滑度
      const MAX_POINTS = 150;
      if (currentHistory.length > MAX_POINTS) {
        currentHistory.splice(0, currentHistory.length - MAX_POINTS);
      }
      
      // 使用 Web 原生 requestAnimationFrame 进行重绘节流
      if (!animationFrameRef.current) {
        animationFrameRef.current = requestAnimationFrame(() => {
          drawChart();
          animationFrameRef.current = null;
        });
      }
    }
  }, [messages, fields]);

  // 处理窗体拖动或右侧边栏侧滑动画时的尺寸自适应
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (!animationFrameRef.current) {
        animationFrameRef.current = requestAnimationFrame(() => {
          drawChart();
          animationFrameRef.current = null;
        });
      }
    });
    
    if (canvasRef.current) {
      observer.observe(canvasRef.current);
    }
    
    return () => {
      observer.disconnect();
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  return (
    <div className="h-32 w-full mt-2 relative">
      <canvas 
        ref={canvasRef} 
        className="absolute inset-0 w-full h-full block" 
        style={{ touchAction: 'none' }} 
      />
    </div>
  );
});