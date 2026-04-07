import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { OrbitView } from '@deck.gl/core';
import { PointCloudLayer, LineLayer, TextLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { AppConfig, Waypoint } from '../hooks/useConfig';
import { Matrix4, Quaternion } from '@math.gl/core';

import { PointCloudBinary, TFLink } from './render/types';
import { decodePointCloud } from './render/pointCloudDecoder';
import { decodeMarkerArray, MarkerPrimitive } from './render/markerDecoder';
import { getFrameMatrix } from './render/tfTreeResolver';

interface DeckGLViewProps {
  config: AppConfig | null;
  waypoints: Waypoint[];
  messages: Record<string, any[]>;
  topicVisibility: Record<string, boolean>;
}

export function DeckGLView({ config, waypoints, messages, topicVisibility }: DeckGLViewProps) {
  const fixedFrame = config?.tf?.fixed_frame || 'map';
  const [viewState, setViewState] = useState({ target: [0, 0, 0], zoom: 1, rotationX: 30, rotationOrbit: 0 });
  const [renderFps, setRenderFps] = useState(0);
  const [pointCloudData, setPointCloudData] = useState<Record<string, PointCloudBinary>>({});
  const [pathData, setPathData] = useState<Record<string, any>>({});
  const [markerData, setMarkerData] = useState<Record<string, Record<string, MarkerPrimitive[]>>>({});
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
        nextPc[c.topic] = { 
          length: tLen, 
          positions: mP, 
          colors: mC, 
          frameId: res[0].frameId,
          pointSize: c.point_size,
          alpha: c.alpha
        };
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

    // --- Update Marker Arrays ---
    const markerConfigs = Object.values(cfg.visualize || {}).filter((item: any) => item?.type === 'visualization_msgs/msg/MarkerArray' && item?.topic);
    const nextMarkers: Record<string, Record<string, MarkerPrimitive[]>> = {};
    for (const c of markerConfigs as any[]) {
      if (!(vis[c.topic] ?? true)) continue;
      const m = msgs[c.topic] || [];
      if (m.length === 0) continue;
      const latestMsg = m[m.length - 1]; // MarkerArray arrays usually redraw fully
      
      const md = decodeMarkerArray(latestMsg.data);
      nextMarkers[c.topic] = md;
    }
    setMarkerData(nextMarkers);

    // --- Update TF Tree ---
    const rawTf = [...(msgs['/tf'] || []), ...(msgs['/tf_static'] || [])];
    if (rawTf.length > 0) {
      setTfTree(prev => {
        const next = { ...prev };
        let changed = false;
        
        // DEBUG: Collect all child frame IDs we see in this decode loop
        const seenFrames = new Set<string>();

        // 性能关键倒序遍历: 在 TF 流达到百赫兹以上时，同一渲染周期内获取几百次历史毫无意义。
        // 反向遍历优先应用最新时间戳帧的坐标，屏蔽冗余旧历史数据！
        for (let i = rawTf.length - 1; i >= 0; i--) {
          const msg = rawTf[i];
          const transforms = msg.data?.transforms || msg.transforms || [];
          for (let j = transforms.length - 1; j >= 0; j--) {
            const t = transforms[j];
            const childFrameId = t.child_frame_id.startsWith('/') ? t.child_frame_id.substring(1) : t.child_frame_id;
            const parentFrameId = t.header.frame_id.startsWith('/') ? t.header.frame_id.substring(1) : t.header.frame_id;
            
            // 一但发现了最新帧的 TF 连接，立刻忽略后续历史帧避免运算灾难
            if (seenFrames.has(childFrameId)) continue;
            seenFrames.add(childFrameId);
            
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
          }
        }

        // Apply configured fixed transforms (helpful for missing /tf_static from bag playback)
        if (cfg.tf?.fixed_transform) {
          Object.entries(cfg.tf.fixed_transform).forEach(([childFrameId, transform]: [string, any]) => {
            if (!next[childFrameId]) {
              next[childFrameId] = {
                parent: transform.parent,
                child: childFrameId,
                position: transform.position,
                rotation: transform.rotation
              };
              changed = true;
            }
          });
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

  // Debug: Print current TF tree nodes
  // useEffect(() => {
  //   if (Object.keys(tfTree).length > 0) {
  //     console.log("[TF Tree Status] Frames in tree:", Object.keys(tfTree));
  //   }
  // }, [tfTree]);

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
      const worldMat = getFrameMatrix(link.child, tfTree, fixedFrame);
      const parentMat = getFrameMatrix(link.parent, tfTree, fixedFrame);
      
      const pos = worldMat.getTranslation();
      const pPos = parentMat.getTranslation();

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
  }, [tfTree, fixedFrame]);

  const layers = useMemo(() => [
    new LineLayer({
      id: 'grid',
      data: (() => { const l = []; for (let i = -20; i <= 20; i += 2) { l.push({ s: [i, -20, 0], t: [i, 20, 0] }, { s: [-20, i, 0], t: [20, i, 0] }); } return l; })(),
      getSourcePosition: (d: any) => d.s,
      getTargetPosition: (d: any) => d.t,
      getColor: [80, 80, 80, 100]
    }),
    ...Object.entries(pointCloudData).map(([t, d]) => {
      const mat4 = getFrameMatrix(d.frameId, tfTree, fixedFrame);
      const modelMatrix = mat4.toArray();
      
      // Debug log for transformation troubleshooting
      if (t.includes('registered') || d.frameId !== fixedFrame) {

        const trans = mat4.getTranslation();
        // console.log(`[PointCloud Debug] topic: ${t}, frame_id: ${d.frameId}, fixed_frame: ${fixedFrame}`);
        // console.log(`[PointCloud Debug] World Matrix Translation: [${trans[0].toFixed(3)}, ${trans[1].toFixed(3)}, ${trans[2].toFixed(3)}]`);
      }

      return new PointCloudLayer({
        id: `${t}-${d.frameId}`, // Include frameId in ID to force layer recreation if frame changes
        data: { length: d.length, attributes: { getPosition: { value: d.positions, size: 3 }, getColor: { value: d.colors, size: 3 } } },
        sizeUnits: 'pixels',
        pointSize: d.pointSize ?? 1.5,
        opacity: d.alpha ?? 1.0,
        modelMatrix: modelMatrix,
        updateTriggers: {
          modelMatrix: [modelMatrix]
        }
      });
    }),
    ...Object.entries(pathData).map(([t, d]) => {
      const mat4 = getFrameMatrix(d.frameId, tfTree, fixedFrame);
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
    ...Object.entries(markerData).flatMap(([t, frames]) => {
      return Object.entries(frames).flatMap(([frameId, markers]) => {
        const mat4 = getFrameMatrix(frameId, tfTree, fixedFrame);
        const modelMatrix = mat4.toArray();

        const layers: any[] = [];
        
        // 2: SPHERE or 8: POINTS. SPHERE gives local pose center, points use array
        const spheres = markers.filter(m => m.type === 2);
        if (spheres.length > 0) {
          layers.push(new ScatterplotLayer({
            id: `marker-sphere-${t}-${frameId}`,
            data: spheres,
            getPosition: (d: MarkerPrimitive) => d.position,
            getFillColor: (d: MarkerPrimitive) => d.color,
            getRadius: (d: MarkerPrimitive) => d.scale[0] / 2, // assume uniform scale or X as radius
            radiusUnits: 'meters',
            modelMatrix: modelMatrix,
            updateTriggers: { modelMatrix: [modelMatrix] }
          }));
        }

        // 4: LINE_STRIP. Use PathLayer. Points are provided in array.
        const lineStrips = markers.filter(m => m.type === 4);
        if (lineStrips.length > 0) {
          layers.push(new PathLayer({
            id: `marker-linestrip-${t}-${frameId}`,
            data: lineStrips,
            getPath: (d: MarkerPrimitive) => d.points,
            getColor: (d: MarkerPrimitive) => d.color,
            getWidth: (d: MarkerPrimitive) => d.scale[0],
            widthUnits: 'meters',
            modelMatrix: modelMatrix,
            updateTriggers: { modelMatrix: [modelMatrix] }
          }));
        }

        // 5: LINE_LIST. Use LineLayer
        const lineLists = markers.filter(m => m.type === 5);
        if (lineLists.length > 0) {
          const linesData = lineLists.flatMap(m => {
            const pairs = [];
            for (let i = 0; i < m.points.length; i += 2) {
              if (i + 1 < m.points.length) {
                pairs.push({
                  source: m.points[i],
                  target: m.points[i + 1],
                  color: m.color,
                  width: m.scale[0]
                });
              }
            }
            return pairs;
          });

          layers.push(new LineLayer({
            id: `marker-linelist-${t}-${frameId}`,
            data: linesData,
            getSourcePosition: (d: any) => d.source,
            getTargetPosition: (d: any) => d.target,
            getColor: (d: any) => d.color,
            getWidth: (d: any) => d.width,
            widthUnits: 'meters',
            modelMatrix: modelMatrix,
            updateTriggers: { modelMatrix: [modelMatrix] }
          }));
        }

        return layers;
      });
    }),
    ...tfLayers
  ], [pointCloudData, pathData, markerData, tfLayers, tfTree, fixedFrame]);

  return (
    <div className="relative w-full h-full bg-slate-100" onContextMenu={e => e.preventDefault()}>
      <DeckGL
        _maxFPS={30}
        views={new OrbitView({ id: 'orbit' })}
        controller={{
          dragMode: 'pan',
          dragPan: true,
          dragRotate: true,
          inertia: false, 
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
