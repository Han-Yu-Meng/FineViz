import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { OrbitView } from '@deck.gl/core';
import { PointCloudLayer, LineLayer, TextLayer, PathLayer } from '@deck.gl/layers';
import { AppConfig, Waypoint } from '../hooks/useConfig';
import { Matrix4, Quaternion, Vector3 } from '@math.gl/core';

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
  frameId: string;
};

interface TFLink {
  parent: string;
  child: string;
  position: [number, number, number];
  rotation: [number, number, number, number]; // quaternion [x, y, z, w]
}

function getTurboColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  const red = 34.61 + x * (1172.33 + x * (-10793.56 + x * (33300.12 + x * (-38394.49 + x * 14825.05))));
  const green = 23.31 + x * (557.33 + x * (1225.33 + x * (-3574.96 + x * (1073.77 + x * 707.56))));
  const blue = 27.2 + x * (3211.1 + x * (-15327.97 + x * (27814 + x * (-22569.18 + x * 6838.66))));
  return [
    Math.max(0, Math.min(255, Math.round(red))),
    Math.max(0, Math.min(255, Math.round(green))),
    Math.max(0, Math.min(255, Math.round(blue))),
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
  const frameId = msg.header?.frame_id || 'map';
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
  return { length: idx, positions: fPos as Float32Array, colors: fCol as Uint8Array, frameId };
}

export function DeckGLView({ config, waypoints, messages, topicVisibility }: DeckGLViewProps) {
  const fixedFrame = config?.tf?.fixed_frame || 'map';
  const [viewState, setViewState] = useState({ target: [0, 0, 0], zoom: 1, rotationX: 30, rotationOrbit: 0 });
  const [renderFps, setRenderFps] = useState(0);
  const [pointCloudData, setPointCloudData] = useState<Record<string, PointCloudBinary>>({});
  const [pathData, setPathData] = useState<Record<string, any>>({});
  const [tfTree, setTfTree] = useState<Record<string, TFLink>>({});

  const fTimesRef = useRef<number[]>([]);
  const lMsgs = useRef(messages);
  const lCfg = useRef(config);
  const lVis = useRef(topicVisibility);
  lMsgs.current = messages; lCfg.current = config; lVis.current = topicVisibility;

  const runDecode = useCallback(() => {
    const msgs = lMsgs.current, cfg = lCfg.current, vis = lVis.current;
    if (!cfg) return;

    // --- Update Point Cloud ---
    const pcConfigs = Object.values(cfg.visualize || {}).filter((item: any) => item?.type === 'sensor_msgs/msg/PointCloud2' && item?.topic);
    const nextPc: Record<string, PointCloudBinary> = {};
    const now = Date.now();
    for (const c of pcConfigs as any[]) {
      if (!(vis[c.topic] ?? true)) continue;
      const m = msgs[c.topic] || [];
      if (m.length === 0) continue;
      const sel = c.listen_updates ? (c.last_time > 0 ? m.filter((msg: any) => (msg.receivedAt || 0) >= now - c.last_time * 1000) : [m[m.length - 1]]) : [m[m.length - 1]];
      
      const res = sel.map(s => {
        const decoded = decodePointCloud(s.data, c.color_field, c.color_scheme, 100000);
        if (decoded && decoded.frameId.startsWith('/')) {
          decoded.frameId = decoded.frameId.substring(1);
        }
        return decoded;
      }).filter(r => r !== null) as PointCloudBinary[];
      if (res.length > 0) {
        const tLen = res.reduce((s, f) => s + f.length, 0);
        const mP = new Float32Array(tLen * 3), mC = new Uint8Array(tLen * 3);
        let off = 0;
        for (const f of res) { mP.set(f.positions, off * 3); mC.set(f.colors, off * 3); off += f.length; }
        nextPc[c.topic] = { length: tLen, positions: mP, colors: mC, frameId: res[0].frameId };
      }
    }
    setPointCloudData(nextPc);

    // --- Update Path Data ---
    const pathConfigs = Object.values(cfg.visualize || {}).filter((item: any) => item?.type === 'nav_msgs/msg/Path' && item?.topic);
    const nextPaths: Record<string, any> = {};
    for (const c of pathConfigs as any[]) {
      if (!(vis[c.topic] ?? true)) continue;
      const m = msgs[c.topic] || [];
      if (m.length === 0) continue;
      
      const sel = c.listen_updates ? (c.last_time > 0 ? m.filter((msg: any) => (msg.receivedAt || 0) >= now - c.last_time * 1000) : [m[m.length - 1]]) : [m[m.length - 1]];
      if (sel.length === 0) continue;

      const latestPathMsg = sel[sel.length - 1];
      if (!latestPathMsg.data?.poses) continue;
      
      const poses = latestPathMsg.data.poses;
      const pathPoints = poses.map((p: any) => [
        p.pose.position.x,
        p.pose.position.y,
        p.pose.position.z || 0
      ]);

      let frameId = latestPathMsg.data.header?.frame_id || 'map';
      if (frameId.startsWith('/')) frameId = frameId.substring(1);

      let r = 93, g = 153, b = 227, a = Math.floor((c.alpha || 1.0) * 255);
      if (c.color && c.color.startsWith('#')) {
        const hex = c.color.substring(1);
        r = parseInt(hex.substring(0, 2), 16) || r;
        g = parseInt(hex.substring(2, 4), 16) || g;
        b = parseInt(hex.substring(4, 6), 16) || b;
      }

      nextPaths[c.topic] = {
        path: pathPoints,
        frameId,
        color: [r, g, b, a],
        width: c.width || 3
      };
    }
    setPathData(nextPaths);

    // --- Update TF Tree ---
    const rawTf = [...(msgs['/tf'] || []), ...(msgs['/tf_static'] || [])];
    if (rawTf.length > 0) {
      setTfTree(prev => {
        const next = { ...prev };
        let changed = false;
        
        // DEBUG: Collect all child frame IDs we see in this decode loop
        const seenFrames = new Set<string>();

        rawTf.forEach(msg => {
          const transforms = msg.data?.transforms || msg.transforms || [];
          transforms.forEach((t: any) => {
            const childFrameId = t.child_frame_id.startsWith('/') ? t.child_frame_id.substring(1) : t.child_frame_id;
            const parentFrameId = t.header.frame_id.startsWith('/') ? t.header.frame_id.substring(1) : t.header.frame_id;
            
            seenFrames.add(`${parentFrameId}->${childFrameId}`);
            
            const existing = next[childFrameId];

            const isDifferent = !existing || 
              existing.parent !== parentFrameId ||
              existing.position[0] !== t.transform.translation.x ||
              existing.position[1] !== t.transform.translation.y ||
              existing.position[2] !== t.transform.translation.z ||
              existing.rotation[0] !== t.transform.rotation.x ||
              existing.rotation[1] !== t.transform.rotation.y ||
              existing.rotation[2] !== t.transform.rotation.z ||
              existing.rotation[3] !== t.transform.rotation.w;

            if (isDifferent) {
              next[childFrameId] = {
                parent: parentFrameId,
                child: childFrameId,
                position: [t.transform.translation.x, t.transform.translation.y, t.transform.translation.z],
                rotation: [t.transform.rotation.x, t.transform.rotation.y, t.transform.rotation.z, t.transform.rotation.w]
              };
              changed = true;
            }
          });
        });
        
        // Log if lidar_odom is missing from the raw messages
        const hasLidarOdom = Array.from(seenFrames).some(f => f.includes('lidar_odom'));
        if (!hasLidarOdom && rawTf.length > 0) {
          console.warn(`[TF Bug Hunt] lidar_odom is completely MISSING from rawTf! Total messages: ${rawTf.length}. Frames present:`, Array.from(seenFrames));
        }

        // Hack: hardcode lidar_odom static transform since rosbag2 tf_static clipping loses it
        if (!next['lidar_odom']) {
          next['lidar_odom'] = {
            parent: 'odom', // as seen in tf2_echo
            child: 'lidar_odom',
            position: [0.550, 0.239, 0.193], // from tf2_echo odom -> lidar_odom
            rotation: [0.011, 0.113, -0.005, 0.994] 
          };
          changed = true;
        }

        return changed ? next : prev;
      });
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
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setRenderFps(fTimesRef.current.length), 1000);
    return () => clearInterval(timer);
  }, []);

  const getFrameMatrix = useCallback((frameId: string, tree: Record<string, TFLink>): Matrix4 => {
    const mat = new Matrix4();
    if (!frameId || frameId === fixedFrame) return mat;

    let current = frameId;
    const path: TFLink[] = [];
    const visited = new Set<string>();

    while (current !== fixedFrame && tree[current]) {
      if (visited.has(current)) break;
      visited.add(current);
      
      const link = tree[current];
      path.push(link);
      current = link.parent;
    }

    if (current !== fixedFrame) {
      if (frameId === 'lidar_odom') {
        console.warn(`[TF Path Failure] Cannot find path from lidar_odom to ${fixedFrame}. Current reached: ${current}. Tree keys:`, Object.keys(tree));
      }
      return new Matrix4(); 
    }

    for (let i = path.length - 1; i >= 0; i--) {
      const link = path[i];
      // 构造从父系到子系的变换矩阵 T_parent_child = Translate(link.position) * Rotate(link.rotation)
      const m = new Matrix4().fromQuaternion(link.rotation);
      m[12] = link.position[0];
      m[13] = link.position[1];
      m[14] = link.position[2];
      
      // 级联变换：mat = mat * m
      mat.multiplyRight(m);
    }
    return mat;
  }, [fixedFrame]);

  // Debug: Print current TF tree nodes
  useEffect(() => {
    if (Object.keys(tfTree).length > 0) {
      console.log("[TF Tree Status] Frames in tree:", Object.keys(tfTree));
    }
  }, [tfTree]);

  const tfLayers = useMemo(() => {
    const links = Object.values(tfTree);
    const lineData: any[] = [];
    const axisData: any[] = [];
    const labelData: any[] = [];

    // Root Axis
    const s = 0.5;
    axisData.push(
      { s: [0, 0, 0], t: [s, 0, 0], color: [255, 0, 0] },
      { s: [0, 0, 0], t: [0, s, 0], color: [0, 255, 0] },
      { s: [0, 0, 0], t: [0, 0, s], color: [0, 0, 255] }
    );
    labelData.push({ text: fixedFrame, position: [0, 0, 0] });

    links.forEach(link => {
      const worldMat = getFrameMatrix(link.child, tfTree);
      const parentMat = getFrameMatrix(link.parent, tfTree);
      
      const pos = worldMat.getTranslation();
      const pPos = parentMat.getTranslation();

      // Debug log for TF Hierarchy visualization
      if (link.child === 'lidar_odom' || link.child === 'odom') {
        console.log(`[TF Debug] link: ${link.parent} -> ${link.child}`);
        console.log(`[TF Debug] World Translation: [${pos[0].toFixed(3)}, ${pos[1].toFixed(3)}, ${pos[2].toFixed(3)}]`);
      }

      lineData.push({ source: pPos, target: pos });

      // Get pure rotation matrix from the world matrix
      const q = new Quaternion();
      worldMat.getRotation(q);
      const rotationMat = new Matrix4().fromQuaternion(q);
      
      const xAxis = rotationMat.transformVector([s, 0, 0]);
      const yAxis = rotationMat.transformVector([0, s, 0]);
      const zAxis = rotationMat.transformVector([0, 0, s]);

      axisData.push(
        { s: pos, t: [pos[0] + xAxis[0], pos[1] + xAxis[1], pos[2] + xAxis[2]], color: [255, 0, 0] },
        { s: pos, t: [pos[0] + yAxis[0], pos[1] + yAxis[1], pos[2] + yAxis[2]], color: [0, 255, 0] },
        { s: pos, t: [pos[0] + zAxis[0], pos[1] + zAxis[1], pos[2] + zAxis[2]], color: [0, 0, 255] }
      );
      labelData.push({ text: link.child, position: pos });
    });

    return [
      new LineLayer({
        id: 'tf-links',
        data: lineData,
        getSourcePosition: d => d.source,
        getTargetPosition: d => d.target,
        getColor: [234, 179, 8, 200],
        getWidth: 2
      }),
      new LineLayer({
        id: 'tf-axes',
        data: axisData,
        getSourcePosition: d => d.s,
        getTargetPosition: d => d.t,
        getColor: d => d.color,
        getWidth: 3
      }),
      new TextLayer({
        id: 'tf-labels',
        data: labelData,
        getPosition: d => d.position,
        getText: d => d.text,
        getSize: 12,
        getColor: [50, 50, 50],
        getPixelOffset: [5, 5]
      })
    ];
  }, [tfTree, getFrameMatrix, fixedFrame]);

  const layers = useMemo(() => [
    new LineLayer({
      id: 'grid',
      data: (() => { const l = []; for (let i = -20; i <= 20; i += 2) { l.push({ s: [i, -20, 0], t: [i, 20, 0] }, { s: [-20, i, 0], t: [20, i, 0] }); } return l; })(),
      getSourcePosition: (d: any) => d.s,
      getTargetPosition: (d: any) => d.t,
      getColor: [80, 80, 80, 100]
    }),
    ...Object.entries(pointCloudData).map(([t, d]) => {
      const mat4 = getFrameMatrix(d.frameId, tfTree);
      const modelMatrix = mat4.toArray();
      
      // Debug log for transformation troubleshooting
      if (t.includes('registered') || d.frameId !== fixedFrame) {
        const trans = mat4.getTranslation();
        console.log(`[PointCloud Debug] topic: ${t}, frame_id: ${d.frameId}, fixed_frame: ${fixedFrame}`);
        console.log(`[PointCloud Debug] World Matrix Translation: [${trans[0].toFixed(3)}, ${trans[1].toFixed(3)}, ${trans[2].toFixed(3)}]`);
      }

      return new PointCloudLayer({
        id: `${t}-${d.frameId}`, // Include frameId in ID to force layer recreation if frame changes
        data: { length: d.length, attributes: { getPosition: { value: d.positions, size: 3 }, getColor: { value: d.colors, size: 3 } } },
        sizeUnits: 'pixels',
        pointSize: 1.5,
        modelMatrix: modelMatrix,
        updateTriggers: {
          modelMatrix: [modelMatrix]
        }
      });
    }),
    ...Object.entries(pathData).map(([t, d]) => {
      const mat4 = getFrameMatrix(d.frameId, tfTree);
      const modelMatrix = mat4.toArray();

      return new PathLayer({
        id: `path-${t}-${d.frameId}`,
        data: [{ path: d.path, color: d.color, width: d.width }],
        pickable: false,
        widthScale: 1,
        widthMinPixels: 2,
        getPath: (p: any) => p.path,
        getColor: (p: any) => p.color,
        getWidth: (p: any) => p.width,
        modelMatrix: modelMatrix,
        updateTriggers: {
          modelMatrix: [modelMatrix]
        }
      });
    }),
    ...tfLayers
  ], [pointCloudData, pathData, tfLayers, getFrameMatrix, tfTree]);

  return (
    <div className="relative w-full h-full bg-slate-100" onContextMenu={e => e.preventDefault()}>
      <DeckGL
        views={new OrbitView({ id: 'orbit' })}
        controller={{
          dragMode: 'pan',
          dragPan: true,
          dragRotate: true,
          inertia: 100,
          scrollZoom: { speed: 0.02, smooth: false },
          touchRotate: true
        }}
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
