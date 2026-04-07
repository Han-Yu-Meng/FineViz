import { PointCloudBinary } from './types';

export function getWarmColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  return [
    Math.min(255, Math.max(0, Math.round(255 * (x * 3)))),
    Math.min(255, Math.max(0, Math.round(255 * (x * 3 - 1)))),
    Math.min(255, Math.max(0, Math.round(255 * (x * 3 - 2)))),
  ];
}

export function getTurboColor(t: number): [number, number, number] {
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
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let min = Infinity, max = -Infinity, idx = 0;
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
  if (idx === 0) return null;
  const fPos = pos.subarray(0, idx * 3), fCol = col.subarray(0, idx * 3);
  if (cf && ['turbo', 'warm'].includes(colorScheme || '') && isFinite(min) && isFinite(max) && vals) {
    const r = Math.max(1e-6, max - min);
    for (let i = 0; i < idx; i++) {
        const [rv, gv, bv] = colorScheme === 'warm' 
            ? getWarmColor((vals[i] - min) / r)
            : getTurboColor((vals[i] - min) / r);
        fCol[i * 3] = rv; fCol[i * 3 + 1] = gv; fCol[i * 3 + 2] = bv;
    }
  }
  return { length: idx, positions: fPos as Float32Array, colors: fCol as Uint8Array, frameId };
}
