import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { OrbitView } from '@deck.gl/core';
import { PointCloudLayer, LineLayer, TextLayer, PathLayer, ScatterplotLayer, BitmapLayer, GeoJsonLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { AppConfig, Waypoint } from '../hooks/useConfig';
import { Matrix4, Quaternion } from '@math.gl/core';

import { Maximize, Minimize, Crosshair, Navigation, MapPin } from 'lucide-react';
import { PointCloudBinary, TFLink } from './render/types';
import { decodePointCloud } from './render/pointCloudDecoder';
import { decodeMarkerArray, MarkerPrimitive } from './render/markerDecoder';
import { getFrameMatrix } from './render/tfTreeResolver';
import { decodeOccupancyGrid, OccupancyGridData } from './render/occupancyGridDecoder';
import type { OccupancyGridRaw } from './render/types';
import { parseURDF, URDFRobot } from './render/urdfParser';
import { loadGLB } from './render/meshLoader';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';

// 全局共享合并缓冲池，防止高频 new Float32Array
const MAX_COMBINED_POINTS = 500000;
const COMBINED_POSITIONS = new Float32Array(MAX_COMBINED_POINTS * 3);
const COMBINED_COLORS = new Uint8Array(MAX_COMBINED_POINTS * 3);

// ── Web Worker 实例（模块级单例）──
const useWorker = typeof Worker !== 'undefined';
const decoderWorker = useWorker
  ? new Worker(new URL('../workers/decoder.worker.ts', import.meta.url), { type: 'module' })
  : null;

/** 在主线程将 Worker 返回的原始 RGBA 数据写入 Canvas */
function rgbaToCanvas(raw: OccupancyGridRaw): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = raw.width;
  canvas.height = raw.height;
  const ctx = canvas.getContext('2d')!;
  const imgData = new ImageData(raw.rgba, raw.width, raw.height);
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

interface DeckGLViewProps {
  config: AppConfig | null;
  waypoints: Waypoint[];
  messages: Record<string, any[]>;
  topicVisibility: Record<string, boolean>;
  tfVisibility: Record<string, boolean>;
  onSendMessage?: (topic: string, type: string, data: any) => void;
  meshModels: Record<string, any>;
  onMeshModelsChange: (models: Record<string, any>) => void;
  showRobotModel: boolean;
}

export const DeckGLView = React.memo(function DeckGLView({ 
  config, 
  waypoints, 
  messages, 
  topicVisibility, 
  tfVisibility,
  onSendMessage,
  meshModels,
  onMeshModelsChange,
  showRobotModel
}: DeckGLViewProps) {
  const fixedFrame = config?.tf?.fixed_frame || 'map';
  
  const [viewState, setViewState] = useState<{ target: [number, number, number], zoom: number, rotationX: number, rotationOrbit: number }>({ 
    target: [0, 0, 0], 
    zoom: 3.5, 
    rotationX: 30, 
    rotationOrbit: 90 
  });
  const [renderFps, setRenderFps] = useState(0);

  const [worldMatrices, setWorldMatrices] = useState<Record<string, number[]>>({});
  const worldMatricesRef = useRef<Record<string, number[]>>({}); // 用于在回调中无依赖读取

  const [pointCloudData, setPointCloudData] = useState<Record<string, PointCloudBinary>>({});
  const [pathData, setPathData] = useState<Record<string, any>>({});
  const [markerData, setMarkerData] = useState<Record<string, Record<string, MarkerPrimitive[]>>>({});
  const [gridData, setGridData] = useState<Record<string, OccupancyGridData>>({});
  const [tfTree, setTfTree] = useState<Record<string, TFLink>>({});
  const [urdfRobot, setUrdfRobot] = useState<URDFRobot | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isFollowing, setIsFollowing] = useState(true);
  const [followOffset, setFollowOffset] = useState<[number, number, number]>([0, 0, 0]);

  // GeoJSON state
  const [geojsonData, setGeojsonData] = useState<any>(null);
  const [hoveredStationId, setHoveredStationId] = useState<number | string | null>(null);
  const [confirmStation, setConfirmStation] = useState<any>(null);
  const lastGeoJsonRef = useRef<string>('');

  // TripsLayer animation time
  const [currentTime, setCurrentTime] = useState(0);
  useEffect(() => {
    if (!geojsonData) return;
    let animationId: number;
    let lastTime = performance.now();
    const fps = 30; // 限制 30 帧
    const interval = 1000 / fps;

    const animate = (now: number) => {
      animationId = requestAnimationFrame(animate);
      const delta = now - lastTime;
      
      if (delta >= interval) {
        // 补偿微小的帧时间漂移
        lastTime = now - (delta % interval);
        setCurrentTime(t => (t + 0.8) % 100);
      }
    };
    animationId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationId);
  }, [geojsonData]);

  // Goal pose state
  const [isSettingGoal, setIsSettingGoal] = useState(false);
  const [goalPosition, setGoalPosition] = useState<[number, number] | null>(null);
  const [goalYaw, setGoalYaw] = useState<number>(0);

  const isInteractingRef = useRef(false);

  // OccupancyGrid 去重缓存：记录每个 topic 的上次解码时间戳和结果
  const lastGridStampRef = useRef<Record<string, { sec: number; nsec: number }>>({});
  const gridCacheRef = useRef<Record<string, OccupancyGridData>>({});

  // Worker 请求 ID 计数器
  const requestIdRef = useRef(0);

  // Worker 解码结果回调 —— 接收 Transferable 回传数据并写入 React state
  useEffect(() => {
    if (!decoderWorker) return;
    decoderWorker.onmessage = (e: MessageEvent) => {
      const { type, topic, payload } = e.data;
      if (type === 'PC_RESULT') {
        if (payload) {
          if (payload.frameId.startsWith('/')) {
            payload.frameId = payload.frameId.substring(1);
          }
          setPointCloudData(prev => ({ ...prev, [topic]: payload }));
        }
      } else if (type === 'GRID_RESULT') {
        if (payload) {
          const canvas = rgbaToCanvas(payload);
          const data: OccupancyGridData = {
            width: payload.width,
            height: payload.height,
            resolution: payload.resolution,
            origin: payload.origin,
            canvas,
            frameId: payload.frameId,
          };
          gridCacheRef.current[topic] = data;
          setGridData({ ...gridCacheRef.current });
        }
      }
    };
  }, []);

  const dpr = useMemo(() => true, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable fullscreen: ${err.message}`);
      });
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  };

  const fTimesRef = useRef<number[]>([]);
  const lMsgs = useRef(messages);
  const lCfg = useRef(config);
  const lVis = useRef(topicVisibility);
  lMsgs.current = messages; lCfg.current = config; lVis.current = topicVisibility;

  const runDecode = useCallback(() => {
    if (isInteractingRef.current) return;

    const msgs = lMsgs.current, cfg = lCfg.current, vis = lVis.current;
    if (!cfg) return;

    // --- Update Point Cloud (via Web Worker) ---
    const pcConfigs = Object.values(cfg.visualize || {}).filter((item: any) => item?.type === 'sensor_msgs/msg/PointCloud2' && item?.topic);
    const now = Date.now();
    for (const c of pcConfigs as any[]) {
      if (!(vis[c.topic] ?? true)) continue;
      const m = msgs[c.topic] || [];
      
      // 🌟 数据清空逻辑：当消息队列为空，主动清理该话题在视口中的点云
      if (m.length === 0) {
        if (pointCloudData[c.topic]) {
          setPointCloudData(prev => {
            const next = { ...prev };
            delete next[c.topic];
            return next;
          });
        }
        continue;
      }

      const sel = c.listen_updates ? (c.last_time > 0 ? m.filter((msg: any) => (msg.receivedAt || 0) >= now - c.last_time * 1000) : [m[m.length - 1]]) : [m[m.length - 1]];
      
      // 🌟 时效性清理：当时间戳老化后，清除视图中的过期点云
      if (sel.length === 0) {
        if (pointCloudData[c.topic]) {
          setPointCloudData(prev => {
            const next = { ...prev };
            delete next[c.topic];
            return next;
          });
        }
        continue;
      }

      if (decoderWorker) {
        const reqId = ++requestIdRef.current;
        decoderWorker.postMessage({
          id: reqId,
          type: 'PC_BATCH_DECODE',
          topic: c.topic,
          data: sel.map((s: any) => s.data),
          options: {
            colorField: c.color_field,
            colorScheme: c.color_scheme,
            targetMaxPoints: 100000,
            pointSize: c.point_size,
            alpha: c.alpha,
          }
        });
      } else {
        const res = sel.map(s => {
          const decoded = decodePointCloud(s.data, c.color_field, c.color_scheme, 100000);
          if (decoded && decoded.frameId.startsWith('/')) {
            decoded.frameId = decoded.frameId.substring(1);
          }
          return decoded;
        }).filter(r => r !== null) as PointCloudBinary[];

        if (res.length > 0) {
          let totalLen = 0;
          for (const f of res) totalLen += f.length;
          if (totalLen > MAX_COMBINED_POINTS) totalLen = MAX_COMBINED_POINTS;

          let off = 0;
          for (const f of res) {
            if (off + f.length > MAX_COMBINED_POINTS) break;
            COMBINED_POSITIONS.set(f.positions, off * 3);
            COMBINED_COLORS.set(f.colors, off * 3);
            off += f.length;
          }

          const nextPc: Record<string, PointCloudBinary> = {};
          nextPc[c.topic] = {
            length: off,
            positions: COMBINED_POSITIONS.slice(0, off * 3),
            colors: COMBINED_COLORS.slice(0, off * 3),
            frameId: res[0].frameId,
            pointSize: c.point_size,
            alpha: c.alpha
          };
          setPointCloudData(prev => ({ ...prev, ...nextPc }));
        }
      }
    }

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
      const latestMsg = m[m.length - 1];
      
      const md = decodeMarkerArray(latestMsg.data);
      nextMarkers[c.topic] = md;
    }
    setMarkerData(nextMarkers);

    // --- Update Occupancy Grids (via Web Worker) ---
    const gridConfigs = Object.values(cfg.visualize || {}).filter((item: any) => item?.type === 'nav_msgs/msg/OccupancyGrid' && item?.topic);
    for (const c of gridConfigs as any[]) {
      if (!(vis[c.topic] ?? true)) continue;
      const m = msgs[c.topic] || [];
      if (m.length === 0) continue;
      const latestMsg = m[m.length - 1];
      const stamp = latestMsg.data?.header?.stamp;

      if (stamp) {
        const prev = lastGridStampRef.current[c.topic];
        if (prev && prev.sec === stamp.sec && prev.nsec === stamp.nsec) {
          continue;
        }
        lastGridStampRef.current[c.topic] = { sec: stamp.sec, nsec: stamp.nsec };
      }

      if (decoderWorker) {
        const cached = gridCacheRef.current[c.topic];
        const reqId = ++requestIdRef.current;
        decoderWorker.postMessage({
          id: reqId,
          type: 'GRID_DECODE',
          topic: c.topic,
          data: latestMsg.data,
          options: {
            existingWidth: cached?.width,
            existingHeight: cached?.height,
          }
        });
      } else {
        const cached = gridCacheRef.current[c.topic];
        const res = decodeOccupancyGrid(latestMsg.data, cached);
        if (res) {
          gridCacheRef.current[c.topic] = res;
          setGridData({ ...gridCacheRef.current });
        }
      }
    }

    // --- Update GeoJSON from ROS topic ---
    const geojsonConfig = Object.values(cfg.visualize || {}).find((item: any) => item?.topic === '/geojson');
    if (geojsonConfig) {
      const m = msgs[geojsonConfig.topic] || [];
      if (m.length > 0) {
        const latest = m[m.length - 1];
        const jsonStr = latest.data?.data;
        if (jsonStr && typeof jsonStr === 'string' && jsonStr !== lastGeoJsonRef.current) {
          lastGeoJsonRef.current = jsonStr;
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed && parsed.type === 'FeatureCollection') {
              setGeojsonData(parsed);
            }
          } catch {
            console.warn('[GeoJSON] Failed to parse JSON from topic');
          }
        }
      }
    }

    // --- Update TF Tree ---
    const rawTf = [...(msgs['/tf'] || []), ...(msgs['/tf_static'] || [])];
    if (rawTf.length > 0) {
      setTfTree(prev => {
        const next = { ...prev };
        let changed = false;
        const seenFrames = new Set<string>();

        for (let i = rawTf.length - 1; i >= 0; i--) {
          const msg = rawTf[i];
          const transforms = msg.data?.transforms || msg.transforms || [];
          for (let j = transforms.length - 1; j >= 0; j--) {
            const t = transforms[j];
            const childFrameId = t.child_frame_id.startsWith('/') ? t.child_frame_id.substring(1) : t.child_frame_id;
            const parentFrameId = t.header.frame_id.startsWith('/') ? t.header.frame_id.substring(1) : t.header.frame_id;
            
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

        if (changed) {
          const matrices: Record<string, number[]> = {};
          matrices[fixedFrame] = new Matrix4().toArray();
          Object.keys(next).forEach(frameId => {
            matrices[frameId] = getFrameMatrix(frameId, next, fixedFrame).toArray();
          });
          setWorldMatrices(matrices);
          worldMatricesRef.current = matrices;
        }

        return changed ? next : prev;
      });
    }
  }, [fixedFrame, pointCloudData]);

  useEffect(() => {
    if (config?.robot?.urdf) {
      const urdfFullPath = config.robot.urdf;
      const urdfDir = urdfFullPath.substring(0, urdfFullPath.lastIndexOf('/'));
      const fullUrdfPath = `/models/${urdfFullPath}`.replace(/\/+/g, '/');
      fetch(fullUrdfPath)
        .then(r => r.text())
        .then(async xml => {
          const robot = await parseURDF(xml, urdfFullPath);
          setUrdfRobot(robot);
          
          const meshesToLoad = new Set<string>();
          Object.values(robot.links).forEach(link => {
            link.visuals.forEach(v => {
              if (v.geometry.mesh) {
                meshesToLoad.add(v.geometry.mesh.filename);
              }
            });
          });

          const loadedMeshes: Record<string, any> = { ...meshModels };
          for (const meshSubPath of meshesToLoad) {
            try {
              const fullMeshPath = `/models/${urdfDir}/${meshSubPath}`.replace(/\/+/g, '/');
              const mesh = await loadGLB(fullMeshPath);
              loadedMeshes[meshSubPath] = mesh;
            } catch (err) {
              console.warn(`Failed to load mesh ${meshSubPath}`, err);
            }
          }
          onMeshModelsChange(loadedMeshes);
        });
    }
  }, [config?.robot?.urdf]);

  useEffect(() => {
    const timer = setInterval(runDecode, 100);
    return () => clearInterval(timer);
  }, [runDecode]);

  useEffect(() => {
    if (isFollowing) {
      const robotFrame = config?.robot?.base_frame || 'base_link';
      if (!tfTree[robotFrame]) return;
      
      const worldMat = getFrameMatrix(robotFrame, tfTree, fixedFrame);
      const pos = worldMat.transform([0, 0, 0]);
      
      setViewState(prev => {
        const targetX = pos[0] + followOffset[0];
        const targetY = pos[1] + followOffset[1];
        
        if (Math.abs(prev.target[0] - targetX) < 1e-4 && Math.abs(prev.target[1] - targetY) < 1e-4) return prev;
        return {
          ...prev,
          target: [targetX, targetY, 0]
        };
      });
    }
  }, [isFollowing, tfTree, fixedFrame, followOffset, config?.robot?.base_frame]);

  useEffect(() => {
    if (isFollowing) {
      setFollowOffset([0, 0, 0]);
    }
  }, [isFollowing]);

  const onAfterRender = useCallback(() => {
    const n = performance.now();
    fTimesRef.current.push(n);
    while (fTimesRef.current.length > 0 && n - fTimesRef.current[0] > 1000) fTimesRef.current.shift();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setRenderFps(fTimesRef.current.length), 1000);
    return () => clearInterval(timer);
  }, []);

  const tfLayers = useMemo(() => {
    const links = Object.values(tfTree);
    const lineData: any[] = [];
    const axisData: any[] = [];
    const labelData: any[] = [];

    const axisLength = config?.tf?.axis_length ?? 0.5;
    const axisWidth = config?.tf?.axis_width ?? 0.05;
    const labelVisualize = config?.tf?.axis_label_visualize ?? true;

    axisData.push(
      { s: [0, 0, 0], t: [axisLength, 0, 0], color: [255, 0, 0] },
      { s: [0, 0, 0], t: [0, axisLength, 0], color: [0, 255, 0] },
      { s: [0, 0, 0], t: [0, 0, axisLength], color: [0, 0, 255] }
    );
    if (labelVisualize) {
      labelData.push({ text: fixedFrame, position: [0, 0, 0] });
    }

    links.forEach(link => {
      const isHidden = tfVisibility[link.child] !== undefined 
        ? !tfVisibility[link.child] 
        : (config?.tf?.hidden_frame || []).includes(link.child);

      if (isHidden) return;

      const worldMat = getFrameMatrix(link.child, tfTree, fixedFrame);
      const parentMat = getFrameMatrix(link.parent, tfTree, fixedFrame);
      
      const pos = worldMat.transform([0, 0, 0]);
      const pPos = parentMat.transform([0, 0, 0]);

      lineData.push({ source: pPos, target: pos });

      const xTip = worldMat.transform([axisLength, 0, 0]);
      const yTip = worldMat.transform([0, axisLength, 0]);
      const zTip = worldMat.transform([0, 0, axisLength]);

      axisData.push(
        { s: pos, t: xTip, color: [255, 0, 0] },
        { s: pos, t: yTip, color: [0, 255, 0] },
        { s: pos, t: zTip, color: [0, 0, 255] }
      );
      if (labelVisualize) {
        labelData.push({ text: link.child, position: pos });
      }
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
        getWidth: axisWidth * 100
      }),
      new TextLayer({
        id: 'tf-labels',
        data: labelData,
        getPosition: d => d.position,
        getText: d => d.text,
        getSize: 12,
        getColor: [50, 50, 50],
        getPixelOffset: [5, 5],
        background: true,
        getBackgroundColor: [255, 255, 255, 180],
        backgroundPadding: [4, 2]
      })
    ];
  }, [tfTree, fixedFrame, config?.tf, tfVisibility]);

  const onViewStateChange = useCallback(({ viewState: nextViewState }: any) => {
    const rotationX = Math.max(0, Math.min(85, nextViewState.rotationX));
    if (isFollowing) {
      const robotFrame = config?.robot?.base_frame || 'base_link';
      const mat = worldMatricesRef.current[robotFrame];
      if (mat) {
        const newOffset: [number, number, number] = [
          nextViewState.target[0] - mat[12],
          nextViewState.target[1] - mat[13],
          0
        ];
        setFollowOffset(newOffset);
      }
    }
    setViewState({ ...nextViewState, rotationX, target: [nextViewState.target[0], nextViewState.target[1], 0] });
  }, [isFollowing, config?.robot?.base_frame]);

  const getGroundCoordinate = useCallback((info: any): [number, number] | null => {
    const viewport = info.viewport;
    if (viewport && viewport.unproject && viewport.cameraPosition) {
      const pFocal = viewport.unproject([info.x, info.y]);
      const cameraPos = viewport.cameraPosition;
      if (pFocal && cameraPos) {
        const dirX = pFocal[0] - cameraPos[0];
        const dirY = pFocal[1] - cameraPos[1];
        const dirZ = pFocal[2] - cameraPos[2];
        if (dirZ < -1e-6) {
          const t = -cameraPos[2] / dirZ;
          return [cameraPos[0] + t * dirX, cameraPos[1] + t * dirY];
        }
      }
    }
    if (info.coordinate) {
      return [info.coordinate[0], info.coordinate[1]];
    }
    return null;
  }, []);

  const onDragStart = useCallback((info: any) => {
    if (isSettingGoal && !goalPosition) {
      const groundPos = getGroundCoordinate(info);
      if (groundPos) {
        setGoalPosition(groundPos);
        return true;
      }
    }
  }, [isSettingGoal, goalPosition, getGroundCoordinate]);

  const onDrag = useCallback((info: any) => {
    if (isSettingGoal && goalPosition) {
      const groundPos = getGroundCoordinate(info);
      if (groundPos) {
        const dx = groundPos[0] - goalPosition[0];
        const dy = groundPos[1] - goalPosition[1];
        setGoalYaw(Math.atan2(dy, dx));
      }
      return true;
    }
  }, [isSettingGoal, goalPosition, getGroundCoordinate]);

  const onDragEnd = useCallback(() => {
    if (isSettingGoal && goalPosition) {
      const qz = Math.sin(goalYaw / 2);
      const qw = Math.cos(goalYaw / 2);
      const poseData = {
        header: {
          frame_id: fixedFrame,
          stamp: { sec: Math.floor(Date.now() / 1000), nanosec: (Date.now() % 1000) * 1000000 }
        },
        pose: {
          position: { x: goalPosition[0], y: goalPosition[1], z: 0 },
          orientation: { x: 0, y: 0, z: qz, w: qw }
        }
      };
      onSendMessage?.('/goal_pose', 'geometry_msgs/msg/PoseStamped', poseData);
      setIsSettingGoal(false);
      setGoalPosition(null);
      setGoalYaw(0);
    }
  }, [isSettingGoal, goalPosition, goalYaw, fixedFrame, onSendMessage]);

  const computeStationYaw = useCallback((feature: any): number => {
    const coords = feature.geometry.coordinates;
    if (!geojsonData) return 0;
    const lineStrings = geojsonData.features.filter((f: any) => f.geometry.type === 'LineString');
    for (const ls of lineStrings) {
      const lineCoords = ls.geometry.coordinates;
      const idx = lineCoords.findIndex((c: any) => Math.abs(c[0] - coords[0]) < 1e-4 && Math.abs(c[1] - coords[1]) < 1e-4);
      if (idx !== -1) {
        if (idx < lineCoords.length - 1) {
          const nextPoint = lineCoords[idx + 1];
          return Math.atan2(nextPoint[1] - coords[1], nextPoint[0] - coords[0]);
        } else if (idx > 0) {
          const prevPoint = lineCoords[idx - 1];
          return Math.atan2(coords[1] - prevPoint[1], coords[0] - prevPoint[0]);
        }
        break;
      }
    }
    return 0;
  }, [geojsonData]);

  const handleStationClick = useCallback((feature: any) => {
    if (feature && feature.geometry?.type === 'Point') {
      setConfirmStation(feature);
    }
  }, []);

  const confirmSendGoal = useCallback(() => {
    if (!confirmStation) return;
    const coords = confirmStation.geometry.coordinates;
    const yaw = computeStationYaw(confirmStation);
    const qz = Math.sin(yaw / 2);
    const qw = Math.cos(yaw / 2);
    const poseData = {
      header: {
        frame_id: fixedFrame,
        stamp: { sec: Math.floor(Date.now() / 1000), nanosec: (Date.now() % 1000) * 1000000 }
      },
      pose: {
        position: { x: coords[0], y: coords[1], z: coords[2] || 0 },
        orientation: { x: 0, y: 0, z: qz, w: qw }
      }
    };
    onSendMessage?.('/goal_pose', 'geometry_msgs/msg/PoseStamped', poseData);
    setConfirmStation(null);
  }, [confirmStation, computeStationYaw, fixedFrame, onSendMessage]);

  const tripsData = useMemo(() => {
    if (!geojsonData) return [];
    const lineStrings = geojsonData.features.filter((f: any) => f.geometry.type === 'LineString');
    return lineStrings.map((feature: any, index: number) => {
      const coordinates = feature.geometry.coordinates;
      const count = coordinates.length;
      const timestamps = coordinates.map((_: any, i: number) => (i / (count - 1)) * 100);
      return {
        id: feature.properties?.id || index,
        path: coordinates,
        timestamps,
        color: feature.properties?.color || [99, 102, 241],
      };
    });
  }, [geojsonData]);

  // 🌟 [优化核心 1/3]: 提取重度、数据量大的「静态图层」列表（绝对不依赖 currentTime）
  const staticLayers = useMemo(() => {
    const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    const allGridLayers = Object.entries(gridData).map(([t, d]) => {
      if (!d || d.width <= 0 || d.height <= 0) return null;
      const vConfigs = config?.visualize || {};
      const topicConfig = Object.entries(vConfigs).find(([_, c]: [string, any]) => c.topic === t)?.[1] as any;
      const alpha = topicConfig?.alpha ?? 1.0;

      const matArray = worldMatrices[d.frameId] || worldMatrices[fixedFrame] || new Matrix4().toArray();
      const baseMat = new Matrix4(matArray);
      const originMat = new Matrix4().translate(d.origin.position).multiplyRight(new Matrix4().fromQuaternion(d.origin.orientation));
      const finalMat = baseMat.multiplyRight(originMat);
      
      return new BitmapLayer({
        id: `grid-${t}-${d.frameId}-${d.width}-${d.height}`,
        image: d.canvas,
        bounds: [0, 0, d.width * d.resolution, d.height * d.resolution],
        modelMatrix: finalMat as any,
        opacity: alpha,
        pickable: false,
        transparentColor: [0, 0, 0, 0],
        textureParameters: { 
          minFilter: 'nearest', 
          magFilter: 'nearest', 
          mipmaps: false, 
          wrapS: 'clamp-to-edge', 
          wrapT: 'clamp-to-edge' 
        },
        updateTriggers: { 
          image: [d.canvas],
          opacity: [alpha] 
        }
      });
    }).filter(Boolean);

    const behindTopics = new Set(
      Object.entries(config?.visualize || {})
        .filter(([_, c]: [string, any]) => c.draw_behind === true)
        .map(([_, c]: [string, any]) => c.topic)
    );

    const behindGrids = allGridLayers.filter(l => behindTopics.has((l?.id as string).split('-')[1]));
    const normalGrids = allGridLayers.filter(l => !behindTopics.has((l?.id as string).split('-')[1]));

    const dataLayers = [
      ...Object.entries(pointCloudData).map(([t, d]) => {
        const matArray = worldMatrices[d.frameId] || worldMatrices[fixedFrame] || new Matrix4().toArray();
        return new PointCloudLayer({
          id: `${t}-${d.frameId}`,
          data: { length: d.length, attributes: { getPosition: { value: d.positions, size: 3 }, getColor: { value: d.colors, size: 3 } } },
          sizeUnits: 'pixels', 
          pointSize: d.pointSize ?? (isMobileDevice ? 1 : 1.5),
          opacity: d.alpha ?? 1.0, 
          modelMatrix: matArray as any,
          pickable: false,
          parameters: { depthTest: true, depthMask: true },
          updateTriggers: { modelMatrix: matArray }
        });
      }),
      ...Object.entries(pathData).map(([t, d]) => {
        const matArray = worldMatrices[d.frameId] || worldMatrices[fixedFrame] || new Matrix4().toArray();
        return new PathLayer({
          id: `path-${t}-${d.frameId}`,
          data: [{ path: d.path, color: d.color, width: d.width }],
          pickable: false, widthScale: 1, widthMinPixels: 2, getPath: (p: any) => p.path, getColor: (p: any) => p.color, getWidth: (p: any) => p.width,
          modelMatrix: matArray as any, updateTriggers: { modelMatrix: matArray }
        });
      }),
      ...Object.entries(markerData).flatMap(([t, frames]) => {
        return Object.entries(frames).flatMap(([frameId, markers]) => {
          const matArray = worldMatrices[frameId] || worldMatrices[fixedFrame] || new Matrix4().toArray();
          const subLayers: any[] = [];
          const spheres = markers.filter(m => m.type === 2);
          if (spheres.length > 0) subLayers.push(new ScatterplotLayer({
            id: `marker-sphere-${t}-${frameId}`, data: spheres, getPosition: (d: MarkerPrimitive) => d.position, getFillColor: (d: MarkerPrimitive) => d.color, getRadius: (d: MarkerPrimitive) => d.scale[0] / 2, radiusUnits: 'meters', modelMatrix: matArray as any, updateTriggers: { modelMatrix: matArray }
          }));
          const lineStrips = markers.filter(m => m.type === 4);
          if (lineStrips.length > 0) subLayers.push(new PathLayer({
            id: `marker-linestrip-${t}-${frameId}`, data: lineStrips, getPath: (d: MarkerPrimitive) => d.points, getColor: (d: MarkerPrimitive) => d.color, getWidth: (d: MarkerPrimitive) => d.scale[0], widthUnits: 'meters', modelMatrix: matArray as any, updateTriggers: { modelMatrix: matArray }
          }));
          const lineLists = markers.filter(m => m.type === 5);
          if (lineLists.length > 0) {
            const linesData = lineLists.flatMap(m => {
              const pairs = [];
              for (let i = 0; i < m.points.length; i += 2) if (i + 1 < m.points.length) pairs.push({ source: m.points[i], target: m.points[i + 1], color: m.color, width: m.scale[0] });
              return pairs;
            });
            subLayers.push(new LineLayer({
              id: `marker-linelist-${t}-${frameId}`, data: linesData, getSourcePosition: (d: any) => d.source, getTargetPosition: (d: any) => d.target, getColor: (d: any) => d.color, getWidth: (d: any) => d.width, widthUnits: 'meters', modelMatrix: matArray as any, updateTriggers: { modelMatrix: matArray }
            }));
          }
          return subLayers;
        });
      }),
    ];

    const robotLayers: any[] = [];
    if (urdfRobot && showRobotModel) {
      const defaultWorldMatrices: Record<string, Matrix4> = {};
      const baseFrame = config?.robot?.base_frame || Object.keys(urdfRobot.links)[0];

      if (baseFrame && urdfRobot.links[baseFrame]) {
        defaultWorldMatrices[baseFrame] = new Matrix4();
        const computeDefaultPose = (parentName: string) => {
          Object.values(urdfRobot.joints).forEach(joint => {
            const pName = String(joint.parent);
            const cName = String(joint.child);
            if (pName === parentName && !defaultWorldMatrices[cName]) {
              const r = joint.origin.rpy[0];
              const p = joint.origin.rpy[1];
              const y = joint.origin.rpy[2];
              const q = new Quaternion().rotateX(r).rotateY(p).rotateZ(y);
              const localMat = new Matrix4().translate(joint.origin.xyz).multiplyRight(new Matrix4().fromQuaternion(q));
              defaultWorldMatrices[cName] = new Matrix4(defaultWorldMatrices[parentName]).multiplyRight(localMat);
              computeDefaultPose(cName);
            }
          });
        };
        computeDefaultPose(baseFrame);
      }

      Object.keys(urdfRobot.links).forEach(linkName => {
        const link = urdfRobot.links[linkName];
        let matArray = worldMatrices[linkName] || defaultWorldMatrices[linkName]?.toArray() || worldMatrices[fixedFrame] || new Matrix4().toArray();
        if (!matArray) return;
        
        link.visuals.forEach((v, idx) => {
          if (v.geometry.mesh && meshModels[v.geometry.mesh.filename]) {
             const visualMat = new Matrix4(matArray);
             const r = v.origin.rpy[0];
             const p = v.origin.rpy[1];
             const y = v.origin.rpy[2];
             const q = new Quaternion().rotateX(r).rotateY(p).rotateZ(y);
             const localMat = new Matrix4().translate(v.origin.xyz).multiplyRight(new Matrix4().fromQuaternion(q));
             const finalMat = visualMat.multiplyRight(localMat);
             
             robotLayers.push(new SimpleMeshLayer({
                id: `urdf-${linkName}-${idx}`,
                data: [{}],
                mesh: meshModels[v.geometry.mesh.filename],
                modelMatrix: finalMat as any,
                getColor: d => [255, 255, 255],
                sizeScale: 1.0, 
                pickable: false,
                updateTriggers: { modelMatrix: finalMat.toArray() }
              }));
          }
        });
      });
    }

    const goalLayer = goalPosition && isSettingGoal ? [
      new PathLayer({
        id: 'goal-arrow-composite',
        data: [
          {
            path: [[goalPosition[0], goalPosition[1], 0.1], [goalPosition[0] + Math.cos(goalYaw) * 1.0, goalPosition[1] + Math.sin(goalYaw) * 1.0, 0.1]],
            width: 0.1,
          },
          {
            path: [
              [goalPosition[0] + Math.cos(goalYaw) * 1.0 + Math.cos(goalYaw + Math.PI * 0.85) * 0.25, goalPosition[1] + Math.sin(goalYaw) * 1.0 + Math.sin(goalYaw + Math.PI * 0.85) * 0.25, 0.1],
              [goalPosition[0] + Math.cos(goalYaw) * 1.0, goalPosition[1] + Math.sin(goalYaw) * 1.0, 0.1],
              [goalPosition[0] + Math.cos(goalYaw) * 1.0 + Math.cos(goalYaw - Math.PI * 0.85) * 0.25, goalPosition[1] + Math.sin(goalYaw) * 1.0 + Math.sin(goalYaw - Math.PI * 0.85) * 0.25, 0.1],
              [goalPosition[0] + Math.cos(goalYaw) * 1.0 + Math.cos(goalYaw + Math.PI * 0.85) * 0.25, goalPosition[1] + Math.sin(goalYaw) * 1.0 + Math.sin(goalYaw + Math.PI * 0.85) * 0.25, 0.1]
            ],
            width: 0.1,
          }
        ],
        getPath: (d: any) => d.path,
        getColor: [255, 50, 50, 255],
        getWidth: (d: any) => d.width,
        widthMinPixels: 2,
        pickable: false,
      })
    ] : [];

    return [
      new LineLayer({
        id: 'grid-bg',
        data: (() => { const l = []; for (let i = -20; i <= 20; i += 2) l.push({ s: [i, -20, 0], t: [i, 20, 0] }, { s: [-20, i, 0], t: [20, i, 0] }); return l; })(),
        getSourcePosition: (d: any) => d.s, getTargetPosition: (d: any) => d.t, getColor: [80, 80, 80, 100]
      }),
      ...behindGrids,
      ...dataLayers,
      ...normalGrids,
      ...robotLayers,
      ...tfLayers,
      ...goalLayer,
    ].filter(Boolean);
  }, [pointCloudData, pathData, markerData, gridData, tfLayers, worldMatrices, fixedFrame, config?.visualize, goalPosition, goalYaw, isSettingGoal, urdfRobot, meshModels, showRobotModel]);

  // 🌟 [优化核心 2/3]: 提取高频依赖 currentTime 且极度轻量的「动态图层」
  const dynamicLayers = useMemo(() => {
    return [
      new TripsLayer({
        id: 'topo-flow',
        data: tripsData,
        getPath: (d: any) => d.path,
        getTimestamps: (d: any) => d.timestamps,
        getColor: (d: any) => d.color,
        opacity: 0.8,
        widthUnits: 'meters',
        getWidth: 0.1,
        widthMinPixels: 2,
        rounded: true,
        trailLength: 30,
        currentTime,
        shadowEnabled: false,
      }),
      new GeoJsonLayer({
        id: 'geojson-topological',
        data: geojsonData,
        pickable: true,
        stroked: true,
        filled: true,
        pointType: 'circle+text',
        lineWidthUnits: 'meters',
        getLineWidth: 0.12,
        lineWidthMinPixels: 1,
        getLineColor: [180, 198, 252, 120],
        getPointRadius: (f: any) => (f.properties?.id === hoveredStationId ? 8 : 5),
        pointRadiusUnits: 'pixels',
        getFillColor: (f: any) => (f.properties?.id === hoveredStationId ? [59, 130, 246] : [255, 255, 255]),
        getText: (f: any) => f.properties?.frame || f.properties?.id?.toString() || '',
        getTextSize: (f: any) => (f.properties?.id === hoveredStationId ? 18 : 14),
        getTextColor: (f: any) => (f.properties?.id === hoveredStationId ? [37, 99, 235] : [30, 41, 59]),
        getTextAnchor: 'middle',
        getTextAlignmentBaseline: 'bottom',
        getTextPixelOffset: [0, -20],
        getTextBackgroundColor: [255, 255, 255, 220],
        textBackgroundPadding: [4, 2],
        _subLayerProps: { text: { fontWeight: 'bold' } },
        onHover: (info: any) => {
          if (info.object && info.object.geometry?.type === 'Point') {
            setHoveredStationId(info.object.properties?.id ?? null);
          } else {
            setHoveredStationId(null);
          }
        },
        onClick: (info: any) => {
          if (info.object && info.object.geometry?.type === 'Point') {
            handleStationClick(info.object);
          }
        },
        updateTriggers: {
          data: [geojsonData],
          getPointRadius: [hoveredStationId],
          getFillColor: [hoveredStationId],
          getTextSize: [hoveredStationId],
          getTextColor: [hoveredStationId],
        },
        parameters: { depthTest: true },
      })
    ].filter(Boolean);
  }, [geojsonData, hoveredStationId, handleStationClick, tripsData, currentTime]);

  // 🌟 [优化核心 3/3]: 采用极速引用组合。因为 staticLayers 数组内的对象引用地址在动画期间完全没有变，
  // Deck.gl 会在底层自动跳过点云、地图、模型的 Diff 比对和渲染管线重建，CPU 渲染开销直接降低两个数量级。
  const layers = useMemo(() => {
    return [...staticLayers, ...dynamicLayers];
  }, [staticLayers, dynamicLayers]);

  return (
    <div className="relative w-full h-full bg-slate-100" onContextMenu={e => e.preventDefault()}>
      <DeckGL
        views={new OrbitView({ id: 'orbit' })}
        useDevicePixels={dpr}
        controller={{
          dragMode: isSettingGoal ? 'rotate' : 'pan',
          dragPan: !isSettingGoal,
          dragRotate: !isSettingGoal,
          inertia: false, 
          scrollZoom: { speed: 0.005, smooth: false },
          touchRotate: !isSettingGoal
        }}
        viewState={viewState}
        onViewStateChange={onViewStateChange}
        onDragStart={onDragStart}
        onDrag={onDrag}
        onDragEnd={onDragEnd}
        onAfterRender={onAfterRender}
        getCursor={({ isHovering }: any) => (isHovering ? 'pointer' : 'grab')}
        layers={layers}
      />
      
      {/* Goal Setting UI */}
      <div className="absolute top-4 right-4 flex flex-col gap-2">
        <button
          onClick={() => setIsSettingGoal(!isSettingGoal)}
          className={`p-2 rounded-full shadow-lg transition-all ${
            isSettingGoal 
              ? 'bg-blue-600 text-white animate-pulse' 
              : 'bg-white text-slate-700 hover:bg-slate-50'
          }`}
          title="Send Goal Pose"
        >
          <Navigation size={24} className={isSettingGoal ? 'rotate-45' : ''} />
        </button>
      </div>

      <div className="absolute bottom-4 right-4 flex items-center gap-2">
        <div className="bg-white/80 backdrop-blur-sm p-2 rounded text-xs font-mono shadow text-slate-700">
          Pts: {Object.values(pointCloudData).reduce((a, b) => a + b.length, 0).toLocaleString()} | FPS: {renderFps}
        </div>
        <button 
          onClick={() => {
            if (!isFollowing) setFollowOffset([0, 0, 0]);
            setIsFollowing(!isFollowing);
          }}
          className={`bg-white/80 backdrop-blur-sm p-1.5 rounded shadow focus:outline-none transition-colors ${isFollowing ? 'text-blue-600' : 'text-slate-600 hover:text-blue-600'}`}
          title={isFollowing ? "Stop Following" : "Follow base_link"}
        >
          <Crosshair size={18} className={isFollowing ? 'animate-pulse' : ''} />
        </button>
        <button 
          onClick={toggleFullscreen}
          className="bg-white/80 backdrop-blur-sm p-1.5 rounded shadow text-slate-600 hover:text-blue-600 focus:outline-none transition-colors"
          title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
        >
          {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      </div>

      {/* Confirmation Dialog for GeoJSON Station Click */}
      {confirmStation && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4 animate-in fade-in zoom-in">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                <MapPin size={20} className="text-blue-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Navigate to Station</h3>
                <p className="text-sm text-slate-500 font-mono">
                  {confirmStation.properties?.frame || `ID: ${confirmStation.properties?.id}`}
                </p>
              </div>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 mb-4 text-sm text-slate-600 space-y-1">
              <div className="flex justify-between">
                <span>Position X</span>
                <span className="font-mono">{confirmStation.geometry.coordinates[0]?.toFixed(3)}</span>
              </div>
              <div className="flex justify-between">
                <span>Position Y</span>
                <span className="font-mono">{confirmStation.geometry.coordinates[1]?.toFixed(3)}</span>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmStation(null)}
                className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmSendGoal}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors shadow-sm"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  return prev.messages === next.messages && 
         prev.topicVisibility === next.topicVisibility && 
         prev.tfVisibility === next.tfVisibility && 
         prev.showRobotModel === next.showRobotModel && 
         prev.config === next.config &&
         prev.waypoints === next.waypoints &&
         prev.meshModels === next.meshModels;
});