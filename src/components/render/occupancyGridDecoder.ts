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

/**
 * Decodes a nav_msgs/msg/OccupancyGrid message into a Canvas element for Deck.gl BitmapLayer
 */
export function decodeOccupancyGrid(msg: any): OccupancyGridData | null {
  // 增加尺寸校验
  if (!msg || !msg.info || msg.info.width <= 0 || msg.info.height <= 0 || !msg.data) {
    return null; 
  }

  const { width, height, resolution, origin } = msg.info;
  
  // 预防性检查：确保数据长度匹配
  if (msg.data.length < width * height) {
    console.warn("OccupancyGrid data length mismatch");
    return null;
  }
  
  const rawData = msg.data;
  
  // Create a canvas to render the grid
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const imageData = ctx.createImageData(width, height);
  const rgbaData = imageData.data;
  
  let freeCount = 0;
  let occupiedCount = 0;
  let unknownCount = 0;

  // ROS OccupancyGrid mapping: 
  // Message data is stored in row-major order, starting from (0,0) at bottom-left corner.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const msgIdx = y * width + x;
      const value = rawData[msgIdx];
      
      const canvasY = height - 1 - y;
      const canvasIdx = (canvasY * width + x) * 4;
      
      if (value === 255 || value === -1) {
        unknownCount++;
        rgbaData[canvasIdx] = 180;     // R
        rgbaData[canvasIdx + 1] = 180; // G
        rgbaData[canvasIdx + 2] = 220; // B
        rgbaData[canvasIdx + 3] = 100; // Alpha
      } else {
        const v = Math.min(100, Math.max(0, value));
        if (v === 0) {
          freeCount++;
          rgbaData[canvasIdx] = 245;
          rgbaData[canvasIdx + 1] = 255;
          rgbaData[canvasIdx + 2] = 245;
        } else if (v === 100) {
          occupiedCount++;
          rgbaData[canvasIdx] = 50;
          rgbaData[canvasIdx + 1] = 0;
          rgbaData[canvasIdx + 2] = 0;
        } else {
          const brightness = 255 - Math.floor(v * 2.55);
          rgbaData[canvasIdx] = brightness;
          rgbaData[canvasIdx + 1] = brightness;
          rgbaData[canvasIdx + 2] = brightness;
        }
        rgbaData[canvasIdx + 3] = 255; 
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);

  let frameId = msg.header?.frame_id || 'map';
  if (frameId.startsWith('/')) frameId = frameId.substring(1);

  // 详细调试打印
  // console.log(`[OccupancyGrid Decode] 
  //   Topic Frame: ${frameId}
  //   Size: ${width}x${height}
  //   Resolution: ${resolution}
  //   Origin: [${origin.position.x}, ${origin.position.y}, ${origin.position.z}]
  //   Stats: Free=${freeCount}, Occupied=${occupiedCount}, Unknown=${unknownCount}
  //   Canvas: ${width}x${height}`);

  return {
    width,
    height,
    resolution,
    origin: {
      position: [origin.position.x, origin.position.y, origin.position.z],
      orientation: [origin.orientation.x, origin.orientation.y, origin.orientation.z, origin.orientation.w]
    },
    canvas,
    frameId
  };
}
