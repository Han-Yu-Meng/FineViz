import { Matrix4, Quaternion } from '@math.gl/core';
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
    return new Matrix4(); 
  }

  for (let i = path.length - 1; i >= 0; i--) {
    const link = path[i];
    // T_parent_child = Translate(link.position) * Rotate(link.rotation)
    
    // 强制声明为严格的四元数对象，防止 math.gl 隐式类型转换导致的底层 Bug
    const q = new Quaternion(link.rotation[0], link.rotation[1], link.rotation[2], link.rotation[3]);
    const m = new Matrix4().fromQuaternion(q);
    
    m[12] = link.position[0];
    m[13] = link.position[1];
    m[14] = link.position[2];
    
    // mat = mat * m
    mat.multiplyRight(m);
  }
  return mat;
}