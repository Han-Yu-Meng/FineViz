import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { OrbitView } from '@deck.gl/core';
import { PointCloudLayer, LineLayer, TextLayer, PathLayer, ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
import { AppConfig, Waypoint } from '../hooks/useConfig';
import { Matrix4, Quaternion } from '@math.gl/core';

import { Maximize, Minimize } from 'lucide-react';
import { PointCloudBinary, TFLink } from './render/types';
import { decodePointCloud } from './render/pointCloudDecoder';
import { decodeMarkerArray, MarkerPrimitive } from './render/markerDecoder';
import { getFrameMatrix } from './render/tfTreeResolver';
import { decodeOccupancyGrid, OccupancyGridData } from './render/occupancyGridDecoder';
import { parseURDF, URDFRobot } from './render/urdfParser';
import { loadGLB } from './render/meshLoader';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';

import { MapPin, Navigation } from 'lucide-react';

interface DeckGLViewProps {
  config: AppConfig | null;
  waypoints: Waypoint[];
  messages: Record<string, any[]>;
  topicVisibility: Record<string, boolean>;
  onSendMessage?: (topic: string, type: string, data: any) => void;
}

export function DeckGLView({ config, waypoints, messages, topicVisibility, onSendMessage }: DeckGLViewProps) {
  const fixedFrame = config?.tf?.fixed_frame || 'map';
  const [viewState, setViewState] = useState<{ target: [number, number, number], zoom: number, rotationX: number, rotationOrbit: number }>({ target: [0, 0, 0], zoom: 1, rotationX: 30, rotationOrbit: 0 });
  const [renderFps, setRenderFps] = useState(0);
  const [pointCloudData, setPointCloudData] = useState<Record<string, PointCloudBinary>>({});
  const [pathData, setPathData] = useState<Record<string, any>>({});
  const [markerData, setMarkerData] = useState<Record<string, Record<string, MarkerPrimitive[]>>>({});
  const [gridData, setGridData] = useState<Record<string, OccupancyGridData>>({});
  const [tfTree, setTfTree] = useState<Record<string, TFLink>>({});
  const [urdfRobot, setUrdfRobot] = useState<URDFRobot | null>(null);
  const [meshModels, setMeshModels] = useState<Record<string, any>>({});
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Goal pose state
  const [isSettingGoal, setIsSettingGoal] = useState(false);
  const [goalPosition, setGoalPosition] = useState<[number, number] | null>(null);
  const [goalYaw, setGoalYaw] = useState<number>(0);

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

    // --- Update Occupancy Grids ---
    const gridConfigs = Object.values(cfg.visualize || {}).filter((item: any) => item?.type === 'nav_msgs/msg/OccupancyGrid' && item?.topic);
    const nextGrids: Record<string, OccupancyGridData> = {};
    for (const c of gridConfigs as any[]) {
      if (!(vis[c.topic] ?? true)) continue;
      const m = msgs[c.topic] || [];
      if (m.length === 0) continue;
      const latestMsg = m[m.length - 1];
      
      const res = decodeOccupancyGrid(latestMsg.data);
      if (res) nextGrids[c.topic] = res;
    }
    setGridData(nextGrids);

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
    if (config?.robot?.urdf) {
      const urdfFullPath = config.robot.urdf;
      const urdfDir = urdfFullPath.substring(0, urdfFullPath.lastIndexOf('/'));
      const fullUrdfPath = `/models/${urdfFullPath}`.replace(/\/+/g, '/');
      console.log(`[URDF] Fetching URDF from: ${fullUrdfPath}`);
      fetch(fullUrdfPath)
        .then(r => r.text())
        .then(async xml => {
          const robot = await parseURDF(xml, urdfFullPath);
          setUrdfRobot(robot);
          
          // Pre-load all meshes
          const meshesToLoad = new Set<string>();
          Object.values(robot.links).forEach(link => {
            link.visuals.forEach(v => {
              if (v.geometry.mesh) {
                meshesToLoad.add(v.geometry.mesh.filename);
              }
            });
          });

          for (const meshSubPath of meshesToLoad) {
            try {
              // Combine urdf directory with mesh relative path
              const fullMeshPath = `/models/${urdfDir}/${meshSubPath}`.replace(/\/+/g, '/');
              console.log(`[URDF] Loading mesh: ${fullMeshPath} (from subpath: ${meshSubPath})`);
              const mesh = await loadGLB(fullMeshPath);
              setMeshModels(prev => ({ ...prev, [meshSubPath]: mesh }));
            } catch (err) {
              console.warn(`Failed to load mesh ${meshSubPath}`, err);
            }
          }
        });
    }
  }, [config?.robot?.urdf]);

  useEffect(() => {
    const timer = setInterval(runDecode, 50);
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

    const axisLength = config?.tf?.axis_length ?? 0.5;
    const axisWidth = config?.tf?.axis_width ?? 0.05;
    const labelVisualize = config?.tf?.axis_label_visualize ?? true;

    // Root Axis
    axisData.push(
      { s: [0, 0, 0], t: [axisLength, 0, 0], color: [255, 0, 0] },
      { s: [0, 0, 0], t: [0, axisLength, 0], color: [0, 255, 0] },
      { s: [0, 0, 0], t: [0, 0, axisLength], color: [0, 0, 255] }
    );
    if (labelVisualize) {
      labelData.push({ text: fixedFrame, position: [0, 0, 0] });
    }

    links.forEach(link => {
      const worldMat = getFrameMatrix(link.child, tfTree, fixedFrame);
      const parentMat = getFrameMatrix(link.parent, tfTree, fixedFrame);
      
      // 直接利用矩阵特性，将局部坐标系原点 [0,0,0] 变换为世界坐标
      const pos = worldMat.transform([0, 0, 0]);
      const pPos = parentMat.transform([0, 0, 0]);

      lineData.push({ source: pPos, target: pos });

      // 【核心修复】不使用四元数反向解析，直接将局部坐标轴尖端转换为世界绝对坐标
      const xTip = worldMat.transform([axisLength, 0, 0]);
      const yTip = worldMat.transform([0, axisLength, 0]);
      const zTip = worldMat.transform([0, 0, axisLength]);

      axisData.push(
        { s: pos, t: xTip, color: [255, 0, 0] },
        { s: pos, t: yTip, color: [0, 255, 0] }, // 修正了原本的减号错误，回归右手系
        { s: pos, t: zTip, color: [0, 0, 255] }  // 修正了原本的减号错误，回归右手系
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
        getWidth: axisWidth * 100 // Scale width for visibility
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
  }, [tfTree, fixedFrame, config?.tf]);

  const onViewStateChange = useCallback(({ viewState }: any) => {
    setViewState({ ...viewState, target: [viewState.target[0], viewState.target[1], 0] });
  }, []);

  // 通过射线追踪算法，计算鼠标点击绝对对应地面的 [X, Y] 坐标
  const getGroundCoordinate = useCallback((info: any): [number, number] | null => {
    const viewport = info.viewport;
    if (viewport && viewport.unproject && viewport.cameraPosition) {
      // pFocal 是鼠标屏幕像素点反投影到 3D 焦平面上的坐标 [x, y, z]
      const pFocal = viewport.unproject([info.x, info.y]);
      // 相机的真实三维空间坐标
      const cameraPos = viewport.cameraPosition;

      if (pFocal && cameraPos) {
        // 构造从相机中心发出，穿过鼠标焦点的射线方向向量
        const dirX = pFocal[0] - cameraPos[0];
        const dirY = pFocal[1] - cameraPos[1];
        const dirZ = pFocal[2] - cameraPos[2];

        // 只有当视线是朝向下方地面时（方向向量 Z 为负）才计算交点
        if (dirZ < -1e-6) {
          // 射线参数方程： Z = cameraPos.z + t * dirZ = 0
          const t = -cameraPos[2] / dirZ;
          return [
            cameraPos[0] + t * dirX, 
            cameraPos[1] + t * dirY
          ];
        }
      }
    }
    
    // Fallback: 极端情况下如果无法获取相机矩阵，回退到默认的坐标系
    if (info.coordinate) {
      return [info.coordinate[0], info.coordinate[1]];
    }
    return null;
  }, []);

  const onDragStart = useCallback((info: any, event: any) => {
    if (isSettingGoal && !goalPosition) {
      const groundPos = getGroundCoordinate(info); // 使用真理级求交算法
      if (groundPos) {
        setGoalPosition(groundPos);
        return true; // 阻止地图平移
      }
    }
  }, [isSettingGoal, goalPosition, getGroundCoordinate]);

  const onDrag = useCallback((info: any, event: any) => {
    if (isSettingGoal && goalPosition) {
      const groundPos = getGroundCoordinate(info); // 拖拽角度时也使用绝对算法
      if (groundPos) {
        const dx = groundPos[0] - goalPosition[0];
        const dy = groundPos[1] - goalPosition[1];
        setGoalYaw(Math.atan2(dy, dx));
      }
      return true; // 阻止地图平移
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

  const layers = useMemo(() => {
    const allGridLayers = Object.entries(gridData).map(([t, d]) => {
      if (!d || d.width <= 0 || d.height <= 0) return null;
      
      const vConfigs = config?.visualize || {};
      const topicConfig = Object.entries(vConfigs).find(([_, c]: [string, any]) => c.topic === t)?.[1] as any;
      const alpha = topicConfig?.alpha ?? 1.0;

      const mat4 = getFrameMatrix(d.frameId, tfTree, fixedFrame);
      const originMat = new Matrix4().translate(d.origin.position).multiplyRight(new Matrix4().fromQuaternion(d.origin.orientation));
      const finalMat = mat4.clone().multiplyRight(originMat).translate([0, 0, 0]);
      
      return new BitmapLayer({
        id: `grid-${t}-${d.frameId}-${d.width}-${d.height}`,
        image: d.canvas,
        bounds: [0, 0, d.width * d.resolution, d.height * d.resolution],
        modelMatrix: finalMat as any,
        opacity: alpha,
        transparentColor: [0, 0, 0, 0], // 启用透明混合
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
        const mat4 = getFrameMatrix(d.frameId, tfTree, fixedFrame);
        return new PointCloudLayer({
          id: `${t}-${d.frameId}`,
          data: { length: d.length, attributes: { getPosition: { value: d.positions, size: 3 }, getColor: { value: d.colors, size: 3 } } },
          sizeUnits: 'pixels', pointSize: d.pointSize ?? 1.5, opacity: d.alpha ?? 1.0, modelMatrix: mat4 as any,
          updateTriggers: { modelMatrix: [mat4.toArray()] }
        });
      }),
      ...Object.entries(pathData).map(([t, d]) => {
        const mat4 = getFrameMatrix(d.frameId, tfTree, fixedFrame);
        return new PathLayer({
          id: `path-${t}-${d.frameId}`,
          data: [{ path: d.path, color: d.color, width: d.width }],
          pickable: false, widthScale: 1, widthMinPixels: 2, getPath: (p: any) => p.path, getColor: (p: any) => p.color, getWidth: (p: any) => p.width,
          modelMatrix: mat4 as any, updateTriggers: { modelMatrix: [mat4.toArray()] }
        });
      }),
      ...Object.entries(markerData).flatMap(([t, frames]) => {
        return Object.entries(frames).flatMap(([frameId, markers]) => {
          const mat4 = getFrameMatrix(frameId, tfTree, fixedFrame);
          const subLayers: any[] = [];
          const spheres = markers.filter(m => m.type === 2);
          if (spheres.length > 0) subLayers.push(new ScatterplotLayer({
            id: `marker-sphere-${t}-${frameId}`, data: spheres, getPosition: (d: MarkerPrimitive) => d.position, getFillColor: (d: MarkerPrimitive) => d.color, getRadius: (d: MarkerPrimitive) => d.scale[0] / 2, radiusUnits: 'meters', modelMatrix: mat4 as any, updateTriggers: { modelMatrix: [mat4.toArray()] }
          }));
          const lineStrips = markers.filter(m => m.type === 4);
          if (lineStrips.length > 0) subLayers.push(new PathLayer({
            id: `marker-linestrip-${t}-${frameId}`, data: lineStrips, getPath: (d: MarkerPrimitive) => d.points, getColor: (d: MarkerPrimitive) => d.color, getWidth: (d: MarkerPrimitive) => d.scale[0], widthUnits: 'meters', modelMatrix: mat4 as any, updateTriggers: { modelMatrix: [mat4.toArray()] }
          }));
          const lineLists = markers.filter(m => m.type === 5);
          if (lineLists.length > 0) {
            const linesData = lineLists.flatMap(m => {
              const pairs = [];
              for (let i = 0; i < m.points.length; i += 2) if (i + 1 < m.points.length) pairs.push({ source: m.points[i], target: m.points[i + 1], color: m.color, width: m.scale[0] });
              return pairs;
            });
            subLayers.push(new LineLayer({
              id: `marker-linelist-${t}-${frameId}`, data: linesData, getSourcePosition: (d: any) => d.source, getTargetPosition: (d: any) => d.target, getColor: (d: any) => d.color, getWidth: (d: any) => d.width, widthUnits: 'meters', modelMatrix: mat4 as any, updateTriggers: { modelMatrix: [mat4.toArray()] }
            }));
          }
          return subLayers;
        });
      })
    ];

    const robotLayers: any[] = [];
    if (urdfRobot) {
      Object.keys(urdfRobot.links).forEach(linkName => {
        const link = urdfRobot.links[linkName];
        const mat4 = getFrameMatrix(linkName, tfTree, fixedFrame);
        if (!mat4) return;
        
        link.visuals.forEach((v, idx) => {
          if (v.geometry.mesh && meshModels[v.geometry.mesh.filename]) {
             const visualMat = new Matrix4().multiplyRight(mat4);
             
             // Apply local offset rpy
             // Simple rotation matrix from Euler angles (ROS uses XYZ intrinsic or ZYX extrinsic)
             const r = v.origin.rpy[0];
             const p = v.origin.rpy[1];
             const y = v.origin.rpy[2];
             const q = new Quaternion().rotateX(r).rotateY(p).rotateZ(y);

             const localMat = new Matrix4().translate(v.origin.xyz).multiplyRight(new Matrix4().fromQuaternion(q));
             const finalMat = visualMat.clone().multiplyRight(localMat);
             
             robotLayers.push(new SimpleMeshLayer({
                id: `urdf-${linkName}-${idx}`,
                data: [{}],
                mesh: meshModels[v.geometry.mesh.filename],
                modelMatrix: finalMat as any,
                getColor: [200, 200, 200],
                sizeScale: 1.0, 
              }));
          }
        });
      });
    }

    const goalLayer = goalPosition && isSettingGoal ? [
      new PathLayer({
        id: 'goal-arrow-composite',
        data: [
          // 线段部分
          {
            path: [
              [goalPosition[0], goalPosition[1], 0.1],
              [
                goalPosition[0] + Math.cos(goalYaw) * 1.0,
                goalPosition[1] + Math.sin(goalYaw) * 1.0,
                0.1
              ]
            ],
            width: 0.1,
            widthMinPixels: 2
          },
          // 三角形箭头部分
          {
            path: [
              [
                goalPosition[0] + Math.cos(goalYaw) * 1.0 + Math.cos(goalYaw + Math.PI * 0.85) * 0.25,
                goalPosition[1] + Math.sin(goalYaw) * 1.0 + Math.sin(goalYaw + Math.PI * 0.85) * 0.25,
                0.1
              ],
              [
                goalPosition[0] + Math.cos(goalYaw) * 1.0,
                goalPosition[1] + Math.sin(goalYaw) * 1.0,
                0.1
              ],
              [
                goalPosition[0] + Math.cos(goalYaw) * 1.0 + Math.cos(goalYaw - Math.PI * 0.85) * 0.25,
                goalPosition[1] + Math.sin(goalYaw) * 1.0 + Math.sin(goalYaw - Math.PI * 0.85) * 0.25,
                0.1
              ],
              [
                goalPosition[0] + Math.cos(goalYaw) * 1.0 + Math.cos(goalYaw + Math.PI * 0.85) * 0.25,
                goalPosition[1] + Math.sin(goalYaw) * 1.0 + Math.sin(goalYaw + Math.PI * 0.85) * 0.25,
                0.1
              ]
            ],
            width: 0.1,
            widthMinPixels: 2
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
      ...goalLayer
    ].filter(Boolean);
  }, [pointCloudData, pathData, markerData, gridData, tfLayers, tfTree, fixedFrame, config?.visualize, goalPosition, goalYaw, isSettingGoal, urdfRobot, meshModels]);

  return (
    <div className="relative w-full h-full bg-slate-100" onContextMenu={e => e.preventDefault()}>
      <DeckGL
        views={new OrbitView({ id: 'orbit' })}
        controller={{
          dragMode: isSettingGoal ? 'rotate' : 'pan', // Change dragMode to prevent panning when setting goal
          dragPan: !isSettingGoal,
          dragRotate: !isSettingGoal,
          inertia: false, 
          scrollZoom: { speed: 0.02, smooth: false },
          touchRotate: !isSettingGoal
        }}
        viewState={viewState}
        onViewStateChange={({ viewState }: any) => setViewState({ ...viewState, target: [viewState.target[0], viewState.target[1], 0] })}
        onDragStart={onDragStart}
        onDrag={onDrag}
        onDragEnd={onDragEnd}
        onAfterRender={onAfterRender}
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
          onClick={toggleFullscreen}
          className="bg-white/80 backdrop-blur-sm p-1.5 rounded shadow text-slate-600 hover:text-blue-600 focus:outline-none transition-colors"
          title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
        >
          {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      </div>
    </div>
  );
}
