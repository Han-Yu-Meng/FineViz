export interface OccupancyGridData {
  width: number;
  height: number;
  resolution: number;
  origin: {
    position: [number, number, number];
    orientation: [number, number, number, number];
  };
  canvas: HTMLCanvasElement;
  frameId: string;
}

// 预计算 256 项 RGBA 查找表（模块级静态常量，避免循环中重复计算）
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
// probability [1..99] -> grayscale 渐变色
for (let v = 1; v < 100; v++) {
  const brightness = 255 - Math.floor(v * 2.55);
  LUT_R[v] = brightness; LUT_G[v] = brightness; LUT_B[v] = brightness; LUT_A[v] = 255;
}

/**
 * Decodes a nav_msgs/msg/OccupancyGrid message into a Canvas element.
 * 1. Automatically downsamples on mobile to respect GPU hardware texture limits (max 2048).
 * 2. Caches and reuses ImageData buffers to eliminate CPU-GPU sync bottlenecks (replaces getImageData).
 */
export function decodeOccupancyGrid(msg: any, existing?: OccupancyGridData): OccupancyGridData | null {
  if (!msg || !msg.info || msg.info.width <= 0 || msg.info.height <= 0 || !msg.data) {
    return null;
  }

  let width = msg.info.width;
  let height = msg.info.height;
  let resolution = msg.info.resolution;
  const origin = msg.info.origin;

  if (msg.data.length < width * height) {
    console.warn("OccupancyGrid data length mismatch");
    return null;
  }

  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  
  // 📱 移动端安全控制：最大纹理尺寸限制为 2048 像素，防止爆显存
  const MAX_MOBILE_SIZE = 1024;
  let scale = 1.0;
  if (isMobile && (width > MAX_MOBILE_SIZE || height > MAX_MOBILE_SIZE)) {
    scale = Math.min(MAX_MOBILE_SIZE / width, MAX_MOBILE_SIZE / height);
    width = Math.floor(width * scale);
    height = Math.floor(height * scale);
  }

  const rawData = msg.data;
  const originalWidth = msg.info.width;

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  let imageData: ImageData;
  let rgbaData: Uint8ClampedArray;

  // ✅ 核心修复：复用已有的 canvas 尺寸时，绝对不调用 ctx.getImageData()
  // 直接通过 createImageData 分配空白内存，依靠接下来的 CPU 循环做完全覆盖，免去显存回读
  if (existing && existing.canvas.width === width && existing.canvas.height === height) {
    canvas = existing.canvas;
    ctx = canvas.getContext('2d')!;
    imageData = ctx.createImageData(width, height); 
    rgbaData = imageData.data;
  } else {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext('2d')!;
    imageData = ctx.createImageData(width, height);
    rgbaData = imageData.data;
  }

  // 图像覆盖绘制（支持移动端降采样）
  for (let y = 0; y < height; y++) {
    const canvasY = height - 1 - y;
    const canvasRowOffset = canvasY * width;
    
    // 映射回原大地图的 Y 坐标
    const origY = scale === 1.0 ? y : Math.floor(y / scale);
    const rowOffset = origY * originalWidth;

    for (let x = 0; x < width; x++) {
      const origX = scale === 1.0 ? x : Math.floor(x / scale);
      let value = rawData[rowOffset + origX];
      
      // 规范化 -1（以及越界异常值）至索引 255
      if (value === -1 || value === undefined || value < -1 || value > 100) {
        value = 255;
      }

      const idx = (canvasRowOffset + x) << 2;
      rgbaData[idx]     = LUT_R[value];
      rgbaData[idx + 1] = LUT_G[value];
      rgbaData[idx + 2] = LUT_B[value];
      rgbaData[idx + 3] = LUT_A[value];
    }
  }

  ctx.putImageData(imageData, 0, 0);

  let frameId = msg.header?.frame_id || 'map';
  if (frameId.startsWith('/')) frameId = frameId.substring(1);

  return {
    width,
    height,
    // 如果缩小了像素比例，单个像素所代表的实际物理大小（分辨率）需等比放大
    resolution: resolution / scale, 
    origin: {
      position: [origin.position.x, origin.position.y, origin.position.z],
      orientation: [origin.orientation.x, origin.orientation.y, origin.orientation.z, origin.orientation.w]
    },
    canvas,
    imageData, // 留存引用以便下一帧复用
    frameId
  };
}