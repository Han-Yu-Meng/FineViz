import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Matrix4, Quaternion } from '@math.gl/core';

import { Maximize, Minimize, Crosshair } from 'lucide-react';
import { PointCloudBinary, TFLink, OccupancyGridRaw } from './render/types';
import { decodePointCloud } from './render/pointCloudDecoder';
import { decodeMarkerArray, MarkerPrimitive } from './render/markerDecoder';
import { getFrameMatrix } from './render/tfTreeResolver';
import { decodeOccupancyGrid, OccupancyGridData } from './render/occupancyGridDecoder';
import { parseURDF, URDFRobot } from './render/urdfParser';
import { loadGLB } from './render/meshLoader';
import { AppConfig, Waypoint } from '../hooks/useConfig';

import { MapPin, Navigation } from 'lucide-react';

// ── 全局共享缓冲池 ──
const MAX_COMBINED_POINTS = 500000;
const COMBINED_POSITIONS = new Float32Array(MAX_COMBINED_POINTS * 3);
const COMBINED_COLORS = new Uint8Array(MAX_COMBINED_POINTS * 3);

// ── Web Worker 实例 ──
const useWorker = typeof Worker !== 'undefined';
const decoderWorker = useWorker
  ? new Worker(new URL('../workers/decoder.worker.ts', import.meta.url), { type: 'module' })
  : null;

// 生成圆形点纹理（模块级缓存，只创建一次）
// 关键：画布填充透明白(rgba(255,255,255,0))，确保边缘插值时不会引入黑色/白色光晕
let _circleTexture: THREE.Texture | null = null;
function getCircleTexture(): THREE.Texture {
  if (_circleTexture) return _circleTexture;
  const size = 64;
  const radius = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // 整张画布填充透明白，避免边缘采样到透明黑产生暗色光晕
  ctx.fillStyle = 'rgba(255,255,255,0)';
  ctx.fillRect(0, 0, size, size);
  // 绘制硬边实心白圆
  ctx.beginPath();
  ctx.arc(radius, radius, radius - 1, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fill();
  _circleTexture = new THREE.CanvasTexture(canvas);
  _circleTexture.needsUpdate = true;
  return _circleTexture;
}

function rgbaToCanvas(raw: OccupancyGridRaw): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = raw.width;
  canvas.height = raw.height;
  const ctx = canvas.getContext('2d')!;
  const imgData = new ImageData(raw.rgba, raw.width, raw.height);
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

interface ThreeViewProps {
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

export const DeckGLView = React.memo(function ThreeView({
  config,
  waypoints,
  messages,
  topicVisibility,
  tfVisibility,
  onSendMessage,
  meshModels,
  onMeshModelsChange,
  showRobotModel
}: ThreeViewProps) {
  const fixedFrame = config?.tf?.fixed_frame || 'map';
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [renderFps, setRenderFps] = useState(0);

  const [worldMatrices, setWorldMatrices] = useState<Record<string, number[]>>({});
  const worldMatricesRef = useRef<Record<string, number[]>>({});

  const [pointCloudData, setPointCloudData] = useState<Record<string, PointCloudBinary>>({});
  const [pathData, setPathData] = useState<Record<string, any>>({});
  const [markerData, setMarkerData] = useState<Record<string, Record<string, MarkerPrimitive[]>>>({});
  const [gridData, setGridData] = useState<Record<string, OccupancyGridData>>({});
  const [tfTree, setTfTree] = useState<Record<string, TFLink>>({});
  const [urdfRobot, setUrdfRobot] = useState<URDFRobot | null>(null);

  const [geojsonData, setGeojsonData] = useState<any>(null);
  const [hoveredStationId, setHoveredStationId] = useState<number | string | null>(null);
  const [confirmStation, setConfirmStation] = useState<any>(null);
  const lastGeoJsonRef = useRef<string>('');

  const [isSettingGoal, setIsSettingGoal] = useState(false);
  const [goalPosition, setGoalPosition] = useState<[number, number] | null>(null);
  const [goalYaw, setGoalYaw] = useState<number>(0);

  const isInteractingRef = useRef(false);
  const followOffsetRef = useRef<[number, number, number]>([0, 0, 0]);
  const isUserInteractingRef = useRef(false);
  const lastGridStampRef = useRef<Record<string, { sec: number; nsec: number }>>({});
  const gridCacheRef = useRef<Record<string, OccupancyGridData>>({});
  const requestIdRef = useRef(0);

  // ── Three.js 核心引用 ──
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  const pointCloudObjects = useRef<Record<string, THREE.Points>>({});
  const gridObjects = useRef<Record<string, THREE.Mesh>>({});
  const robotModelGroup = useRef<THREE.Group | null>(null);
  const tfAxisGroup = useRef<THREE.Group | null>(null);
  const markerGroup = useRef<THREE.Group | null>(null);
  const pathGroup = useRef<THREE.Group | null>(null);
  const goalGroup = useRef<THREE.Group | null>(null);

  // 临时变量池，杜绝循环内 GC
  const tempMatrix = useRef(new THREE.Matrix4());
  const tempPosition = useRef(new THREE.Vector3());
  const tempQuaternion = useRef(new THREE.Quaternion());
  const tempScale = useRef(new THREE.Vector3(1, 1, 1));
  const smoothedBasePos = useRef(new THREE.Vector3()); // 平滑后的机器人位置

  const fTimesRef = useRef<number[]>([]);
  const lMsgs = useRef(messages);
  const lCfg = useRef(config);
  const lVis = useRef(topicVisibility);
  const lFollow = useRef(isFollowing);
  
  lMsgs.current = messages; 
  lCfg.current = config; 
  lVis.current = topicVisibility; 
  lFollow.current = isFollowing;

  // ── 1. Three.js 场景初始化 ──
// ── 1. Three.js 场景初始化 ──
  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return;

    const scene = new THREE.Scene();
    // 将背景改为高品质的浅灰色，与原有 tailwind bg-slate-100 保持一致
    scene.background = new THREE.Color(0xf1f5f9);
    sceneRef.current = scene;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.45);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    // 绘制 XY 地面参考网格，并使其颜色在浅色背景下高度可读
    const gridHelper = new THREE.GridHelper(50, 50, 0x94a3b8, 0xcbd5e1);
    gridHelper.rotation.x = Math.PI / 2; // 绕 X 轴旋转 90 度以平铺在 XY 面上
    scene.add(gridHelper);

    // 添加原点轴向辅助器
    const axesHelper = new THREE.AxesHelper(1);
    scene.add(axesHelper);

    const camera = new THREE.PerspectiveCamera(
      60,
      containerRef.current.clientWidth / containerRef.current.clientHeight,
      0.1,
      1000,
    );
    camera.up.set(0, 0, 1);
    camera.position.set(-6, -6, 8);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      antialias: true,
      alpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    
    // 🌟 [优化 1]: 调整灵敏度，使其在大范围地图缩放与拖拽下高度响应
    controls.rotateSpeed = 1.0; 
    controls.zoomSpeed = 1.6;   // 提高中键/双指缩放的反应速度
    controls.panSpeed = 1.3;    // 提高平移灵敏度，减少大范围划动的次数
    
    // 🌟 [优化 2]: 限制平移在地面 (XY 平面) 上，而不是屏幕投影面
    // 当 camera.up 设为 (0,0,1) 且 screenSpacePanning 为 false 时，拖拽将精确沿 XY 地图平面滑动
    controls.screenSpacePanning = false;

    // 🌟 [优化 3]: 启用弹性阻尼并设置高阻尼系数 (0.15)
    // 相比于之前的骤停 (enableDamping = false)，适度的阻尼可以带来更顺滑、符合真实物理惯性的高级交互手感
    controls.enableDamping = false; 
    // controls.dampingFactor = 0.15; 
    
    // 调整鼠标按键映射，使其与 Deck.gl 交互保持一致
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,       // 左键拖动 -> 平移
      MIDDLE: THREE.MOUSE.DOLLY,   // 中键滚动 -> 缩放
      RIGHT: THREE.MOUSE.ROTATE    // 右键拖拽 -> 旋转 3D 视角
    };

    // 调整触控手势映射，支持移动端单指平移，双指旋转/缩放
    controls.touches = {
      ONE: THREE.TOUCH.PAN,        
      TWO: THREE.TOUCH.DOLLY_ROTATE 
    };

    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    // 常驻场景节点
    const robotGroup = new THREE.Group();
    scene.add(robotGroup);
    robotModelGroup.current = robotGroup;

    const tfGroup = new THREE.Group();
    scene.add(tfGroup);
    tfAxisGroup.current = tfGroup;

    const mkGroup = new THREE.Group();
    scene.add(mkGroup);
    markerGroup.current = mkGroup;

    const pGroup = new THREE.Group();
    scene.add(pGroup);
    pathGroup.current = pGroup;

    const gGroup = new THREE.Group();
    scene.add(gGroup);
    goalGroup.current = gGroup;

    const handleResize = () => {
      if (!containerRef.current || !camera || !renderer) return;
      camera.aspect = containerRef.current.clientWidth / containerRef.current.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    };
    window.addEventListener('resize', handleResize);

    // 用户交互追踪（复刻 DeckGLView onViewStateChange 逻辑）
    controls.addEventListener('start', () => {
      isUserInteractingRef.current = true;
    });
    controls.addEventListener('end', () => {
      isUserInteractingRef.current = false;
      // 交互结束时，若处于跟随模式，记录当前偏移量
      if (lFollow.current) {
        followOffsetRef.current = [
          controls.target.x - smoothedBasePos.current.x,
          controls.target.y - smoothedBasePos.current.y,
          0,
        ];
      }
    });

    // ── 渲染循环 ──
    let animationId: number;
    let frameCount = 0;
    let fpsTimer = 0;

    const tick = (now: number) => {
      animationId = requestAnimationFrame(tick);

      // 🌟 [优化 4]: 移除 30 FPS 硬性帧率限制。
      // 让 controls.update() 和 WebGL 渲染完全匹配浏览器和屏幕的原生刷新率 (60Hz / 120Hz / 144Hz)。
      // 此时交互反馈的响应延迟大幅下降，画面的即时跟手感与 Deck.gl 趋于一致。
      controls.update();

      // 跟随逻辑（平滑源位置 + 直接设置 target）
      const robotFrame = lCfg.current?.robot?.base_frame || 'base_link';
      const baseMat = worldMatricesRef.current[robotFrame];
      if (baseMat) {
        // 平滑机器人世界位置，消除 100ms TF 更新间隔的跳变
        if (smoothedBasePos.current.length() === 0) {
          smoothedBasePos.current.set(baseMat[12], baseMat[13], baseMat[14]);
        } else {
          smoothedBasePos.current.lerp(
            tempPosition.current.set(baseMat[12], baseMat[13], baseMat[14]),
            0.35,
          );
        }

        if (lFollow.current && !isUserInteractingRef.current) {
          const offset = followOffsetRef.current;
          controls.target.set(
            smoothedBasePos.current.x + offset[0],
            smoothedBasePos.current.y + offset[1],
            smoothedBasePos.current.z + offset[2],
          );
        }
      }

      renderer.render(scene, camera);

      // FPS 统计计算保持正常工作
      frameCount++;
      if (now - fpsTimer >= 1000) {
        setRenderFps(frameCount);
        frameCount = 0;
        fpsTimer = now;
      }
    };
    animationId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
    };
  }, []);

  // ── 2. 点云更新 (原地覆盖 Buffer，零分配) ──
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    Object.entries(pointCloudData).forEach(([topic, d]) => {
      const isVisible = topicVisibility[topic] ?? true;
      let pointsObj = pointCloudObjects.current[topic];

      if (!isVisible) {
        if (pointsObj) {
          scene.remove(pointsObj);
          (pointsObj.geometry as THREE.BufferGeometry).dispose();
          (pointsObj.material as THREE.Material).dispose();
          delete pointCloudObjects.current[topic];
        }
        return;
      }

      if (!pointsObj) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          'position',
          new THREE.BufferAttribute(new Float32Array(MAX_COMBINED_POINTS * 3), 3),
        );
        geometry.setAttribute(
          'color',
          new THREE.BufferAttribute(new Uint8Array(MAX_COMBINED_POINTS * 3), 3, true),
        );

        const material = new THREE.PointsMaterial({
          size: d.pointSize ?? 0.05,
          map: getCircleTexture(),
          vertexColors: true,
          transparent: true,
          opacity: d.alpha ?? 1.0,
          depthWrite: true,
          blending: THREE.NormalBlending,
        });

        pointsObj = new THREE.Points(geometry, material);
        scene.add(pointsObj);
        pointCloudObjects.current[topic] = pointsObj;
      } else {
        const mat = pointsObj.material as THREE.PointsMaterial;
        mat.size = d.pointSize ?? 0.05;
        mat.opacity = d.alpha ?? 1.0;
      }

      const geometry = pointsObj.geometry as THREE.BufferGeometry;
      const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
      const colAttr = geometry.getAttribute('color') as THREE.BufferAttribute;

      (posAttr.array as Float32Array).set(d.positions.subarray(0, d.length * 3));
      (colAttr.array as Uint8Array).set(d.colors.subarray(0, d.length * 3));
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      geometry.setDrawRange(0, d.length);

      const mat = worldMatrices[d.frameId] || worldMatrices[fixedFrame];
      if (mat) {
        tempMatrix.current.fromArray(mat);
        pointsObj.matrix.copy(tempMatrix.current);
        pointsObj.matrixAutoUpdate = false;
      }
    });

    Object.keys(pointCloudObjects.current).forEach(topic => {
      if (!pointCloudData[topic]) {
        const obj = pointCloudObjects.current[topic];
        if (obj) {
          scene.remove(obj);
          (obj.geometry as THREE.BufferGeometry).dispose();
          (obj.material as THREE.Material).dispose();
          delete pointCloudObjects.current[topic];
        }
      }
    });
  }, [pointCloudData, worldMatrices, topicVisibility, fixedFrame]);

  // ── 3. 栅格地图更新 ──
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    Object.entries(gridData).forEach(([topic, d]) => {
      const isVisible = topicVisibility[topic] ?? true;
      let mesh = gridObjects.current[topic];

      if (!isVisible) {
        if (mesh) {
          scene.remove(mesh);
          (mesh.geometry as THREE.BufferGeometry).dispose();
          (mesh.material as THREE.Material).dispose();
          delete gridObjects.current[topic];
        }
        return;
      }

      const texture = new THREE.CanvasTexture(d.canvas);
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;

      const vConfigs = config?.visualize || {};
      const topicConfig = Object.entries(vConfigs).find(
        ([_, c]: [string, any]) => c.topic === topic,
      )?.[1] as any;
      const alpha = topicConfig?.alpha ?? 1.0;

      const halfW = (d.width * d.resolution) / 2;
      const halfH = (d.height * d.resolution) / 2;
      const gridW = d.width * d.resolution;
      const gridH = d.height * d.resolution;

      if (!mesh) {
        const geometry = new THREE.PlaneGeometry(1, 1);
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          opacity: alpha,
          side: THREE.DoubleSide,
          depthWrite: false,
          depthTest: false, // 确保 grid 不被点云深度遮挡
        });
        mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = -1; // 最先渲染，作为地图底图
        scene.add(mesh);
        gridObjects.current[topic] = mesh;
      } else {
        const mat = mesh.material as THREE.MeshBasicMaterial;
        if (mat.map) mat.map.dispose();
        mat.map = texture;
        mat.opacity = alpha;
        mat.needsUpdate = true;
      }

      const matArray = worldMatrices[d.frameId] || worldMatrices[fixedFrame];
      if (matArray) {
        tempMatrix.current.fromArray(matArray);
        // ── 坐标系修复：复刻 DeckGLView BitmapLayer 的逻辑 ──
        // DeckGL: bounds=[0,0,w*res,h*res] + modelMatrix = baseMat * T(origin) * R(orientation)
        // Three.js: PlaneGeometry(1,1) 在 XY 面，需要 S(gridW, gridH, 1) + T(halfW, halfH, 0) 来匹配
        const originMat = new THREE.Matrix4().compose(
          new THREE.Vector3(...d.origin.position),
          new THREE.Quaternion(...d.origin.orientation),
          new THREE.Vector3(1, 1, 1),
        );
        // scaleMat: 先把 1x1 平面放大到 grid 尺寸，再平移到正象限
        const scaleMat = new THREE.Matrix4().compose(
          new THREE.Vector3(halfW, halfH, 0),
          new THREE.Quaternion(),
          new THREE.Vector3(gridW, gridH, 1),
        );
        // 矩阵链：worldMat * originMat * scaleMat
        // 等价于 DeckGL: baseMat.multiplyRight(originMat) + bounds
        mesh.matrix.copy(tempMatrix.current.clone().multiply(originMat).multiply(scaleMat));
        mesh.matrixAutoUpdate = false;
      }
    });

    Object.keys(gridObjects.current).forEach(topic => {
      if (!gridData[topic]) {
        const obj = gridObjects.current[topic];
        if (obj) {
          scene.remove(obj);
          (obj.geometry as THREE.BufferGeometry).dispose();
          (obj.material as THREE.Material).dispose();
          delete gridObjects.current[topic];
        }
      }
    });
  }, [gridData, worldMatrices, topicVisibility, fixedFrame, config?.visualize]);

  // ── 4. 机器人 URDF 模型 ──
  useEffect(() => {
    const group = robotModelGroup.current;
    if (!group || !urdfRobot || !showRobotModel) return;

    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
    }

    const defaultWorldMatrices: Record<string, THREE.Matrix4> = {};
    const baseFrame = config?.robot?.base_frame || Object.keys(urdfRobot.links)[0];
    if (baseFrame && urdfRobot.links[baseFrame]) {
      defaultWorldMatrices[baseFrame] = new THREE.Matrix4().identity();
      const computeDefaultPose = (parentName: string) => {
        Object.values(urdfRobot.joints).forEach(joint => {
          const pName = String(joint.parent);
          const cName = String(joint.child);
          if (pName === parentName && !defaultWorldMatrices[cName]) {
            const r = joint.origin.rpy[0], p = joint.origin.rpy[1], y = joint.origin.rpy[2];
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r, p, y, 'XYZ'));
            const localMat = new THREE.Matrix4().compose(
              new THREE.Vector3(...joint.origin.xyz),
              q,
              new THREE.Vector3(1, 1, 1),
            );
            defaultWorldMatrices[cName] = new THREE.Matrix4().multiplyMatrices(
              defaultWorldMatrices[parentName],
              localMat,
            );
            computeDefaultPose(cName);
          }
        });
      };
      computeDefaultPose(baseFrame);
    }

    Object.keys(urdfRobot.links).forEach(linkName => {
      const link = urdfRobot.links[linkName];
      const matArray = worldMatrices[linkName] || defaultWorldMatrices[linkName]?.toArray();
      const worldMat = matArray ? new THREE.Matrix4().fromArray(matArray) : new THREE.Matrix4().identity();

      link.visuals.forEach(v => {
        if (!v.geometry.mesh || !meshModels[v.geometry.mesh.filename]) return;

        const model = meshModels[v.geometry.mesh.filename] as THREE.Group;
        const instance = model.clone();

        const r = v.origin.rpy[0], p = v.origin.rpy[1], y = v.origin.rpy[2];
        tempQuaternion.current.setFromEuler(new THREE.Euler(r, p, y, 'XYZ'));
        tempPosition.current.set(v.origin.xyz[0], v.origin.xyz[1], v.origin.xyz[2]);

        const localMat = new THREE.Matrix4().compose(
          tempPosition.current,
          tempQuaternion.current,
          tempScale.current.set(1, 1, 1),
        );

        // 关键：model.matrix 包含 meshLoader 中的 PI/2 X 旋转（GLTF Y-up → ROS Z-up）
        // 必须乘入最终矩阵，否则会被 matrixAutoUpdate=false + matrix.copy 覆盖丢弃
        instance.matrix.copy(worldMat.clone().multiply(localMat).multiply(model.matrix));
        instance.matrixAutoUpdate = false;
        group.add(instance);
      });
    });
  }, [urdfRobot, meshModels, worldMatrices, showRobotModel, config?.robot?.base_frame]);

  // ── 5. TF 坐标轴更新 ──
  useEffect(() => {
    const group = tfAxisGroup.current;
    if (!group) return;

    while (group.children.length > 0) group.remove(group.children[0]);

    const links = Object.values(tfTree);
    const axisLength = config?.tf?.axis_length ?? 0.5;

    links.forEach(link => {
      const isHidden = tfVisibility[link.child] !== undefined
        ? !tfVisibility[link.child]
        : (config?.tf?.hidden_frame || []).includes(link.child);
      if (isHidden) return;

      const worldMat = getFrameMatrix(link.child, tfTree, fixedFrame);
      const origin = worldMat.transform([0, 0, 0]);
      const originVec = new THREE.Vector3(origin[0], origin[1], origin[2]);

      const parentMat = getFrameMatrix(link.parent, tfTree, fixedFrame);
      const parentOrigin = parentMat.transform([0, 0, 0]);
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(parentOrigin[0], parentOrigin[1], parentOrigin[2]),
        originVec,
      ]);
      const lineObj = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x94a3b8 }));
      group.add(lineObj);

      [0, 1, 2].forEach(axis => {
        const tip = worldMat.transform([
          axis === 0 ? axisLength : 0,
          axis === 1 ? axisLength : 0,
          axis === 2 ? axisLength : 0,
        ]);
        const color = axis === 0 ? 0xef4444 : axis === 1 ? 0x22c55e : 0x3b82f6; // ROS R-G-B
        const axisGeo = new THREE.BufferGeometry().setFromPoints([
          originVec,
          new THREE.Vector3(tip[0], tip[1], tip[2]),
        ]);
        group.add(new THREE.Line(axisGeo, new THREE.LineBasicMaterial({ color })));
      });
    });
  }, [tfTree, fixedFrame, config?.tf, tfVisibility]);

  // ── 6. Marker 更新 ──
  useEffect(() => {
    const group = markerGroup.current;
    if (!group) return;

    while (group.children.length > 0) group.remove(group.children[0]);

    Object.entries(markerData).forEach(([_topic, frames]) => {
      Object.entries(frames).forEach(([frameId, markers]) => {
        const matArray = worldMatrices[frameId] || worldMatrices[fixedFrame];
        const worldMat = matArray ? new THREE.Matrix4().fromArray(matArray) : new THREE.Matrix4().identity();

        markers.forEach(m => {
          if (m.type === 2) {
            const geo = new THREE.SphereGeometry(m.scale[0] / 2, 8, 8);
            const mat = new THREE.MeshBasicMaterial({
              color: new THREE.Color(m.color[0] / 255, m.color[1] / 255, m.color[2] / 255),
              transparent: true,
              opacity: m.color[3] / 255,
            });
            const sphere = new THREE.Mesh(geo, mat);
            sphere.matrix.copy(
              worldMat.clone().multiply(
                new THREE.Matrix4().makeTranslation(m.position[0], m.position[1], m.position[2]),
              ),
            );
            sphere.matrixAutoUpdate = false;
            group.add(sphere);
          } else if (m.type === 4 && m.points.length > 1) {
            const pts = m.points.map(p => new THREE.Vector3(p[0], p[1], p[2]));
            const geo = new THREE.BufferGeometry().setFromPoints(pts);
            const mat = new THREE.LineBasicMaterial({
              color: new THREE.Color(m.color[0] / 255, m.color[1] / 255, m.color[2] / 255),
            });
            const line = new THREE.Line(geo, mat);
            line.matrix.copy(worldMat);
            line.matrixAutoUpdate = false;
            group.add(line);
          }
        });
      });
    });
  }, [markerData, worldMatrices, fixedFrame]);

  // ── 7. Path 路径更新 ──
  useEffect(() => {
    const group = pathGroup.current;
    if (!group) return;

    while (group.children.length > 0) group.remove(group.children[0]);

    Object.entries(pathData).forEach(([_topic, d]) => {
      if (!d.path || d.path.length < 2) return;
      const matArray = worldMatrices[d.frameId] || worldMatrices[fixedFrame];
      const worldMat = matArray ? new THREE.Matrix4().fromArray(matArray) : new THREE.Matrix4().identity();

      const pts = d.path.map((p: number[]) => new THREE.Vector3(p[0], p[1], p[2] || 0));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const color = new THREE.Color(
        (d.color?.[0] ?? 93) / 255,
        (d.color?.[1] ?? 153) / 255,
        (d.color?.[2] ?? 227) / 255,
      );
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
      line.matrix.copy(worldMat);
      line.matrixAutoUpdate = false;
      group.add(line);
    });
  }, [pathData, worldMatrices, fixedFrame]);

  // ── 8. Goal pose 箭头 ──
  useEffect(() => {
    const group = goalGroup.current;
    if (!group) return;

    while (group.children.length > 0) group.remove(group.children[0]);

    if (!goalPosition || !isSettingGoal) return;

    const arrowLen = 1.0;
    const endX = goalPosition[0] + Math.cos(goalYaw) * arrowLen;
    const endY = goalPosition[1] + Math.sin(goalYaw) * arrowLen;

    const shaftGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(goalPosition[0], goalPosition[1], 0.1),
      new THREE.Vector3(endX, endY, 0.1),
    ]);
    group.add(new THREE.Line(shaftGeo, new THREE.LineBasicMaterial({ color: 0xff3232 })));
  }, [goalPosition, goalYaw, isSettingGoal]);

  // ── 9. Worker 响应处理 ──
  useEffect(() => {
    if (!decoderWorker) return;
    decoderWorker.onmessage = (e: MessageEvent) => {
      const { type, topic, payload } = e.data;
      if (type === 'PC_RESULT') {
        if (payload) {
          if (payload.frameId.startsWith('/')) payload.frameId = payload.frameId.substring(1);
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

  // ── 10. 数据解码管线 (runDecode) ──
  const runDecode = useCallback(() => {
    if (isInteractingRef.current) return;
    const msgs = lMsgs.current, cfg = lCfg.current, vis = lVis.current;
    if (!cfg) return;

    // --- Point Cloud ---
    const pcConfigs = Object.values(cfg.visualize || {}).filter(
      (item: any) => item?.type === 'sensor_msgs/msg/PointCloud2' && item?.topic,
    );
    const now = Date.now();
    for (const c of pcConfigs as any[]) {
      if (!(vis[c.topic] ?? true)) continue;
      const m = msgs[c.topic] || [];
      if (m.length === 0) {
        setPointCloudData(prev => {
          if (!prev[c.topic]) return prev;
          const next = { ...prev };
          delete next[c.topic];
          return next;
        });
        continue;
      }
      const sel = c.listen_updates
        ? (c.last_time > 0 ? m.filter((msg: any) => (msg.receivedAt || 0) >= now - c.last_time * 1000) : [m[m.length - 1]])
        : [m[m.length - 1]];
      if (sel.length === 0) {
        setPointCloudData(prev => {
          if (!prev[c.topic]) return prev;
          const next = { ...prev };
          delete next[c.topic];
          return next;
        });
        continue;
      }

      if (decoderWorker) {
        const reqId = ++requestIdRef.current;
        decoderWorker.postMessage({
          id: reqId, type: 'PC_BATCH_DECODE', topic: c.topic,
          data: sel.map((s: any) => s.data),
          options: { colorField: c.color_field, colorScheme: c.color_scheme, targetMaxPoints: 100000, pointSize: c.point_size, alpha: c.alpha },
        });
      } else {
        const res = sel.map(s => {
          const decoded = decodePointCloud(s.data, c.color_field, c.color_scheme, 100000);
          if (decoded && decoded.frameId.startsWith('/')) decoded.frameId = decoded.frameId.substring(1);
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
          nextPc[c.topic] = { length: off, positions: COMBINED_POSITIONS.slice(0, off * 3), colors: COMBINED_COLORS.slice(0, off * 3), frameId: res[0].frameId, pointSize: c.point_size, alpha: c.alpha };
          setPointCloudData(prev => ({ ...prev, ...nextPc }));
        }
      }
    }

    // --- Path ---
    const pathConfigs = Object.values(cfg.visualize || {}).filter((item: any) => item?.type === 'nav_msgs/msg/Path' && item?.topic);
    const nextPaths: Record<string, any> = {};
    for (const c of pathConfigs as any[]) {
      if (!(vis[c.topic] ?? true)) continue;
      const m = msgs[c.topic] || [];
      if (m.length === 0) continue;
      const sel = c.listen_updates ? (c.last_time > 0 ? m.filter((msg: any) => (msg.receivedAt || 0) >= now - c.last_time * 1000) : [m[m.length - 1]]) : [m[m.length - 1]];
      if (sel.length === 0) continue;
      const latest = sel[sel.length - 1];
      if (!latest.data?.poses) continue;
      const pathPoints = latest.data.poses.map((p: any) => [p.pose.position.x, p.pose.position.y, p.pose.position.z || 0]);
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

    // --- Update Marker ---
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

    // --- Update Occupancy Grids ---
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

    // --- GeoJSON ---
    const geojsonConfig = Object.values(cfg.visualize || {}).find((item: any) => item?.topic === '/geojson');
    if (geojsonConfig) {
      const m = msgs[geojsonConfig.topic] || [];
      if (m.length > 0) {
        const latest = m[m.length - 1];
        const jsonStr = latest.data?.data;
        if (jsonStr && typeof jsonStr === 'string' && jsonStr !== lastGeoJsonRef.current) {
          lastGeoJsonRef.current = jsonStr;
          try { const parsed = JSON.parse(jsonStr); if (parsed?.type === 'FeatureCollection') setGeojsonData(parsed); } catch {}
        }
      }
    }

    // --- TF ---
    const rawTf = [...(msgs['/tf'] || []), ...(msgs['/tf_static'] || [])];
    if (rawTf.length > 0) {
      setTfTree(prev => {
        const next = { ...prev };
        let changed = false;
        const seenFrames = new Set<string>();
        for (let i = rawTf.length - 1; i >= 0; i--) {
          const transforms = rawTf[i].data?.transforms || rawTf[i].transforms || [];
          for (let j = transforms.length - 1; j >= 0; j--) {
            const t = transforms[j];
            const childFrameId = (t.child_frame_id || '').startsWith('/') ? t.child_frame_id.substring(1) : t.child_frame_id;
            const parentFrameId = (t.header.frame_id || '').startsWith('/') ? t.header.frame_id.substring(1) : t.header.frame_id;
            if (seenFrames.has(childFrameId)) continue;
            seenFrames.add(childFrameId);
            const existing = next[childFrameId];
            const isDifferent = !existing || existing.parent !== parentFrameId ||
              existing.position[0] !== t.transform.translation.x || existing.position[1] !== t.transform.translation.y || existing.position[2] !== t.transform.translation.z ||
              existing.rotation[0] !== t.transform.rotation.x || existing.rotation[1] !== t.transform.rotation.y || existing.rotation[2] !== t.transform.rotation.z || existing.rotation[3] !== t.transform.rotation.w;
            if (isDifferent) {
              next[childFrameId] = { parent: parentFrameId, child: childFrameId,
                position: [t.transform.translation.x, t.transform.translation.y, t.transform.translation.z],
                rotation: [t.transform.rotation.x, t.transform.rotation.y, t.transform.rotation.z, t.transform.rotation.w] };
              changed = true;
            }
          }
        }
        if (cfg.tf?.fixed_transform) {
          Object.entries(cfg.tf.fixed_transform).forEach(([childFrameId, transform]: [string, any]) => {
            if (!next[childFrameId]) { next[childFrameId] = { parent: transform.parent, child: childFrameId, position: transform.position, rotation: transform.rotation }; changed = true; }
          });
        }
        if (changed) {
          const matrices: Record<string, number[]> = { [fixedFrame]: new Matrix4().toArray() };
          Object.keys(next).forEach(frameId => { matrices[frameId] = getFrameMatrix(frameId, next, fixedFrame).toArray(); });
          setWorldMatrices(matrices);
          worldMatricesRef.current = matrices;
        }
        return changed ? next : prev;
      });
    }
  }, [fixedFrame]);

  useEffect(() => {
    const timer = setInterval(runDecode, 100);
    return () => clearInterval(timer);
  }, [runDecode]);

  // ── 11. URDF ──
  useEffect(() => {
    if (config?.robot?.urdf) {
      const urdfFullPath = config.robot.urdf;
      const urdfDir = urdfFullPath.substring(0, urdfFullPath.lastIndexOf('/'));
      const fullUrdfPath = `/models/${urdfFullPath}`.replace(/\/+/g, '/');
      fetch(fullUrdfPath).then(r => r.text()).then(async xml => {
        const robot = await parseURDF(xml, urdfFullPath);
        setUrdfRobot(robot);
        const meshesToLoad = new Set<string>();
        Object.values(robot.links).forEach(link => { link.visuals.forEach(v => { if (v.geometry.mesh) meshesToLoad.add(v.geometry.mesh.filename); }); });
        const loaded: Record<string, any> = { ...meshModels };
        for (const meshSubPath of meshesToLoad) {
          try {
            const fullMeshPath = `/models/${urdfDir}/${meshSubPath}`.replace(/\/+/g, '/');
            loaded[meshSubPath] = await loadGLB(fullMeshPath);
          } catch {}
        }
        onMeshModelsChange(loaded);
      });
    }
  }, [config?.robot?.urdf]);

  // ── 12. 全屏 ──
  useEffect(() => {
    const cb = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', cb);
    return () => document.removeEventListener('fullscreenchange', cb);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else if (document.exitFullscreen) document.exitFullscreen();
  };

  // ── 13. 点击获取地面坐标 ──
  const getGroundCoordinate = useCallback((e: React.MouseEvent): [number, number, number] | null => {
    if (!cameraRef.current || !containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, cameraRef.current);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const intersection = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(plane, intersection)) {
      return [intersection.x, intersection.y, 0];
    }
    return null;
  }, []);

  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (!isSettingGoal) return;
    const coords = getGroundCoordinate(e);
    if (coords) setGoalPosition([coords[0], coords[1]]);
  }, [isSettingGoal, getGroundCoordinate]);

  // ── 14. FPS 统计 ──
  useEffect(() => {
    const timer = setInterval(() => setRenderFps(fTimesRef.current.length), 1000);
    return () => clearInterval(timer);
  }, []);

  // ── UI 渲染 ──
  return (
    <div ref={containerRef} className="relative w-full h-full bg-slate-950 overflow-hidden" onContextMenu={e => e.preventDefault()}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full block"
        onClick={handleCanvasClick}
      />

      {/* 状态栏 */}
      <div className="absolute top-3 left-3 flex items-center gap-3">
        <div className="bg-white/85 backdrop-blur-sm p-2 rounded text-xs font-mono shadow text-slate-700">
          <span>WebGL · {renderFps} FPS</span>
          {isFollowing && <span className="ml-2 text-blue-600">● 跟随</span>}
        </div>
      </div>

      {/* 控制按钮 */}
      <div className="absolute bottom-4 right-4 flex items-center gap-2">
        <button
          onClick={() => {
            if (!isFollowing) {
              followOffsetRef.current = [0, 0, 0];
            }
            setIsFollowing(!isFollowing);
          }}
          className={`p-2 rounded shadow bg-white/85 backdrop-blur-sm transition-colors ${isFollowing ? 'text-blue-600' : 'text-slate-500'}`}
          title={isFollowing ? '取消跟随' : '跟随机器人'}
        >
          <Crosshair size={18} />
        </button>
        <button
          onClick={toggleFullscreen}
          className="p-2 rounded shadow bg-white/85 backdrop-blur-sm text-slate-600"
          title="全屏"
        >
          {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
        {config?.visualize && Object.values(config.visualize).some((v: any) => v?.topic === '/geojson') && (
          <button
            onClick={() => setIsSettingGoal(!isSettingGoal)}
            className={`p-2 rounded shadow bg-white/85 backdrop-blur-sm transition-colors ${isSettingGoal ? 'text-red-600' : 'text-slate-500'}`}
            title={isSettingGoal ? '取消设置目标' : '设置目标点'}
          >
            <Navigation size={18} />
          </button>
        )}
        {waypoints.length > 0 && (
          <div className="relative group">
            <MapPin size={18} className="m-2 text-slate-500 cursor-pointer" />
            <div className="absolute bottom-full mb-2 right-0 hidden group-hover:block bg-white shadow-lg rounded p-2 text-xs min-w-[120px]">
              {waypoints.map((w, i) => (
                <div key={i} className="py-0.5 whitespace-nowrap">{w.name}</div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});