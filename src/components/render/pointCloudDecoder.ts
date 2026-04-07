import { PointCloudBinary } from './types';

// 预计算 LUT(Look Up Table) 颜色表，将极大程度降低 CPU 密集计算
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
  const frameId = msg.header?.frame_id || 'map';
  const fields = msg.fields as any[];
  const xf = fields.find(f => f.name === 'x'), yf = fields.find(f => f.name === 'y'), zf = fields.find(f => f.name === 'z');
  if (!xf || !yf || !zf) return null;
  const cf = colorField ? fields.find(f => f.name === colorField) : undefined;
  const bytes = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
  const le = !msg.is_bigendian, step = msg.point_step, total = Math.min(msg.width * msg.height, Math.floor(bytes.byteLength / step));
  const stride = Math.max(1, Math.ceil(total / targetMaxPoints));
  const count = Math.ceil(total / stride);
  const pos = new Float32Array(count * 3), col = new Uint8Array(count * 3), vals = cf ? new Float32Array(count) : null;
  let min = Infinity, max = -Infinity, idx = 0;
  
  // CPU 开销优化: 尝试利用 Float32Array 处理字节对齐（大多数 lidar 和点云硬件是 4-byte 浮点对齐的）
  const isAlignedFloat = le && bytes.byteOffset % 4 === 0 && step % 4 === 0 && xf.offset % 4 === 0 && yf.offset % 4 === 0 && zf.offset % 4 === 0 && (!cf || (cf.offset % 4 === 0 && cf.datatype === 7));

  if (isAlignedFloat) {
    const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const sW = step / 4, xW = xf.offset / 4, yW = yf.offset / 4, zW = zf.offset / 4, cW = cf ? cf.offset / 4 : 0;
    for (let i = 0; i < total && idx < count; i += stride) {
        const b = i * sW;
        const x = f32[b + xW], y = f32[b + yW], z = f32[b + zW];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        pos[idx * 3] = x; pos[idx * 3 + 1] = y; pos[idx * 3 + 2] = z;
        if (cf && vals) {
            const v = f32[b + cW];
            if (Number.isFinite(v)) {
                vals[idx] = v;
                if (v < min) min = v;
                if (v > max) max = v;
            }
        } else { col[idx * 3] = 255; col[idx * 3 + 1] = 255; col[idx * 3 + 2] = 255; }
        idx++;
    }
  } else {
    // 回退到针对未对齐字节的 DataView 慢速解析
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < total && idx < count; i += stride) {
      const b = i * step;
      if (b + Math.max(xf.offset, yf.offset, zf.offset) + 4 > dv.byteLength) break;
      const x = dv.getFloat32(b + xf.offset, le), y = dv.getFloat32(b + yf.offset, le), z = dv.getFloat32(b + zf.offset, le);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      pos[idx * 3] = x; pos[idx * 3 + 1] = y; pos[idx * 3 + 2] = z;
      if (cf && vals) {
        const v = readFieldValue(dv, b + cf.offset, cf.datatype, le);
        if (Number.isFinite(v)) { vals[idx] = v; min = Math.min(min, v); max = Math.max(max, v); }
      } else { col[idx * 3] = 255; col[idx * 3 + 1] = 255; col[idx * 3 + 2] = 255; }
      idx++;
    }
  }

  if (idx === 0) return null;
  const fPos = pos.subarray(0, idx * 3), fCol = col.subarray(0, idx * 3);
  if (cf && ['turbo', 'warm'].includes(colorScheme || '') && isFinite(min) && isFinite(max) && vals) {
    const lut = colorScheme === 'warm' ? WARM_LUT : TURBO_LUT;
    const r = Math.max(1e-6, max - min);
    const scale = 255 / r;
    for (let i = 0; i < idx; i++) {
        const cIdx = Math.max(0, Math.min(255, Math.floor((vals[i] - min) * scale))) * 3;
        fCol[i * 3] = lut[cIdx];
        fCol[i * 3 + 1] = lut[cIdx + 1];
        fCol[i * 3 + 2] = lut[cIdx + 2];
    }
  }
  return { length: idx, positions: fPos as Float32Array, colors: fCol as Uint8Array, frameId };
}
