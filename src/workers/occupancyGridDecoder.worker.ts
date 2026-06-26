/// <reference lib="webworker" />
// Worker 端栅格解码 —— 不依赖 DOM (Canvas / ImageData)
// 产出 Uint8ClampedArray，通过 Transferable 零拷贝返回主线程
import type { OccupancyGridRaw } from '../components/render/types';

// 预计算 256 项 RGBA 查找表（与 occupancyGridDecoder.ts 保持一致）
const LUT_R = new Uint8Array(256);
const LUT_G = new Uint8Array(256);
const LUT_B = new Uint8Array(256);
const LUT_A = new Uint8Array(256);

// unknown (-1 存储为 255)
LUT_R[255] = 180; LUT_G[255] = 180; LUT_B[255] = 220; LUT_A[255] = 100;
// free (0)
LUT_R[0] = 245; LUT_G[0] = 255; LUT_B[0] = 245; LUT_A[0] = 255;
// occupied (100)
LUT_R[100] = 50; LUT_G[100] = 0; LUT_B[100] = 0; LUT_A[100] = 255;
// probability [1..99] → grayscale
for (let v = 1; v < 100; v++) {
  const brightness = 255 - Math.floor(v * 2.55);
  LUT_R[v] = brightness; LUT_G[v] = brightness; LUT_B[v] = brightness; LUT_A[v] = 255;
}

/**
 * 在 Worker 线程中解码 OccupancyGrid → 原始 RGBA 像素数组
 * 逻辑与原 occupancyGridDecoder.ts 一致，但不创建 Canvas/ImageData DOM 对象
 */
export function decodeOccupancyGridRaw(
  msg: any,
  existing?: { width: number; height: number }
): OccupancyGridRaw | null {
  if (!msg || !msg.info || msg.info.width <= 0 || msg.info.height <= 0 || !msg.data) {
    return null;
  }

  let width = msg.info.width;
  let height = msg.info.height;
  let resolution = msg.info.resolution;
  const origin = msg.info.origin;

  if (msg.data.length < width * height) {
    return null;
  }

  // 移动端降采样
  const MAX_MOBILE_SIZE = 4096;
  let scale = 1.0;
  if (width > MAX_MOBILE_SIZE || height > MAX_MOBILE_SIZE) {
    // 在 Worker 中没有 navigator，由主线程传入是否需要降采样
    // 这里保守地对超大尺寸做降采样
    scale = Math.min(MAX_MOBILE_SIZE / width, MAX_MOBILE_SIZE / height);
    width = Math.floor(width * scale);
    height = Math.floor(height * scale);
  }

  const rawData = msg.data;
  const originalWidth = msg.info.width;

  // Worker 中直接创建 Uint8ClampedArray（ImageData.data 的底层类型）
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    const canvasY = height - 1 - y; // Y 轴翻转（ROS map → Canvas）
    const canvasRowOffset = canvasY * width;
    const origY = scale === 1.0 ? y : Math.floor(y / scale);
    const rowOffset = origY * originalWidth;

    for (let x = 0; x < width; x++) {
      const origX = scale === 1.0 ? x : Math.floor(x / scale);
      let value = rawData[rowOffset + origX];

      if (value === -1 || value === undefined || value < -1 || value > 100) {
        value = 255;
      }

      const idx = (canvasRowOffset + x) << 2;
      rgba[idx] = LUT_R[value];
      rgba[idx + 1] = LUT_G[value];
      rgba[idx + 2] = LUT_B[value];
      rgba[idx + 3] = LUT_A[value];
    }
  }

  let frameId = msg.header?.frame_id || 'map';
  if (frameId.startsWith('/')) frameId = frameId.substring(1);

  return {
    width,
    height,
    resolution: resolution / scale,
    origin: {
      position: [origin.position.x, origin.position.y, origin.position.z],
      orientation: [origin.orientation.x, origin.orientation.y, origin.orientation.z, origin.orientation.w],
    },
    rgba,
    frameId,
  };
}
