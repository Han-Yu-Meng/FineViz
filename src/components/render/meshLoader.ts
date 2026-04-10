import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const meshCache: Record<string, any> = {};
const loader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('/draco/'); // Path to the decoders in public/draco/
loader.setDRACOLoader(dracoLoader);

export async function loadGLB(url: string): Promise<any> {
  if (meshCache[url]) return meshCache[url];

  const cleanUrl = url.replace(/\/+/g, '/');

  return new Promise((resolve, reject) => {
    loader.load(
      cleanUrl,
      (gltf) => {
        const scene = gltf.scene || gltf.scenes[0];
        
        scene.rotation.set(Math.PI / 2, 0, 0); 
        
        // 强制更新场景树矩阵，使旋转应用到所有子节点
        scene.updateMatrixWorld(true);

        const combinedPositions: number[] = [];
        const combinedNormals: number[] = [];

        scene.traverse((node) => {
          if ((node as THREE.Mesh).isMesh) {
            const mesh = node as THREE.Mesh;
            const geometry = mesh.geometry.index 
              ? mesh.geometry.toNonIndexed() 
              : mesh.geometry.clone();
            
            const posAttr = geometry.attributes.position;
            const normalAttr = geometry.attributes.normal;
            if (!posAttr) return;

            // 这里的 matrix 会包含我们上面设置的 scene.rotation
            const matrix = mesh.matrixWorld;
            const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);

            for (let i = 0; i < posAttr.count; i++) {
              const vertex = new THREE.Vector3().fromBufferAttribute(posAttr, i);
              vertex.applyMatrix4(matrix);
              combinedPositions.push(vertex.x, vertex.y, vertex.z);

              if (normalAttr) {
                const normal = new THREE.Vector3().fromBufferAttribute(normalAttr, i);
                normal.applyMatrix3(normalMatrix).normalize();
                combinedNormals.push(normal.x, normal.y, normal.z);
              } else {
                combinedNormals.push(0, 1, 0);
              }
            }
            geometry.dispose();
          }
        });

        if (combinedPositions.length === 0) {
          reject(new Error("No geometry found in GLB"));
          return;
        }

        const result = {
          attributes: {
            positions: { value: new Float32Array(combinedPositions), size: 3 },
            normals: { value: new Float32Array(combinedNormals), size: 3 }
          }
        };

        console.log(`[MeshLoader] Corrected & Flattened ${cleanUrl}`);
        meshCache[url] = result;
        resolve(result);
      },
      undefined,
      reject
    );
  });
}