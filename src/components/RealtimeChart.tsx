import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from 'recharts';
import { AppConfig } from '../hooks/useConfig';

interface RealtimeChartProps {
  topic: string;
  fields: string[];
  colors: string[];
}

export function RealtimeChart({ topic, fields, colors }: RealtimeChartProps) {
  const [data, setData] = useState<any[]>([]);

  useEffect(() => {
    // Generate some mock data for the chart since we don't have a real backend
    const interval = setInterval(() => {
      setData(prev => {
        const newData = [...prev];
        if (newData.length > 50) newData.shift();
        
        const point: any = { time: new Date().toLocaleTimeString() };
        fields.forEach((field, i) => {
          // Generate a random walk
          const lastVal = prev.length > 0 ? prev[prev.length - 1][field] : 0;
          point[field] = lastVal + (Math.random() - 0.5) * 2;
        });
        
        newData.push(point);
        return newData;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [fields]);

  return (
    <div className="h-48 w-full mt-2">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
          <XAxis dataKey="time" hide />
          <YAxis stroke="#666" tick={{ fill: '#666', fontSize: 10 }} />
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
