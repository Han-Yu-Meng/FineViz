import { Matrix4 } from '@math.gl/core';
import { TFLink } from './types';

export function getFrameMatrix(frameId: string, tree: Record<string, TFLink>, fixedFrame: string): Matrix4 {
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
    // T_parent_child = Translate(link.position) * Rotate(link.rotation)
    const m = new Matrix4().fromQuaternion(link.rotation);
    m[12] = link.position[0];
    m[13] = link.position[1];
    m[14] = link.position[2];
    
    // mat = mat * m
    mat.multiplyRight(m);
  }
  return mat;
}