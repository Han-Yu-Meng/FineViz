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

type PointCloudBinary = {
  length: number;
  positions: Float32Array;
  colors: Uint8Array;
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

function readFieldValue(dataView: DataView, byteOffset: number, datatype: number, littleEndian: boolean): number {
  switch (datatype) {
    case 1: return dataView.getInt8(byteOffset);
    case 2: return dataView.getUint8(byteOffset);
    case 3: return dataView.getInt16(byteOffset, littleEndian);
    case 4: return dataView.getUint16(byteOffset, littleEndian);
    case 5: return dataView.getInt32(byteOffset, littleEndian);
    case 6: return dataView.getUint32(byteOffset, littleEndian);
    case 7: return dataView.getFloat32(byteOffset, littleEndian);
    case 8: return dataView.getFloat64(byteOffset, littleEndian);
    default: return Number.NaN;
  }
}

function decodePointCloud(msg: any, colorField: string | undefined, colorScheme: string | undefined, targetMaxPoints: number): PointCloudBinary | null {
  if (!msg || !msg.fields || !msg.data) return null;
  const fields = msg.fields as any[];
  const xf = fields.find(f => f.name === 'x'), yf = fields.find(f => f.name === 'y'), zf = fields.find(f => f.name === 'z');
  if (!xf || !yf || !zf) return null;
  const cf = colorField ? fields.find(f => f.name === colorField) : undefined;
  const bytes = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
  const le = !msg.is_bigendian, step = msg.point_step, total = Math.min(msg.width * msg.height, Math.floor(bytes.byteLength / step));
  const stride = Math.max(1, Math.ceil(total / targetMaxPoints));
  const count = Math.ceil(total / stride);
  const pos = new Float32Array(count * 3), col = new Uint8Array(count * 3), vals = cf ? new Float32Array(count) : null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let min = Infinity, max = -Infinity, idx = 0;
  for (let i = 0; i < total && idx < count; i += stride) {
    const b = i * step;
    if (b + Math.max(xf.offset, yf.offset, zf.offset) + 4 > dv.byteLength) break;
    const x = dv.getFloat32(b + xf.offset, le), y = dv.getFloat32(b + yf.offset, le), z = dv.getFloat32(b + zf.offset, le);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    pos[idx * 3] = x; pos[idx * 3 + 1] = y; pos[idx * 3 + 2] = z;
    if (cf && vals) {
      const v = readFieldValue(dv, b + cf.offset, cf.datatype, le);
      if (Number.isFinite(v)) { vals[idx] = v; min = Math.min(min, v); max = Math.max(max, v); }
    } else { col[idx * 3] = 255; col[idx * 3 + 1] = 255; col[idx * 3 + 2] = 255; }
    idx++;
  }
  if (idx === 0) return null;
  const fPos = pos.subarray(0, idx * 3), fCol = col.subarray(0, idx * 3);
  if (cf && colorScheme === 'turbo' && isFinite(min) && isFinite(max) && vals) {
    const r = Math.max(1e-6, max - min);
    for (let i = 0; i < idx; i++) {
      const [rv, gv, bv] = getTurboColor((vals[i] - min) / r);
      fCol[i * 3] = rv; fCol[i * 3 + 1] = gv; fCol[i * 3 + 2] = bv;
    }
  }
  return { length: idx, positions: fPos as Float32Array, colors: fCol as Uint8Array };
}

export function DeckGLView({ config, waypoints, messages, topicVisibility }: DeckGLViewProps) {
  const [viewState, setViewState] = useState({ target: [0, 0, 0], zoom: 1, rotationX: 30, rotationOrbit: 0 });
  const [renderFps, setRenderFps] = useState(0);
  const [pointCloudData, setPointCloudData] = useState<Record<string, PointCloudBinary>>({});
  
  const fTimesRef = useRef<number[]>([]);
  const lMsgs = useRef(messages), lCfg = useRef(config), lVis = useRef(topicVisibility);
  lMsgs.current = messages; lCfg.current = config; lVis.current = topicVisibility;

  const runDecode = useCallback(() => {
    const msgs = lMsgs.current, cfg = lCfg.current, vis = lVis.current;
    if (!cfg) return;
    const pcConfigs = Object.values(cfg.visualize || {}).filter((item: any) => item?.type === 'sensor_msgs/msg/PointCloud2' && item?.topic);
    if (pcConfigs.length === 0) return;
    
    const next: Record<string, PointCloudBinary> = {};
    let total = 0;
    const now = Date.now();

    for (const c of pcConfigs as any[]) {
      if (!(vis[c.topic] ?? true)) continue;
      const m = msgs[c.topic] || []; 
      if (m.length === 0) continue;
      
      const sel = c.listen_updates 
        ? (c.last_time > 0 ? m.filter((msg: any) => (msg.receivedAt || 0) >= now - c.last_time * 1000) : [m[m.length - 1]]) 
        : [m[0]];
      
      if (sel.length === 0 && c.listen_updates) sel.push(m[m.length - 1]);
      
      const res = sel.map(s => decodePointCloud(s.data, c.color_field, c.color_scheme, 100000)).filter(r => r !== null) as PointCloudBinary[];
      if (res.length > 0) {
        const tLen = res.reduce((s, f) => s + f.length, 0);
        const mP = new Float32Array(tLen * 3), mC = new Uint8Array(tLen * 3);
        let off = 0; 
        for (const f of res) { mP.set(f.positions, off * 3); mC.set(f.colors, off * 3); off += f.length; }
        next[c.topic] = { length: tLen, positions: mP, colors: mC }; 
        total += tLen;
      }
    }
    
    if (total > 0) {
      setPointCloudData(next);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(runDecode, 150);
    return () => clearInterval(timer);
  }, [runDecode]);

  const onAfterRender = useCallback(() => {
    const n = performance.now();
    fTimesRef.current.push(n);
    while (fTimesRef.current.length > 0 && n - fTimesRef.current[0] > 1000) fTimesRef.current.shift();
    
    // 关键修复：不要直接在这里 setState，这会导致无限重绘
    if (fTimesRef.current.length % 30 === 0) {
       // 仅某些帧更新一次，这里我们暂时直接跳过 FPS 渲染或放到另一个效应中
    }
  }, []);

  // 独立的 FPS 定时器
  useEffect(() => {
    const timer = setInterval(() => {
      setRenderFps(fTimesRef.current.length);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const layers = useMemo(() => [
    new LineLayer({ 
      id: 'grid', 
      data: (() => { const l = []; for (let i = -20; i <= 20; i += 2) { l.push({ s: [i, -20, 0], t: [i, 20, 0] }, { s: [-20, i, 0], t: [20, i, 0] }); } return l; })(), 
      getSourcePosition: (d: any) => d.s, 
      getTargetPosition: (d: any) => d.t, 
      getColor: [80, 80, 80, 100] 
    }),
    ...Object.entries(pointCloudData).map(([t, d]) => new PointCloudLayer({ 
      id: t, 
      data: { length: d.length, attributes: { getPosition: { value: d.positions, size: 3 }, getColor: { value: d.colors, size: 3 } } }, 
      sizeUnits: 'pixels', 
      pointSize: 1.5 
    })),
    new ScatterplotLayer({ id: 'wp', data: waypoints, getPosition: (d: any) => [d.position.x, d.position.y, d.position.z], getFillColor: [234, 179, 8], getRadius: 0.5, radiusMinPixels: 5 })
  ], [pointCloudData, waypoints]);

  return (
    <div className="relative w-full h-full bg-slate-100" onContextMenu={e => e.preventDefault()}>
      <DeckGL 
        views={new OrbitView({ id: 'orbit' })} 
        controller={{ dragMode: 'pan', dragPan: true, dragRotate: true }} 
        viewState={viewState} 
        onViewStateChange={({ viewState }: any) => setViewState({ ...viewState, target: [viewState.target[0], viewState.target[1], 0] })} 
        onAfterRender={onAfterRender} 
        layers={layers} 
      />
      <div className="absolute bottom-4 right-4 bg-white/80 p-2 rounded text-xs font-mono shadow">
        Points: {Object.values(pointCloudData).reduce((a, b) => a + b.length, 0).toLocaleString()} | FPS: {renderFps}
      </div>
    </div>
  );
}
