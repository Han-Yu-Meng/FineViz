import { PointCloudBinary } from './types';

// 预计算 LUT 颜色表
const WARM_LUT = new Uint8Array(256 * 3);
const TURBO_LUT = new Uint8Array(256 * 3);

export function getWarmColorRaw(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  return [
    Math.min(255, Math.max(0, Math.round(255 * (x * 3)))),
    Math.min(255, Math.max(0, Math.round(255 * (x * 3 - 1)))),
    Math.min(255, Math.max(0, Math.round(255 * (x * 3 - 2)))),
  ];
}

export function getTurboColorRaw(t: number): [number, number, number] {
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

for (let i = 0; i < 256; i++) {
  const t = i / 255;
  const w = getWarmColorRaw(t);
  WARM_LUT[i * 3] = w[0]; WARM_LUT[i * 3 + 1] = w[1]; WARM_LUT[i * 3 + 2] = w[2];
  const tb = getTurboColorRaw(t);
  TURBO_LUT[i * 3] = tb[0]; TURBO_LUT[i * 3 + 1] = tb[1]; TURBO_LUT[i * 3 + 2] = tb[2];
}

export function getWarmColor(t: number) { return getWarmColorRaw(t); }
export function getTurboColor(t: number) { return getTurboColorRaw(t); }

// 限制最终送显的最大点数
const MAX_GLOBAL_POINTS = 80000; 

// 静态复用缓冲区，消灭运行时对象分配与 GC 压力
const SHARED_POSITIONS = new Float32Array(MAX_GLOBAL_POINTS * 3);
const SHARED_COLORS = new Uint8Array(MAX_GLOBAL_POINTS * 3);
const SHARED_VALS = new Float32Array(MAX_GLOBAL_POINTS);

// 用于快速选择（Quickselect）的共享索引与距离缓存（上限 15 万点，超过则直接在第一阶段物理裁剪）
const MAX_TEMP_POINTS = 150000;
const TEMP_INDICES = new Int32Array(MAX_TEMP_POINTS);
const TEMP_DISTS = new Float32Array(MAX_TEMP_POINTS);

/**
 * 快速选择算法 (Hoare's Selection Algorithm)
 * 重新排列 indices 数组，使得前 k 个元素对应的距离 dists 都是最小的。
 * 平均时间复杂度: O(N)
 */
function quickselect(dists: Float32Array, indices: Int32Array, left: number, right: number, k: number): void {
  while (left < right) {
    const pivotIndex = partition(dists, indices, left, right);
    if (k === pivotIndex) {
      return;
    } else if (k < pivotIndex) {
      right = pivotIndex - 1;
    } else {
      left = pivotIndex + 1;
    }
  }
}

function partition(dists: Float32Array, indices: Int32Array, left: number, right: number): number {
  const pivotDist = dists[right];
  let i = left;
  for (let j = left; j < right; j++) {
    if (dists[j] <= pivotDist) {
      // 交换距离值
      const tempDist = dists[i];
      dists[i] = dists[j];
      dists[j] = tempDist;

      // 交换对应原始点云的索引
      const tempIdx = indices[i];
      indices[i] = indices[j];
      indices[j] = tempIdx;

      i++;
    }
  }
  // 将基准值交换到中间
  const tempDist = dists[i];
  dists[i] = dists[right];
  dists[right] = tempDist;

  const tempIdx = indices[i];
  indices[i] = indices[right];
  indices[right] = tempIdx;

  return i;
}

export function readFieldValue(dataView: DataView, byteOffset: number, datatype: number, littleEndian: boolean): number {
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

export function decodePointCloud(msg: any, colorField: string | undefined, colorScheme: string | undefined, targetMaxPoints: number): PointCloudBinary | null {
  if (!msg || !msg.fields || !msg.data) return null;
  
  let frameId = msg.header?.frame_id || 'map';
  if (frameId.startsWith('/')) {
    frameId = frameId.substring(1);
  }

  const isGlobalFrame = frameId === 'map' || frameId === 'odom' || frameId === 'world';

  const fields = msg.fields as any[];
  const xf = fields.find(f => f.name === 'x'), yf = fields.find(f => f.name === 'y'), zf = fields.find(f => f.name === 'z');
  if (!xf || !yf || !zf) return null;
  const cf = colorField ? fields.find(f => f.name === colorField) : undefined;
  const bytes = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
  const le = !msg.is_bigendian, step = msg.point_step, total = Math.min(msg.width * msg.height, Math.floor(bytes.byteLength / step));
  
  const actualTarget = Math.min(targetMaxPoints, MAX_GLOBAL_POINTS);
  
  const pos = SHARED_POSITIONS; 
  const col = SHARED_COLORS; 
  const vals = cf ? SHARED_VALS : null;
  
  let min = Infinity, max = -Infinity, idx = 0;
  
  const isAlignedFloat = le && bytes.byteOffset % 4 === 0 && step % 4 === 0 && xf.offset % 4 === 0 && yf.offset % 4 === 0 && zf.offset % 4 === 0 && (!cf || (cf.offset % 4 === 0 && cf.datatype === 7));

  let validCount = 0;

  if (isAlignedFloat) {
    const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const sW = step / 4, xW = xf.offset / 4, yW = yf.offset / 4, zW = zf.offset / 4, cW = cf ? cf.offset / 4 : 0;
    
    // 第一阶段：收集有效点并执行快速距离计算
    for (let i = 0; i < total; i++) {
        const b = i * sW;
        const x = f32[b + xW], y = f32[b + yW], z = f32[b + zW];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

        const distSq = x * x + y * y + z * z;

        // 📱 远景梯度快速初筛
        if (!isGlobalFrame) {
          if (distSq > 3600) {
            continue; // 直接裁剪丢弃 60 米外的噪点
          } else if (distSq > 1600) {
            if (i % 8 !== 0) continue; // 40m~60m 远景区保留 12.5%
          } else if (distSq > 400) {
            if (i % 3 !== 0) continue; // 20m~40m 中景区保留 33.3%
          }
        }

        if (validCount < MAX_TEMP_POINTS) {
          TEMP_INDICES[validCount] = i;
          TEMP_DISTS[validCount] = distSq;
          validCount++;
        }
    }

    const targetCount = Math.min(validCount, actualTarget);

    // 第二阶段：如果点数依然超出目标，利用 Quickselect 过滤，只保留最近的 targetCount 个点
    if (validCount > actualTarget) {
      quickselect(TEMP_DISTS, TEMP_INDICES, 0, validCount - 1, targetCount - 1);
    }

    // 第三阶段：只提取被筛选留下的最近点云坐标与颜色
    for (let k = 0; k < targetCount; k++) {
      const i = TEMP_INDICES[k];
      const b = i * sW;
      const x = f32[b + xW], y = f32[b + yW], z = f32[b + zW];

      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      if (cf && vals) {
          const v = f32[b + cW];
          if (Number.isFinite(v)) {
              vals[k] = v;
              if (v < min) min = v;
              if (v > max) max = v;
          } else {
              vals[k] = 0;
          }
      } else { 
          col[k * 3] = 255; col[k * 3 + 1] = 255; col[k * 3 + 2] = 255; 
      }
    }
    idx = targetCount;

  } else {
    // 针对非对齐字节的 DataView 慢速解析
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    
    for (let i = 0; i < total; i++) {
      const b = i * step;
      if (b + Math.max(xf.offset, yf.offset, zf.offset) + 4 > dv.byteLength) break;
      const x = dv.getFloat32(b + xf.offset, le), y = dv.getFloat32(b + yf.offset, le), z = dv.getFloat32(b + zf.offset, le);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

      const distSq = x * x + y * y + z * z;

      // 📱 远景梯度快速初筛
      if (!isGlobalFrame) {
        if (distSq > 3600) {
          continue;
        } else if (distSq > 1600) {
          if (i % 8 !== 0) continue;
        } else if (distSq > 400) {
          if (i % 3 !== 0) continue;
        }
      }

      if (validCount < MAX_TEMP_POINTS) {
        TEMP_INDICES[validCount] = i;
        TEMP_DISTS[validCount] = distSq;
        validCount++;
      }
    }

    const targetCount = Math.min(validCount, actualTarget);

    if (validCount > actualTarget) {
      quickselect(TEMP_DISTS, TEMP_INDICES, 0, validCount - 1, targetCount - 1);
    }

    for (let k = 0; k < targetCount; k++) {
      const i = TEMP_INDICES[k];
      const b = i * step;
      const x = dv.getFloat32(b + xf.offset, le), y = dv.getFloat32(b + yf.offset, le), z = dv.getFloat32(b + zf.offset, le);

      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      if (cf && vals) {
        const v = readFieldValue(dv, b + cf.offset, cf.datatype, le);
        if (Number.isFinite(v)) {
          vals[k] = v;
          if (v < min) min = v;
          if (v > max) max = v;
        } else {
          vals[k] = 0;
        }
      } else { 
        col[k * 3] = 255; col[k * 3 + 1] = 255; col[k * 3 + 2] = 255; 
      }
    }
    idx = targetCount;
  }

  if (idx === 0) return null;
  
  if (cf && ['turbo', 'warm'].includes(colorScheme || '') && isFinite(min) && isFinite(max) && vals) {
    const lut = colorScheme === 'warm' ? WARM_LUT : TURBO_LUT;
    const r = Math.max(1e-6, max - min);
    const scale = 255 / r;
    for (let i = 0; i < idx; i++) {
        const cIdx = Math.max(0, Math.min(255, Math.floor((vals[i] - min) * scale))) * 3;
        col[i * 3] = lut[cIdx];
        col[i * 3 + 1] = lut[cIdx + 1];
        col[i * 3 + 2] = lut[cIdx + 2];
    }
  }
  
  return { 
    length: idx, 
    positions: pos.slice(0, idx * 3), 
    colors: col.slice(0, idx * 3), 
    frameId 
  };
}