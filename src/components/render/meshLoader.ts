import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

// 缓存已加载的原始模型，每次调用返回深拷贝以支持多实例
const meshCache: Record<string, THREE.Group> = {};

const loader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('/draco/');
loader.setDRACOLoader(dracoLoader);

export async function loadGLB(url: string): Promise<THREE.Group> {
  if (meshCache[url]) {
    return meshCache[url].clone();
  }

  const cleanUrl = url.replace(/\/+/g, '/');

  return new Promise((resolve, reject) => {
    loader.load(
      cleanUrl,
      (gltf) => {
        const scene = (gltf.scene || gltf.scenes[0]) as THREE.Group;

        // 调整姿态以适配 ROS 坐标系 (Z 轴向上)
        scene.rotation.set(Math.PI / 2, 0, 0);
        scene.updateMatrixWorld(true);

        // 缓存原始模型，后续调用返回 clone 以支持多实例
        meshCache[url] = scene;
        resolve(scene.clone());
      },
      undefined,
      reject,
    );
  });
}
