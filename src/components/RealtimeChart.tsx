import React, { useEffect, useState, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from 'recharts';

interface RealtimeChartProps {
  topic: string;
  fields: string[];
  colors: string[];
  messages: any[];
}

function getNestedValue(obj: any, path: string): number {
  return path.split('.').reduce((o, key) => (o && o[key] !== 'undefined' ? o[key] : 0), obj) || 0;
}

export function RealtimeChart({ topic, fields, colors, messages }: RealtimeChartProps) {
  const [chartData, setChartData] = useState<any[]>([]);
  const historyRef = useRef<any[]>([]);
  const lastProcessedTime = useRef<number>(0);

  useEffect(() => {
    if (!messages || messages.length === 0) return;
    
    let hasNew = false;
    const currentHistory = historyRef.current;

    for (const msg of messages) {
      if (msg.receivedAt > lastProcessedTime.current) {
        lastProcessedTime.current = msg.receivedAt;
        const point: any = { time: msg.receivedAt };
        fields.forEach((field) => {
          point[field] = getNestedValue(msg.data, field);
        });
        currentHistory.push(point);
        hasNew = true;
      }
    }

    if (hasNew) {
      // 保持图表的平滑滚动记录（例如50~100个采样点）而无需在主循环中维持巨型原始消息对象
      if (currentHistory.length > 50) {
        currentHistory.shift();
      }
      setChartData([...currentHistory]);
    }
  }, [messages, fields]);

  return (
    <div className="h-48 w-full mt-2">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis dataKey="time" hide />
          <YAxis stroke="#94a3b8" tick={{ fill: '#64748b', fontSize: 10 }} width={45} />
          {fields.map((field, idx) => (
            <Line 
              key={field}
              type="monotone" 
              dataKey={field} 
              stroke={colors[idx] || "#8884d8"} 
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
