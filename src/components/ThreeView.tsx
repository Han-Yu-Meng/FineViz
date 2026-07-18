import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { Maximize, Minimize, Crosshair, MapPin, Navigation } from 'lucide-react';
import { PointCloudBinary, OccupancyGridRaw } from './render/types';
import { decodePointCloud } from './render/pointCloudDecoder';
import { decodeMarkerArray, MarkerPrimitive } from './render/markerDecoder';
import { decodeOccupancyGrid, OccupancyGridData } from './render/occupancyGridDecoder';
import { parseURDF, URDFRobot } from './render/urdfParser';
import { loadGLB } from './render/meshLoader';
import { AppConfig } from '../hooks/useConfig';

// ── 全局共享缓冲池 ──
const MAX_COMBINED_POINTS = 500000;
const COMBINED_POSITIONS = new Float32Array(MAX_COMBINED_POINTS * 3);
const COMBINED_COLORS = new Uint8Array(MAX_COMBINED_POINTS * 3);

// ── Web Worker 实例 ──
const useWorker = typeof Worker !== 'undefined';
const decoderWorker = useWorker
  ? new Worker(new URL('../workers/decoder.worker.ts', import.meta.url), { type: 'module' })
  : null;

// 生成圆形点纹理（模块级缓存）
let _circleTexture: THREE.Texture | null = null;
function getCircleTexture(): THREE.Texture {
  if (_circleTexture) return _circleTexture;
  const size = 64;
  const radius = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(255,255,255,0)';
  ctx.fillRect(0, 0, size, size);
  ctx.beginPath();
  ctx.arc(radius, radius, radius - 1, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fill();
  _circleTexture = new THREE.CanvasTexture(canvas);
  _circleTexture.needsUpdate = true;
  return _circleTexture;
}

// 缓存 Station 节点纹理（常态 & 悬停态）
let _normalNodeTexture: THREE.Texture | null = null;
let _hoveredNodeTexture: THREE.Texture | null = null;

function getNodeTexture(hovered: boolean): THREE.Texture {
  if (hovered && _hoveredNodeTexture) return _hoveredNodeTexture;
  if (!hovered && _normalNodeTexture) return _normalNodeTexture;

  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  // 绘制阴影
  ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;

  // 描边/外圈
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  ctx.fillStyle = hovered ? '#2563eb' : '#b4c6fc';
  ctx.fill();

  // 内芯
  ctx.shadowColor = 'transparent';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 10, 0, Math.PI * 2);
  ctx.fillStyle = hovered ? '#3b82f6' : '#ffffff';
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  if (hovered) _hoveredNodeTexture = texture;
  else _normalNodeTexture = texture;
  return texture;
}

// 绘制高清晰度抗锯齿文字标签 Sprite
function makeStationLabelSprite(text: string, isHovered: boolean, maxAnisotropy = 1): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  const fontSize = 24;
  ctx.font = `bold ${fontSize}px Inter, system-ui, -apple-system, sans-serif`;
  const textWidth = ctx.measureText(text).width;

  const paddingX = 32;
  const paddingY = 16;
  const rectWidth = textWidth + paddingX * 2;
  const rectHeight = fontSize + paddingY * 2;

  const canvasWidth = rectWidth + 24;
  const canvasHeight = rectHeight + 24;
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  ctx.font = `bold ${fontSize}px Inter, system-ui, -apple-system, sans-serif`;

  // 绘制高精度卡片投影
  ctx.shadowColor = 'rgba(15, 23, 42, 0.15)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 6;

  const rx = (canvasWidth - rectWidth) / 2;
  const ry = (canvasHeight - rectHeight) / 2;
  const radius = 12;

  ctx.beginPath();
  ctx.roundRect?.(rx, ry, rectWidth, rectHeight, radius);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
  ctx.fill();

  if (isHovered) {
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#3b82f6';
    ctx.stroke();
  }

  // 绘制纯净无投影文本
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = isHovered ? '#2563eb' : '#1e293b';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvasWidth / 2, canvasHeight / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;

  const spriteMat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });

  const sprite = new THREE.Sprite(spriteMat);
  const scaleFactor = 0.015 * (isHovered ? 1.15 : 1.0);
  sprite.scale.set(canvasWidth * scaleFactor, canvasHeight * scaleFactor, 1);
  return sprite;
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
  messages: Record<string, any[]>;
  topicVisibility: Record<string, boolean>;
  onSendMessage?: (topic: string, type: string, data: any) => void;
  meshModels: Record<string, any>;
  onMeshModelsChange: (models: Record<string, any>) => void;
  showRobotModel: boolean;
}

export const DeckGLView = React.memo(function ThreeView({
  config,
  messages,
  topicVisibility,
  onSendMessage,
  meshModels,
  onMeshModelsChange,
  showRobotModel,
}: ThreeViewProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isFollowing, setIsFollowing] = useState(true);
  const renderFpsRef = useRef(0);
  const fpsDisplayRef = useRef<HTMLDivElement>(null);

  const [robotPose, setRobotPose] = useState<{
    position: [number, number, number];
    orientation: [number, number, number, number];
  } | null>(null);
  const robotPoseRef = useRef<typeof robotPose>(null);
  const robotPoseMatrix = useRef(new THREE.Matrix4());
  const lastPoseUpdateRef = useRef(0);

  const [pointCloudData, setPointCloudData] = useState<Record<string, PointCloudBinary>>({});
  const pointCloudDataRef = useRef<Record<string, PointCloudBinary>>({});
  const [pathData, setPathData] = useState<Record<string, any>>({});
  const [markerData, setMarkerData] = useState<Record<string, Record<string, MarkerPrimitive[]>>>({});
  const [gridData, setGridData] = useState<Record<string, OccupancyGridData>>({});
  const [urdfRobot, setUrdfRobot] = useState<URDFRobot | null>(null);

  // 同步 ref 供动画循环读取，避免依赖 state 触发 effect 重启
  useEffect(() => { pointCloudDataRef.current = pointCloudData; }, [pointCloudData]);

  const [geojsonData, setGeojsonData] = useState<any>(null);
  const [hoveredStationId, setHoveredStationId] = useState<number | string | null>(null);
  const [confirmStation, setConfirmStation] = useState<any>(null);
  const lastGeoJsonRef = useRef<string>('');

  const [isSettingGoal, setIsSettingGoal] = useState(false);
  const [goalPosition, setGoalPosition] = useState<[number, number] | null>(null);
  const [goalYaw, setGoalYaw] = useState<number>(0);

  const isInteractingRef = useRef(false);
  const followOffsetRef = useRef<[number, number, number, number]>([0, 0, 0, 0]);
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
  const markerGroup = useRef<THREE.Group | null>(null);
  const pathGroup = useRef<THREE.Group | null>(null);
  const goalGroup = useRef<THREE.Group | null>(null);
  const geojsonGroup = useRef<THREE.Group | null>(null);

  const pointerDownPos = useRef(new THREE.Vector2());
  const goalDragActiveRef = useRef(false);

  // 临时变量池，杜绝循环内 GC
  const tempMatrix = useRef(new THREE.Matrix4());
  const tempPosition = useRef(new THREE.Vector3());
  const tempQuaternion = useRef(new THREE.Quaternion());
  const tempScale = useRef(new THREE.Vector3(1, 1, 1));
  const smoothedBasePos = useRef(new THREE.Vector3());

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
  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf1f5f9);
    sceneRef.current = scene;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.45);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    const gridHelper = new THREE.GridHelper(50, 50, 0xcbd5e1, 0xe2e8f0);
    gridHelper.rotation.x = Math.PI / 2;
    scene.add(gridHelper);

    const axesHelper = new THREE.AxesHelper(1);
    scene.add(axesHelper);

    const camera = new THREE.PerspectiveCamera(
      60,
      containerRef.current.clientWidth / containerRef.current.clientHeight,
      1.0,
      20000
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
    controls.rotateSpeed = 1.0;
    controls.zoomSpeed = 1.6;
    controls.panSpeed = 1.3;
    controls.screenSpacePanning = false;
    controls.enableDamping = false;

    controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };

    controls.touches = {
      ONE: THREE.TOUCH.PAN,
      TWO: THREE.TOUCH.DOLLY_ROTATE,
    };

    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    // 常驻场景节点
    robotModelGroup.current = new THREE.Group();
    scene.add(robotModelGroup.current);

    markerGroup.current = new THREE.Group();
    scene.add(markerGroup.current);

    pathGroup.current = new THREE.Group();
    scene.add(pathGroup.current);

    goalGroup.current = new THREE.Group();
    scene.add(goalGroup.current);

    geojsonGroup.current = new THREE.Group();
    scene.add(geojsonGroup.current);

    const handleResize = () => {
      if (!containerRef.current || !camera || !renderer) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    controls.addEventListener('start', () => {
      isUserInteractingRef.current = true;
    });
    controls.addEventListener('end', () => {
      isUserInteractingRef.current = false;
      if (lFollow.current) {
        followOffsetRef.current = [
          controls.target.x - smoothedBasePos.current.x,
          controls.target.y - smoothedBasePos.current.y,
          0,
          controls.target.z - smoothedBasePos.current.z,
        ];
      }
    });

    // ── 渲染循环 ──
    let animationId: number;
    let frameCount = 0;
    let fpsTimer = 0;

    const tick = (now: number) => {
      animationId = requestAnimationFrame(tick);

      controls.update();

      // 机器人镜头跟随平滑逻辑
      const pose = robotPoseRef.current;
      if (pose && cameraRef.current && controlsRef.current) {
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        // 平滑机器人物理坐标
        if (smoothedBasePos.current.length() === 0) {
          smoothedBasePos.current.set(pose.position[0], pose.position[1], pose.position[2]);
        } else {
          smoothedBasePos.current.lerp(
            tempPosition.current.set(pose.position[0], pose.position[1], pose.position[2]),
            0.35 // 提升插值率，跟手反馈响应度极高
          );
        }

        if (lFollow.current && !isUserInteractingRef.current) {
          const offset = followOffsetRef.current;
          const targetX = smoothedBasePos.current.x + offset[0];
          const targetY = smoothedBasePos.current.y + offset[1];
          const targetZ = smoothedBasePos.current.z + offset[2];
          // 🌟 核心修复：求得本次镜头中心点相对当前的位移增量 dx, dy, dz
          const dx = targetX - controls.target.x;
          const dy = targetY - controls.target.y;
          const dz = targetZ - controls.target.z;
          // 只有当坐标发生变化时，同时对观察中心和相机坐标进行完全相等的刚性偏移，锁死相对视角与焦距
          if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4 || Math.abs(dz) > 1e-4) {
            controls.target.set(targetX, targetY, targetZ);
            camera.position.x += dx;
            camera.position.y += dy;
            camera.position.z += dz;
          }
        }
      }

      renderer.render(scene, camera);

      frameCount++;
      if (now - fpsTimer >= 1000) {
        renderFpsRef.current = frameCount;
        if (fpsDisplayRef.current) {
          const pc = Object.values(pointCloudDataRef.current).reduce((a, b) => a + b.length, 0);
          fpsDisplayRef.current.textContent = `Pts: ${pc.toLocaleString()} | FPS: ${frameCount}`;
        }
        frameCount = 0;
        fpsTimer = now;
      }
    };
    animationId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();
      renderer.dispose();
    };
  }, []);

  // ── 2. 点云更新 (原地覆盖 Buffer) ──
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
          new THREE.BufferAttribute(new Float32Array(MAX_COMBINED_POINTS * 3), 3)
        );
        geometry.setAttribute(
          'color',
          new THREE.BufferAttribute(new Uint8Array(MAX_COMBINED_POINTS * 3), 3, true)
        );

        const material = new THREE.PointsMaterial({
          size: d.pointSize ?? 3,
          sizeAttenuation: false,
          map: getCircleTexture(),
          vertexColors: true,
          transparent: true,
          opacity: d.alpha ?? 1.0,
          depthWrite: false,
          blending: THREE.NormalBlending,
        });

        pointsObj = new THREE.Points(geometry, material);
        pointsObj.frustumCulled = false;
        scene.add(pointsObj);
        pointCloudObjects.current[topic] = pointsObj;
      } else {
        const mat = pointsObj.material as THREE.PointsMaterial;
        mat.size = d.pointSize ?? 3;
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

      // 根据 YAML 配置的 frame 字段决定矩阵
      const baseFrame = config?.robot?.base_frame || 'base_link';
      const vizEntry = Object.values(config?.visualize || {}).find((v: any) => v?.topic === topic) as any;
      const frame = vizEntry?.frame || 'map';
      if (frame === baseFrame) {
        pointsObj.matrix.copy(robotPoseMatrix.current);
      } else {
        pointsObj.matrix.identity();
      }
      pointsObj.matrixAutoUpdate = false;
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
  }, [pointCloudData, robotPose, topicVisibility, config?.robot?.base_frame, config?.visualize]);

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
        ([_, c]: [string, any]) => c.topic === topic
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
          depthTest: false,
        });
        mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = -1;
        scene.add(mesh);
        gridObjects.current[topic] = mesh;
      } else {
        const mat = mesh.material as THREE.MeshBasicMaterial;
        if (mat.map) mat.map.dispose();
        mat.map = texture;
        mat.opacity = alpha;
        mat.needsUpdate = true;
      }

      // 根据 YAML 配置的 frame 字段决定矩阵
      const baseFrame = config?.robot?.base_frame || 'base_link';
      const vizEntry = Object.values(config?.visualize || {}).find((v: any) => v?.topic === topic) as any;
      const frame = vizEntry?.frame || 'map';
      const matArray = frame === baseFrame && robotPose ? robotPoseMatrix.current.toArray() : null;
      if (matArray) {
        tempMatrix.current.fromArray(matArray);
        const originMat = new THREE.Matrix4().compose(
          new THREE.Vector3(...d.origin.position),
          new THREE.Quaternion(...d.origin.orientation),
          new THREE.Vector3(1, 1, 1)
        );
        const scaleMat = new THREE.Matrix4().compose(
          new THREE.Vector3(halfW, halfH, 0),
          new THREE.Quaternion(),
          new THREE.Vector3(gridW, gridH, 1)
        );
        mesh.matrix.copy(tempMatrix.current.clone().multiply(originMat).multiply(scaleMat));
        mesh.matrixAutoUpdate = false;
      } else {
        const originMat = new THREE.Matrix4().compose(
          new THREE.Vector3(...d.origin.position),
          new THREE.Quaternion(...d.origin.orientation),
          new THREE.Vector3(1, 1, 1)
        );
        const scaleMat = new THREE.Matrix4().compose(
          new THREE.Vector3(halfW, halfH, 0),
          new THREE.Quaternion(),
          new THREE.Vector3(gridW, gridH, 1)
        );
        mesh.matrix.copy(new THREE.Matrix4().identity().multiply(originMat).multiply(scaleMat));
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
  }, [gridData, robotPose, topicVisibility, config?.visualize, config?.robot?.base_frame]);

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
      // 根 link 从 robotPose 获取世界矩阵，否则回退到 identity
      defaultWorldMatrices[baseFrame] = robotPose ? robotPoseMatrix.current.clone() : new THREE.Matrix4().identity();
      const computeDefaultPose = (parentName: string) => {
        Object.values(urdfRobot.joints).forEach(joint => {
          const pName = String(joint.parent);
          const cName = String(joint.child);
          if (pName === parentName && !defaultWorldMatrices[cName]) {
            const r = joint.origin.rpy[0],
              p = joint.origin.rpy[1],
              y = joint.origin.rpy[2];
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r, p, y, 'XYZ'));
            const localMat = new THREE.Matrix4().compose(
              new THREE.Vector3(...joint.origin.xyz),
              q,
              new THREE.Vector3(1, 1, 1)
            );
            defaultWorldMatrices[cName] = new THREE.Matrix4().multiplyMatrices(
              defaultWorldMatrices[parentName],
              localMat
            );
            computeDefaultPose(cName);
          }
        });
      };
      computeDefaultPose(baseFrame);
    }

    Object.keys(urdfRobot.links).forEach(linkName => {
      const link = urdfRobot.links[linkName];
      const worldMat = defaultWorldMatrices[linkName]
        ? defaultWorldMatrices[linkName].clone()
        : new THREE.Matrix4().identity();

      link.visuals.forEach(v => {
        if (!v.geometry.mesh || !meshModels[v.geometry.mesh.filename]) return;

        const model = meshModels[v.geometry.mesh.filename] as THREE.Group;
        const instance = model.clone();

        const r = v.origin.rpy[0],
          p = v.origin.rpy[1],
          y = v.origin.rpy[2];
        tempQuaternion.current.setFromEuler(new THREE.Euler(r, p, y, 'XYZ'));
        tempPosition.current.set(v.origin.xyz[0], v.origin.xyz[1], v.origin.xyz[2]);

        const localMat = new THREE.Matrix4().compose(
          tempPosition.current,
          tempQuaternion.current,
          tempScale.current.set(1, 1, 1)
        );

        instance.matrix.copy(worldMat.clone().multiply(localMat).multiply(model.matrix));
        instance.matrixAutoUpdate = false;
        group.add(instance);
      });
    });
  }, [urdfRobot, meshModels, robotPose, showRobotModel, config?.robot?.base_frame]);

  // ── 5. Marker 更新 ──
  useEffect(() => {
    const group = markerGroup.current;
    if (!group) return;

    while (group.children.length > 0) group.remove(group.children[0]);

    const baseFrame = config?.robot?.base_frame || 'base_link';
    Object.entries(markerData).forEach(([topic, frames]) => {
      const vizEntry = Object.values(config?.visualize || {}).find((v: any) => v?.topic === topic) as any;
      const frame = vizEntry?.frame || 'map';
      const worldMat = (frame === baseFrame && robotPose)
        ? robotPoseMatrix.current.clone()
        : new THREE.Matrix4().identity();

      Object.entries(frames).forEach(([_frameId, markers]) => {
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
                new THREE.Matrix4().makeTranslation(m.position[0], m.position[1], m.position[2])
              )
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
  }, [markerData, robotPose, config?.visualize, config?.robot?.base_frame]);
  useEffect(() => {
    const group = pathGroup.current;
    if (!group) return;

    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      if (child instanceof Line2) {
        child.geometry.dispose();
        child.material.dispose();
      } else if (child instanceof THREE.Line) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      }
    }

    const rendererSize = rendererRef.current?.getSize(new THREE.Vector2()) || new THREE.Vector2(800, 600);

    const baseFrame = config?.robot?.base_frame || 'base_link';
    Object.entries(pathData).forEach(([topic, d]) => {
      if (!d.path || d.path.length < 2) return;
      const vizEntry = Object.values(config?.visualize || {}).find((v: any) => v?.topic === topic) as any;
      const frame = vizEntry?.frame || 'map';
      const worldMat = (frame === baseFrame && robotPose)
        ? robotPoseMatrix.current.clone()
        : new THREE.Matrix4().identity();

      const positions: number[] = [];
      d.path.forEach((p: number[]) => {
        positions.push(p[0], p[1], (p[2] || 0) + 0.03);
      });

      const color = new THREE.Color(
        (d.color?.[0] ?? 93) / 255,
        (d.color?.[1] ?? 153) / 255,
        (d.color?.[2] ?? 227) / 255
      );
      // 从配置中读取线宽，默认 0.15 世界单位（约 15cm）
      const lineWidth = d.width ? d.width / 20 : 0.15;

      const geo = new LineGeometry();
      geo.setPositions(positions);
      const mat = new LineMaterial({
        color: color.getHex(),
        linewidth: lineWidth,
        worldUnits: true,
        transparent: true,
        opacity: 0.9,
        depthTest: true,
        resolution: rendererSize,
      });
      const line = new Line2(geo, mat);
      line.matrix.copy(worldMat);
      line.matrixAutoUpdate = false;
      group.add(line);
    });
  }, [pathData, robotPose, config?.visualize, config?.robot?.base_frame]);

  // ── 8. Goal pose 箭头 ──
  useEffect(() => {
    const group = goalGroup.current;
    if (!group) return;

    while (group.children.length > 0) group.remove(group.children[0]);

    if (!goalPosition || !isSettingGoal) return;

    const arrowLen = 1.2;
    const z = 0.15;
    const startX = goalPosition[0];
    const startY = goalPosition[1];
    const endX = startX + Math.cos(goalYaw) * arrowLen;
    const endY = startY + Math.sin(goalYaw) * arrowLen;

    // 箭杆 —— 红色粗圆柱
    const shaftRadius = 0.08;
    const shaftGeo = new THREE.CylinderGeometry(shaftRadius, shaftRadius, arrowLen, 8);
    const shaftMat = new THREE.MeshBasicMaterial({ color: 0xff3232 });
    const shaftMesh = new THREE.Mesh(shaftGeo, shaftMat);
    shaftMesh.position.set((startX + endX) / 2, (startY + endY) / 2, z);
    shaftMesh.rotation.set(0, 0, goalYaw - Math.PI / 2);
    group.add(shaftMesh);

    // 箭头 —— 红色圆锥
    const headLength = 0.4;
    const headRadius = 0.2;
    const headGeo = new THREE.ConeGeometry(headRadius, headLength, 12, 1);
    const headMat = new THREE.MeshBasicMaterial({ color: 0xff3232 });
    const headMesh = new THREE.Mesh(headGeo, headMat);
    headMesh.position.set(endX, endY, z);
    headMesh.rotation.set(0, 0, goalYaw - Math.PI / 2);
    group.add(headMesh);
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
    const msgs = lMsgs.current,
      cfg = lCfg.current,
      vis = lVis.current;
    if (!cfg) return;

    // --- Point Cloud ---
    const pcConfigs = Object.values(cfg.visualize || {}).filter(
      (item: any) => item?.type === 'sensor_msgs/msg/PointCloud2' && item?.topic
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
        ? c.last_time > 0
          ? m.filter((msg: any) => (msg.receivedAt || 0) >= now - c.last_time * 1000)
          : [m[m.length - 1]]
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
          },
        });
      } else {
        const res = sel
          .map(s => {
            const decoded = decodePointCloud(s.data, c.color_field, c.color_scheme, 100000);
            if (decoded && decoded.frameId.startsWith('/'))
              decoded.frameId = decoded.frameId.substring(1);
            return decoded;
          })
          .filter(r => r !== null) as PointCloudBinary[];
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
            alpha: c.alpha,
          };
          setPointCloudData(prev => ({ ...prev, ...nextPc }));
        }
      }
    }

    // --- Path ---
    const pathConfigs = Object.values(cfg.visualize || {}).filter(
      (item: any) => item?.type === 'nav_msgs/msg/Path' && item?.topic
    );
    const nextPaths: Record<string, any> = {};
    for (const c of pathConfigs as any[]) {
      if (!(vis[c.topic] ?? true)) continue;
      const m = msgs[c.topic] || [];
      if (m.length === 0) continue;
      const sel = c.listen_updates
        ? c.last_time > 0
          ? m.filter((msg: any) => (msg.receivedAt || 0) >= now - c.last_time * 1000)
          : [m[m.length - 1]]
        : [m[m.length - 1]];
      if (sel.length === 0) continue;
      const latest = sel[sel.length - 1];
      if (!latest.data?.poses) continue;
      const pathPoints = latest.data.poses.map((p: any) => [
        p.pose.position.x,
        p.pose.position.y,
        p.pose.position.z || 0,
      ]);
      let frameId = latest.data.header?.frame_id || 'map';
      if (frameId.startsWith('/')) frameId = frameId.substring(1);
      let r = 93,
        g = 153,
        b = 227,
        a = Math.floor((c.alpha || 1.0) * 255);
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
        width: c.width || 3,
      };
    }
    setPathData(nextPaths);

    // --- Update Marker ---
    const markerConfigs = Object.values(cfg.visualize || {}).filter(
      (item: any) => item?.type === 'visualization_msgs/msg/MarkerArray' && item?.topic
    );
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
    const gridConfigs = Object.values(cfg.visualize || {}).filter(
      (item: any) => item?.type === 'nav_msgs/msg/OccupancyGrid' && item?.topic
    );
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
          },
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
    const geojsonConfig = Object.values(cfg.visualize || {}).find(
      (item: any) => item?.topic === '/geojson'
    );
    if (geojsonConfig) {
      const m = msgs[geojsonConfig.topic] || [];
      if (m.length > 0) {
        const latest = m[m.length - 1];
        const jsonStr = latest.data?.data;
        if (jsonStr && typeof jsonStr === 'string' && jsonStr !== lastGeoJsonRef.current) {
          lastGeoJsonRef.current = jsonStr;
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed?.type === 'FeatureCollection') setGeojsonData(parsed);
          } catch {}
        }
      }
    }

    // --- Pose (20Hz throttle) ---
    const poseTopic = cfg.pose?.topic;
    if (poseTopic) {
      const poseMsgs = msgs[poseTopic] || [];
      if (poseMsgs.length > 0) {
        const now = Date.now();
        if (now - lastPoseUpdateRef.current >= 50) {  // 20Hz
          lastPoseUpdateRef.current = now;
          const latest = poseMsgs[poseMsgs.length - 1];
          const p = latest.data?.pose;
          if (p?.position && p?.orientation) {
            const newPose = {
              position: [p.position.x, p.position.y, p.position.z] as [number, number, number],
              orientation: [p.orientation.x, p.orientation.y, p.orientation.z, p.orientation.w] as [number, number, number, number],
            };
            setRobotPose(newPose);
            robotPoseRef.current = newPose;
            const m = new THREE.Matrix4();
            m.compose(
              new THREE.Vector3(p.position.x, p.position.y, p.position.z),
              new THREE.Quaternion(p.orientation.x, p.orientation.y, p.orientation.z, p.orientation.w),
              new THREE.Vector3(1, 1, 1)
            );
            robotPoseMatrix.current = m;
          }
        }
      }
    }
  }, [config?.pose?.topic]);

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
      fetch(fullUrdfPath)
        .then(r => r.text())
        .then(async xml => {
          const robot = await parseURDF(xml, urdfFullPath);
          setUrdfRobot(robot);
          const meshesToLoad = new Set<string>();
          Object.values(robot.links).forEach(link => {
            link.visuals.forEach(v => {
              if (v.geometry.mesh) meshesToLoad.add(v.geometry.mesh.filename);
            });
          });
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

  // ── 11b. GeoJSON 回调 ──
  const computeStationYaw = useCallback(
    (feature: any): number => {
      const coords = feature.geometry.coordinates;
      if (!geojsonData) return 0;
      const lineStrings = geojsonData.features.filter((f: any) => f.geometry.type === 'LineString');
      for (const ls of lineStrings) {
        const lineCoords = ls.geometry.coordinates;
        const idx = lineCoords.findIndex(
          (c: any) => Math.abs(c[0] - coords[0]) < 1e-4 && Math.abs(c[1] - coords[1]) < 1e-4
        );
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
    },
    [geojsonData]
  );

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
        frame_id: 'map',
        stamp: { sec: Math.floor(Date.now() / 1000), nanosec: (Date.now() % 1000) * 1000000 },
      },
      pose: {
        position: { x: coords[0], y: coords[1], z: coords[2] || 0 },
        orientation: { x: 0, y: 0, z: qz, w: qw },
      },
    };
    onSendMessage?.('/goal_pose', 'geometry_msgs/msg/PoseStamped', poseData);
    setConfirmStation(null);
  }, [confirmStation, computeStationYaw, onSendMessage]);

  const line2Refs = useRef<Line2[]>([]);
  const stationMeshMapRef = useRef<
    Map<
      number | string,
      {
        circle: THREE.Sprite;
        label: THREE.Sprite;
        hitbox: THREE.Mesh; // 🌟 物理碰撞解耦箱
        feature: any;
      }
    >
  >(new Map());

  // ── GeoJSON 纯静态构建 ──
  useEffect(() => {
    const group = geojsonGroup.current;
    if (!group) return;

    // 清理旧场景节点
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      if (child instanceof THREE.Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      } else if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      } else if (child instanceof Line2) {
        child.geometry.dispose();
        child.material.dispose();
      }
    }

    line2Refs.current = [];
    stationMeshMapRef.current.clear();

    if (!geojsonData) {
      return;
    }

    const lineStrings = geojsonData.features.filter((f: any) => f.geometry.type === 'LineString');
    const trips = lineStrings.map((feature: any, index: number) => {
      const coordinates = feature.geometry.coordinates;
      return {
        id: feature.properties?.id || index,
        path: coordinates,
        color: feature.properties?.color || [99, 102, 241],
      };
    });

    const rendererSize = rendererRef.current?.getSize(new THREE.Vector2()) || new THREE.Vector2(800, 600);
    const maxAnisotropy = rendererRef.current ? rendererRef.current.capabilities.getMaxAnisotropy() : 1;

    // 1. 绘制静止拓扑线条底图（纯静态一次性生成，无任何动态顶点修改，防显卡溢出闪烁错线）
    trips.forEach(trip => {
      if (trip.path.length < 2) return;
      const positions: number[] = [];
      trip.path.forEach((c: number[]) => {
        positions.push(c[0], c[1], (c[2] || 0) + 0.04);
      });
      const geo = new LineGeometry();
      geo.setPositions(positions);
      const mat = new LineMaterial({
        color: 0x6366f1, // 静态蓝色
        linewidth: 0.15,
        worldUnits: true,
        transparent: true,
        opacity: 0.8,
        depthTest: true,
        resolution: rendererSize,
      });
      const line = new Line2(geo, mat);
      group.add(line);
      line2Refs.current.push(line);
    });

    // 2. 绘制 Station 圆点、超清文字标签以及【水平地面物理碰撞盒】
    const pointFeatures = geojsonData.features.filter((f: any) => f.geometry.type === 'Point');
    pointFeatures.forEach((feature: any) => {
      const coords = feature.geometry.coordinates;
      const z = (coords[2] || 0) + 0.06;
      const id = feature.properties?.id;
      if (id == null) return;

      // 视觉圆圈（常态）
      const circleSpriteMat = new THREE.SpriteMaterial({
        map: getNodeTexture(false),
        transparent: true,
        depthTest: true,
      });
      const circleSprite = new THREE.Sprite(circleSpriteMat);
      circleSprite.position.set(coords[0], coords[1], z);
      circleSprite.scale.setScalar(0.75);
      group.add(circleSprite);

      // 超清文字标签 Sprite
      const labelText = feature.properties?.frame || id.toString() || '';
      const labelSprite = makeStationLabelSprite(labelText, false, maxAnisotropy);
      labelSprite.position.set(coords[0], coords[1], z + 0.35);
      group.add(labelSprite);

      // 🌟 [物理碰撞解耦箱]：在地面（XY平面）绘制一个圆盘。
      // 它的大小及法线绝对固定，Raycaster 通过该圆盘实现全角度的极速、精准捕捉，彻底消除了基于 Sprite 面板空间计算带来的倾角偏移 Bug。
      const clickGeo = new THREE.CircleGeometry(1.0, 16);
      const clickMat = new THREE.MeshBasicMaterial({
        visible: false, // 纯隐形，仅用于物理射线反射
      });
      const clickMesh = new THREE.Mesh(clickGeo, clickMat);
      clickMesh.position.set(coords[0], coords[1], z);
      clickMesh.userData = { feature, isStationHitbox: true };
      group.add(clickMesh);

      stationMeshMapRef.current.set(id, {
        circle: circleSprite,
        label: labelSprite,
        hitbox: clickMesh,
        feature,
      });
    });
  }, [geojsonData]);

  // ── 独立悬停状态样式更新 ──
  useEffect(() => {
    const maxAnisotropy = rendererRef.current ? rendererRef.current.capabilities.getMaxAnisotropy() : 1;
    stationMeshMapRef.current.forEach((objs, id) => {
      const isHovered = id === hoveredStationId;

      objs.circle.material.map = getNodeTexture(isHovered);
      objs.circle.material.needsUpdate = true;
      objs.circle.scale.setScalar(isHovered ? 1.0 : 0.75);

      const labelText = objs.feature.properties?.frame || id.toString();
      const oldMap = objs.label.material.map;

      const newLabelSprite = makeStationLabelSprite(labelText, isHovered, maxAnisotropy);
      objs.label.material.map = newLabelSprite.material.map;
      objs.label.material.needsUpdate = true;
      objs.label.scale.copy(newLabelSprite.scale);

      if (oldMap) oldMap.dispose();
      newLabelSprite.material.dispose();
    });
  }, [hoveredStationId]);

  // ── Line2 物理视窗尺寸响应更新 ──
  useEffect(() => {
    const handleResize = () => {
      const size = rendererRef.current?.getSize(new THREE.Vector2());
      if (!size) return;
      // 更新所有 Line2 材质的分辨率（GeoJSON 线条 + Path 路径线）
      const allGroups = [geojsonGroup.current, pathGroup.current];
      allGroups.forEach(group => {
        if (!group) return;
        group.children.forEach(child => {
          if (child instanceof Line2) {
            (child.material as LineMaterial).resolution.copy(size);
          }
        });
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // ── 全屏响应 ──
  useEffect(() => {
    const cb = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', cb);
    return () => document.removeEventListener('fullscreenchange', cb);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else if (document.exitFullscreen) document.exitFullscreen();
  };

  // ── 逆向投影获取地面坐标 ──
  const getGroundCoordinate = useCallback((e: { clientX: number; clientY: number }): [number, number, number] | null => {
    if (!cameraRef.current || !canvasRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
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

  // ── 🌟 [物理碰撞盒精准光线射线拾取] ──
  const getStationFromClick = useCallback((clientX: number, clientY: number): any | null => {
    const camera = cameraRef.current;
    const canvas = canvasRef.current;
    if (!camera || !canvas || !geojsonGroup.current) return null;

    const rect = canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2();
    // 使用 Canvas 自身的物理边界进行 NDC 换算，完全不受外层布局错位影响
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    // 碰撞检测，专门捕获平铺在 XY 面上的 invisible Hitbox。
    // 这将光线求交完全限制在平整的三维平面上，实现 100% 精准检测，不受相机仰角和缩放距离的制约。
    const intersects = raycaster.intersectObjects(geojsonGroup.current.children, true);
    for (const hit of intersects) {
      if (hit.object.userData?.isStationHitbox) {
        return hit.object.userData.feature;
      }
    }
    return null;
  }, []);

  // ── 鼠标/指针交互事件 ──
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      pointerDownPos.current.set(e.clientX, e.clientY);

      if (isSettingGoal) {
        const coords = getGroundCoordinate(e as any);
        if (coords) {
          setGoalPosition([coords[0], coords[1]]);
          setGoalYaw(0);
          goalDragActiveRef.current = true;
          if (controlsRef.current) controlsRef.current.enabled = false;
        }
      }
    },
    [isSettingGoal, getGroundCoordinate]
  );

  const handleCanvasMouseMove = useCallback(
    (e: { clientX: number; clientY: number }) => {
      if (isSettingGoal && goalDragActiveRef.current && goalPosition) {
        const coords = getGroundCoordinate(e);
        if (coords) {
          const dx = coords[0] - goalPosition[0];
          const dy = coords[1] - goalPosition[1];
          setGoalYaw(Math.atan2(dy, dx));
        }
        return;
      }

      // 精确光线拾取悬停对象
      const hoveredFeature = getStationFromClick(e.clientX, e.clientY);
      if (hoveredFeature) {
        setHoveredStationId(hoveredFeature.properties?.id ?? null);
      } else {
        setHoveredStationId(null);
      }
    },
    [isSettingGoal, goalPosition, getGroundCoordinate, getStationFromClick]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (controlsRef.current) controlsRef.current.enabled = true;

      if (isSettingGoal && goalDragActiveRef.current && goalPosition) {
        goalDragActiveRef.current = false;
        const qz = Math.sin(goalYaw / 2);
        const qw = Math.cos(goalYaw / 2);
        const poseData = {
          header: {
            frame_id: 'map',
            stamp: { sec: Math.floor(Date.now() / 1000), nanosec: (Date.now() % 1000) * 1000000 },
          },
          pose: {
            position: { x: goalPosition[0], y: goalPosition[1], z: 0 },
            orientation: { x: 0, y: 0, z: qz, w: qw },
          },
        };
        onSendMessage?.('/goal_pose', 'geometry_msgs/msg/PoseStamped', poseData);
        setIsSettingGoal(false);
        setGoalPosition(null);
        setGoalYaw(0);
        return;
      }

      const dx = e.clientX - pointerDownPos.current.x;
      const dy = e.clientY - pointerDownPos.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > 3) return;

      // 物理碰撞盒直接唤出导航弹窗
      const clickedFeature = getStationFromClick(e.clientX, e.clientY);
      if (clickedFeature) {
        handleStationClick(clickedFeature);
      }
    },
    [isSettingGoal, goalPosition, goalYaw, onSendMessage, handleStationClick, getStationFromClick]
  );

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-slate-100 overflow-hidden"
      onContextMenu={e => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full block"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerMove={handleCanvasMouseMove}
        style={{ cursor: hoveredStationId ? 'pointer' : 'grab' }}
      />

      {isSettingGoal && (
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-blue-600 text-white px-4 py-2 rounded-full shadow-lg text-xs font-semibold animate-pulse z-20">
          点击拖拽设置目标位置和朝向
        </div>
      )}

      <div className="absolute bottom-4 right-4 flex items-center gap-2">
        <div ref={fpsDisplayRef} className="bg-white/80 backdrop-blur-sm p-2 rounded text-xs font-mono shadow text-slate-700">
          Pts: {Object.values(pointCloudData).reduce((a, b) => a + b.length, 0).toLocaleString()} | FPS: --
        </div>
        <button
          onClick={() => setIsSettingGoal(!isSettingGoal)}
          className={`bg-white/80 backdrop-blur-sm p-1.5 rounded shadow focus:outline-none transition-colors ${
            isSettingGoal ? 'bg-blue-600 text-white' : 'text-slate-600 hover:text-blue-600'
          }`}
          title="Set Goal Pose"
        >
          <Navigation size={18} />
        </button>
        <button
          onClick={() => {
            if (!isFollowing) {
              followOffsetRef.current = [0, 0, 0, 0];
            }
            setIsFollowing(!isFollowing);
          }}
          className={`bg-white/80 backdrop-blur-sm p-1.5 rounded shadow focus:outline-none transition-colors ${
            isFollowing ? 'text-blue-600' : 'text-slate-600 hover:text-blue-600'
          }`}
          title={isFollowing ? 'Stop Following' : 'Follow base_link'}
        >
          <Crosshair size={18} className={isFollowing ? 'animate-pulse' : ''} />
        </button>
        <button
          onClick={toggleFullscreen}
          className="bg-white/80 backdrop-blur-sm p-1.5 rounded shadow text-slate-600 hover:text-blue-600 focus:outline-none transition-colors"
          title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
        >
          {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      </div>

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
});