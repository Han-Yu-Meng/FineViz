import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { OrbitView } from '@deck.gl/core';
import { PointCloudLayer, LineLayer, ScatterplotLayer } from '@deck.gl/layers';
import { AppConfig, Waypoint } from '../hooks/useConfig';

interface DeckGLViewProps {
  config: AppConfig | null;
  waypoints: Waypoint[];
  messages: Record<string, any[]>;
  topicVisibility: Record<string, boolean>;
}

type PointCloudConfig = {
  topic: string;
  listen_updates: boolean;
  last_time: number;
  color_field?: string;
  color_scheme?: string;
};

type PointCloudPoint = {
  position: [number, number, number];
  color: [number, number, number];
};

function getTurboColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  const r = 34.61 + x * (1172.33 + x * (-10793.56 + x * (33300.12 + x * (-38394.49 + x * 14825.05))));
  const g = 23.31 + x * (557.33 + x * (1225.33 + x * (-3574.96 + x * (1073.77 + x * 707.56))));
  const b = 27.2 + x * (3211.1 + x * (-15327.97 + x * (27814 + x * (-22569.18 + x * 6838.66))));
  return [
    Math.max(0, Math.min(255, Math.round(r))),
    Math.max(0, Math.min(255, Math.round(g))),
    Math.max(0, Math.min(255, Math.round(b))),
  ];
}

function readFieldValue(
  dataView: DataView,
  byteOffset: number,
  datatype: number,
  littleEndian: boolean,
): number {
  switch (datatype) {
    case 1:
      return dataView.getInt8(byteOffset);
    case 2:
      return dataView.getUint8(byteOffset);
    case 3:
      return dataView.getInt16(byteOffset, littleEndian);
    case 4:
      return dataView.getUint16(byteOffset, littleEndian);
    case 5:
      return dataView.getInt32(byteOffset, littleEndian);
    case 6:
      return dataView.getUint32(byteOffset, littleEndian);
    case 7:
      return dataView.getFloat32(byteOffset, littleEndian);
    case 8:
      return dataView.getFloat64(byteOffset, littleEndian);
    default:
      return Number.NaN;
  }
}

function decodePointCloud(
  pointCloudMsg: any,
  colorField: string | undefined,
  colorScheme: string | undefined,
  targetMaxPoints: number,
): PointCloudPoint[] {
  if (!pointCloudMsg || !pointCloudMsg.fields || !pointCloudMsg.data) {
    return [];
  }

  const fields = pointCloudMsg.fields as Array<{ name: string; offset: number; datatype: number }>;
  const xField = fields.find((f) => f.name === 'x');
  const yField = fields.find((f) => f.name === 'y');
  const zField = fields.find((f) => f.name === 'z');
  if (!xField || !yField || !zField) {
    return [];
  }

  const colorValueField = colorField ? fields.find((f) => f.name === colorField) : undefined;
  const rawData = pointCloudMsg.data;
  const bytes = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
  const littleEndian = !pointCloudMsg.is_bigendian;
  const pointStep = pointCloudMsg.point_step as number;
  const totalPoints = Math.min(
    (pointCloudMsg.width as number) * (pointCloudMsg.height as number),
    Math.floor(bytes.byteLength / pointStep),
  );

  const stride = Math.max(1, Math.ceil(totalPoints / targetMaxPoints));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const temp: Array<{ position: [number, number, number]; value?: number }> = [];

  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < totalPoints; i += stride) {
    const base = i * pointStep;
    const x = dv.getFloat32(base + xField.offset, littleEndian);
    const y = dv.getFloat32(base + yField.offset, littleEndian);
    const z = dv.getFloat32(base + zField.offset, littleEndian);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }

    let value: number | undefined;
    if (colorValueField) {
      value = readFieldValue(dv, base + colorValueField.offset, colorValueField.datatype, littleEndian);
      if (Number.isFinite(value)) {
        minValue = Math.min(minValue, value);
        maxValue = Math.max(maxValue, value);
      } else {
        value = undefined;
      }
    }

    temp.push({
      position: [x, y, z],
      value,
    });
  }

  const useTurbo = colorValueField && colorScheme === 'turbo' && Number.isFinite(minValue) && Number.isFinite(maxValue);
  const range = Math.max(1e-6, maxValue - minValue);

  return temp.map((point) => {
    if (useTurbo && point.value != undefined) {
      const normalized = (point.value - minValue) / range;
      return {
        position: point.position,
        color: getTurboColor(normalized),
      };
    }
    return {
      position: point.position,
      color: [255, 255, 255],
    };
  });
}

const INITIAL_VIEW_STATE = {
  target: [0, 0, 0] as [number, number, number],
  zoom: 1, // Start zoomed out for point cloud
  rotationX: 30,
  rotationOrbit: 0,
};

export function DeckGLView({ config, waypoints, messages, topicVisibility }: DeckGLViewProps) {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [renderFps, setRenderFps] = useState(0);
  const [pointBudget, setPointBudget] = useState(120000);
  const frameTimesRef = useRef<number[]>([]);
  const lastFpsUiUpdateRef = useRef(0);
  const lastBudgetAdjustRef = useRef(0);
  const decodeTimerRef = useRef<number | null>(null);
  const lastDecodeAtRef = useRef(0);
  const latestMessagesRef = useRef(messages);
  const latestPointCloudConfigsRef = useRef<PointCloudConfig[]>([]);
  const latestTopicVisibilityRef = useRef(topicVisibility);
  const latestPointBudgetRef = useRef(pointBudget);

  const handleAfterRender = useCallback(() => {
    const now = performance.now();
    const frameTimes = frameTimesRef.current;
    frameTimes.push(now);
    while (frameTimes.length > 0 && now - frameTimes[0] > 1000) {
      frameTimes.shift();
    }

    const fps = frameTimes.length;

    if (now - lastFpsUiUpdateRef.current > 1000) {
      setRenderFps((prev) => (Math.abs(prev - fps) >= 1 ? fps : prev));
      lastFpsUiUpdateRef.current = now;
    }

    if (now - lastBudgetAdjustRef.current > 2000) {
      setPointBudget((prev) => {
        if (fps < 25) {
          return Math.max(40000, Math.floor(prev * 0.9));
        }
        if (fps > 50) {
          return Math.min(220000, Math.floor(prev * 1.05));
        }
        return prev;
      });
      lastBudgetAdjustRef.current = now;
    }
  }, []);
  const pointCloudConfigs = useMemo(
    () =>
      (Object.values(config?.visualize || {})
        .filter((item: any) => item?.type === 'sensor_msgs/msg/PointCloud2' && item?.topic)
        .map((item: any) => ({
          topic: item.topic,
          listen_updates: Boolean(item.listen_updates),
          last_time: typeof item.last_time === 'number' ? item.last_time : 0,
          color_field: item.color_field,
          color_scheme: item.color_scheme,
        })) as PointCloudConfig[]),
    [config],
  );
  latestMessagesRef.current = messages;
  latestPointCloudConfigsRef.current = pointCloudConfigs;
  latestTopicVisibilityRef.current = topicVisibility;
  latestPointBudgetRef.current = pointBudget;
  
  // Real-time point cloud state
  const [pointCloudDataByTopic, setPointCloudDataByTopic] = useState<Record<string, PointCloudPoint[]>>({});
  
  const runDecode = useCallback(() => {
    const pointCloudConfigs = latestPointCloudConfigsRef.current;
    const messages = latestMessagesRef.current;
    const topicVisibility = latestTopicVisibilityRef.current;
    const pointBudget = latestPointBudgetRef.current;

    if (pointCloudConfigs.length === 0) {
      setPointCloudDataByTopic({});
      return;
    }

    setPointCloudDataByTopic((prev) => {
      const nextByTopic: Record<string, PointCloudPoint[]> = {};
      const now = Date.now();

      for (const cloudConfig of pointCloudConfigs) {
        const topic = cloudConfig.topic;
        if (!(topicVisibility[topic] ?? true)) {
          nextByTopic[topic] = [];
          continue;
        }

        const cloudMsgs = messages[topic] || [];
        if (cloudMsgs.length === 0) {
          nextByTopic[topic] = prev[topic] || [];
          continue;
        }

        let selectedMsgs = cloudMsgs;
        if (cloudConfig.listen_updates) {
          if (cloudConfig.last_time > 0) {
            const cutoff = now - cloudConfig.last_time * 1000;
            selectedMsgs = cloudMsgs.filter((msg: any) => (msg.receivedAt || 0) >= cutoff);
            if (selectedMsgs.length === 0) {
              selectedMsgs = [cloudMsgs[cloudMsgs.length - 1]];
            }
          } else {
            selectedMsgs = [cloudMsgs[cloudMsgs.length - 1]];
          }
        } else {
          if ((prev[topic] || []).length > 0) {
            nextByTopic[topic] = prev[topic];
            continue;
          }
          selectedMsgs = [cloudMsgs[0]];
        }

        const perMessageBudget = Math.max(1000, Math.floor(pointBudget / Math.max(1, selectedMsgs.length)));
        const mergedPoints: PointCloudPoint[] = [];

        for (const msg of selectedMsgs) {
          try {
            const decoded = decodePointCloud(
              msg.data,
              cloudConfig.color_field,
              cloudConfig.color_scheme,
              perMessageBudget,
            );
            mergedPoints.push(...decoded);
          } catch (e) {
            console.error('解析点云失败:', e);
          }
        }

        nextByTopic[topic] = mergedPoints;
      }

      return nextByTopic;
    });
  }, []);

  useEffect(() => {
    const now = performance.now();
    const minDecodeIntervalMs = 120;

    if (decodeTimerRef.current != null) {
      return;
    }

    const elapsed = now - lastDecodeAtRef.current;
    const delay = Math.max(0, minDecodeIntervalMs - elapsed);

    decodeTimerRef.current = window.setTimeout(() => {
      decodeTimerRef.current = null;
      lastDecodeAtRef.current = performance.now();
      runDecode();
    }, delay);
  }, [runDecode, messages, pointCloudConfigs, pointBudget, topicVisibility]);

  useEffect(() => {
    return () => {
      if (decodeTimerRef.current != null) {
        clearTimeout(decodeTimerRef.current);
      }
    };
  }, []);

  const gridLines = useMemo(() => {
    const lines = [];
    const size = 20;
    const step = 2;
    for (let i = -size; i <= size; i += step) {
      lines.push({ sourcePosition: [i, -size, 0], targetPosition: [i, size, 0], color: [80, 80, 80, 100] });
      lines.push({ sourcePosition: [-size, i, 0], targetPosition: [size, i, 0], color: [80, 80, 80, 100] });
    }
    lines.push({ sourcePosition: [0, 0, 0], targetPosition: [5, 0, 0], color: [255, 0, 0, 255] });
    lines.push({ sourcePosition: [0, 0, 0], targetPosition: [0, 5, 0], color: [0, 255, 0, 255] });
    lines.push({ sourcePosition: [0, 0, 0], targetPosition: [0, 0, 5], color: [0, 0, 255, 255] });
    return lines;
  }, []);

  const layers = useMemo(
    () => [
      new LineLayer({
        id: 'grid-layer',
        data: gridLines,
        getSourcePosition: (d: any) => d.sourcePosition,
        getTargetPosition: (d: any) => d.targetPosition,
        getColor: (d: any) => d.color,
        getWidth: 1,
      }),
      ...pointCloudConfigs.map(
        (cloudConfig) =>
          new PointCloudLayer({
            id: `point-cloud-layer-${cloudConfig.topic}`,
            data: pointCloudDataByTopic[cloudConfig.topic] || [],
            getPosition: (d: any) => d.position,
            getNormal: [0, 0, 1],
            getColor: (d: any) => d.color,
            sizeUnits: 'pixels',
            pointSize: 0.5,
          }),
      ),
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
        getFillColor: [234, 179, 8],
        getLineColor: [255, 255, 255],
        getRadius: 0.5,
      }),
    ],
    [gridLines, pointCloudConfigs, pointCloudDataByTopic, waypoints],
  );

  const handleViewStateChange = useCallback(({ viewState }: { viewState: any }) => {
    const nextTarget = Array.isArray(viewState?.target)
      ? [viewState.target[0], viewState.target[1], 0]
      : [0, 0, 0];

    setViewState({
      ...viewState,
      target: nextTarget,
    });
  }, []);

  return (
    <div
      className="relative w-full h-full bg-slate-100 overflow-hidden"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Grid background pattern */}
      <div 
        className="absolute inset-0 opacity-35 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(#94a3b8 1px, transparent 1px)',
          backgroundSize: '20px 20px'
        }}
      />
      
      <DeckGL
        views={new OrbitView({ id: 'orbit' })}
        useDevicePixels={1}
        controller={{
          dragMode: 'pan',
          dragPan: true,
          dragRotate: true,
          touchRotate: true,
          scrollZoom: {
            speed: 0.01,
            smooth: false,
          },
        }}
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        onAfterRender={handleAfterRender}
        layers={layers}
        getCursor={({ isDragging }) => (isDragging ? 'grabbing' : 'grab')}
      />
      
      {/* Overlay controls or info could go here */}
      <div className="absolute bottom-4 right-4 bg-white/85 backdrop-blur px-3 py-2 rounded border border-slate-200 text-xs text-slate-600 font-mono shadow-sm">
        <div>Target: {viewState.target.map(n => n.toFixed(1)).join(', ')}</div>
        <div>Zoom: {viewState.zoom.toFixed(2)}</div>
        <div>Render FPS: {renderFps.toFixed(0)}</div>
        <div>Point Budget: {pointBudget.toLocaleString()}</div>
      </div>
    </div>
  );
}
