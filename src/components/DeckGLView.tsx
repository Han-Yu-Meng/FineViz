import React, { useState, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { OrbitView } from '@deck.gl/core';
import { PointCloudLayer, PathLayer, LineLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { AppConfig, Waypoint } from '../hooks/useConfig';

interface DeckGLViewProps {
  config: AppConfig | null;
  waypoints: Waypoint[];
}

const INITIAL_VIEW_STATE = {
  target: [0, 0, 0],
  zoom: 4,
  rotationX: 60,
  rotationOrbit: 30,
};

export function DeckGLView({ config, waypoints }: DeckGLViewProps) {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  
  // Create some mock data for visualization since we don't have a real backend
  const [mockPoints, setMockPoints] = useState<any[]>([]);
  const [mockPath, setMockPath] = useState<any[]>([]);
  const [gridLines, setGridLines] = useState<any[]>([]);

  useEffect(() => {
    // Generate a mock point cloud (a simple grid/floor)
    const points = [];
    for (let x = -10; x < 10; x += 0.5) {
      for (let y = -10; y < 10; y += 0.5) {
        points.push({
          position: [x, y, Math.sin(x)*0.2 + Math.cos(y)*0.2],
          color: [Math.random() * 255, 150, 200]
        });
      }
    }
    setMockPoints(points);

    // Generate a mock path
    const path = [
      { path: [[0, 0, 0], [2, 2, 0], [5, 2, 0], [5, 5, 0]], color: [93, 153, 227] }
    ];
    setMockPath(path);

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
      data: mockPoints,
      getPosition: (d: any) => d.position,
      getNormal: [0, 0, 1],
      getColor: (d: any) => d.color,
      pointSize: 3,
    }),
    new PathLayer({
      id: 'path-layer',
      data: mockPath,
      pickable: true,
      widthScale: 1,
      widthMinPixels: 2,
      getPath: (d: any) => d.path,
      getColor: (d: any) => d.color,
      getWidth: (d: any) => 5,
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
    new TextLayer({
      id: 'waypoints-text-layer',
      data: waypoints,
      getPosition: (d: Waypoint) => [d.position.x, d.position.y, d.position.z + 0.5],
      getText: (d: Waypoint) => d.name,
      getSize: 16,
      getColor: [255, 255, 255],
      getAngle: 0,
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
      background: true,
      getBackgroundColor: [0, 0, 0, 150],
      backgroundPadding: [4, 4],
    })
  ];

  return (
    <div className="relative w-full h-full bg-[#111111] overflow-hidden">
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
        initialViewState={viewState}
        onViewStateChange={({ viewState }) => setViewState(viewState)}
        controller={true}
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
