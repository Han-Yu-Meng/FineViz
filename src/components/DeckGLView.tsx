import React, { useState, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { OrbitView } from '@deck.gl/core';
import { PointCloudLayer, LineLayer, ScatterplotLayer } from '@deck.gl/layers';
import { AppConfig, Waypoint } from '../hooks/useConfig';

interface DeckGLViewProps {
  config: AppConfig | null;
  waypoints: Waypoint[];
  messages: Record<string, any[]>;
}

const INITIAL_VIEW_STATE = {
  target: [0, 0, 0] as [number, number, number],
  zoom: 1, // Start zoomed out for point cloud
  rotationX: 30,
  rotationOrbit: 0,
};

export function DeckGLView({ config, waypoints, messages }: DeckGLViewProps) {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  
  // Real-time point cloud state
  const [pointCloudData, setPointCloudData] = useState<any[]>([]);
  
  useEffect(() => {
    // Check for /cloud_registered messages
    const cloudMsgs = messages['/cloud_registered'];
    if (cloudMsgs && cloudMsgs.length > 0) {
      const latestMsg = cloudMsgs[cloudMsgs.length - 1];
      const pointCloudMsg = latestMsg.data;
      
      try {
        if (!pointCloudMsg || !pointCloudMsg.fields || !pointCloudMsg.data) {
          return;
        }

        const fields = pointCloudMsg.fields as Array<{ name: string; offset: number }>;
        const xField = fields.find((f) => f.name === 'x');
        const yField = fields.find((f) => f.name === 'y');
        const zField = fields.find((f) => f.name === 'z');
        if (!xField || !yField || !zField) {
          console.warn('PointCloud2 缺少 x/y/z 字段，无法渲染');
          return;
        }

        const rawData = pointCloudMsg.data;
        const bytes = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
        const littleEndian = !pointCloudMsg.is_bigendian;
        const pointStep = pointCloudMsg.point_step as number;
        const totalPoints = Math.min(
          (pointCloudMsg.width as number) * (pointCloudMsg.height as number),
          Math.floor(bytes.byteLength / pointStep),
        );

        const targetMaxPoints = 120000;
        const stride = Math.max(1, Math.ceil(totalPoints / targetMaxPoints));
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const points: Array<{ position: [number, number, number]; color: [number, number, number] }> = [];

        for (let i = 0; i < totalPoints; i += stride) {
          const base = i * pointStep;
          const x = dv.getFloat32(base + xField.offset, littleEndian);
          const y = dv.getFloat32(base + yField.offset, littleEndian);
          const z = dv.getFloat32(base + zField.offset, littleEndian);

          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            continue;
          }

          points.push({
            position: [x, y, z],
            color: [255, 255, 255],
          });
        }

        console.log('点云解码成功:', {
          topic: '/cloud_registered',
          totalPoints,
          renderedPoints: points.length,
          pointStep,
          stride,
        });

        if (points.length > 0) {
          setPointCloudData(points);
        }
      } catch (e) {
        console.error("解析点云失败:", e);
      }
    }
  }, [messages['/cloud_registered']]);

  const [gridLines, setGridLines] = useState<any[]>([]);

  useEffect(() => {
    // Generate grid lines
    const lines = [];
    const size = 20;
    const step = 2;
    for (let i = -size; i <= size; i += step) {
      lines.push({ sourcePosition: [i, -size, 0], targetPosition: [i, size, 0], color: [80, 80, 80, 100] });
      lines.push({ sourcePosition: [-size, i, 0], targetPosition: [size, i, 0], color: [80, 80, 80, 100] });
    }
    // Axes
    lines.push({ sourcePosition: [0, 0, 0], targetPosition: [5, 0, 0], color: [255, 0, 0, 255] }); // X: Red
    lines.push({ sourcePosition: [0, 0, 0], targetPosition: [0, 5, 0], color: [0, 255, 0, 255] }); // Y: Green
    lines.push({ sourcePosition: [0, 0, 0], targetPosition: [0, 0, 5], color: [0, 0, 255, 255] }); // Z: Blue
    setGridLines(lines);
  }, []);

  const layers = [
    new LineLayer({
      id: 'grid-layer',
      data: gridLines,
      getSourcePosition: (d: any) => d.sourcePosition,
      getTargetPosition: (d: any) => d.targetPosition,
      getColor: (d: any) => d.color,
      getWidth: 1,
    }),
    new PointCloudLayer({
      id: 'point-cloud-layer',
      data: pointCloudData, // Use real data
      getPosition: (d: any) => d.position,
      getNormal: [0, 0, 1],
      getColor: (d: any) => d.color,
      sizeUnits: 'pixels',
      pointSize: 0.2,
    }),
    new ScatterplotLayer({
      id: 'waypoints-layer',
      data: waypoints,
      pickable: true,
      opacity: 0.8,
      stroked: true,
      filled: true,
      radiusScale: 1,
      radiusMinPixels: 5,
      radiusMaxPixels: 15,
      lineWidthMinPixels: 2,
      getPosition: (d: Waypoint) => [d.position.x, d.position.y, d.position.z],
      getFillColor: [234, 179, 8], // Yellow
      getLineColor: [255, 255, 255],
      getRadius: 0.5,
    }),
  ];

  return (
    <div
      className="relative w-full h-full bg-[#111111] overflow-hidden"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Grid background pattern */}
      <div 
        className="absolute inset-0 opacity-20 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(#333 1px, transparent 1px)',
          backgroundSize: '20px 20px'
        }}
      />
      
      <DeckGL
        views={new OrbitView({ id: 'orbit', controller: true })}
        viewState={viewState}
        onViewStateChange={({ viewState }) => setViewState(viewState as any)}
        layers={layers}
        getCursor={({ isDragging }) => (isDragging ? 'grabbing' : 'grab')}
      />
      
      {/* Overlay controls or info could go here */}
      <div className="absolute bottom-4 right-4 bg-zinc-900/80 backdrop-blur px-3 py-2 rounded border border-zinc-800 text-xs text-zinc-400 font-mono">
        <div>Target: {viewState.target.map(n => n.toFixed(1)).join(', ')}</div>
        <div>Zoom: {viewState.zoom.toFixed(2)}</div>
      </div>
    </div>
  );
}
