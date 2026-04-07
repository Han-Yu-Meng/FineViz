import React, { useMemo } from 'react';
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
  const chartData = useMemo(() => {
    // Process the last 50 messages to render in the chart
    const recentMessages = messages.slice(-50);
    return recentMessages.map((msg, index) => {
      const point: any = { time: msg.receivedAt || index };
      fields.forEach((field) => {
        point[field] = getNestedValue(msg.data, field);
      });
      return point;
    });
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
