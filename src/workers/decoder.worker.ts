/// <reference lib="webworker" />
// Web Worker — 将计算密集型的点云 & 栅格解码移出主线程
// 利用 Transferable Objects 实现主线程 ↔ Worker 零拷贝数据传输
import { decodePointCloud } from '../components/render/pointCloudDecoder';
import { decodeOccupancyGridRaw } from './occupancyGridDecoder.worker';
import type { PointCloudBinary } from '../components/render/types';

interface WorkerRequest {
  id: number;
  type: 'PC_BATCH_DECODE' | 'GRID_DECODE';
  topic: string;
  data: any;      // PC: array of raw msgs; Grid: single raw msg
  options: any;
}

// Worker 端合并缓冲池（与主线程的 COMBINED_POSITIONS/COLORS 同大小）
const MAX_COMBINED = 500000;
const MERGED_POSITIONS = new Float32Array(MAX_COMBINED * 3);
const MERGED_COLORS = new Uint8Array(MAX_COMBINED * 3);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;

  if (req.type === 'PC_BATCH_DECODE') {
    const { id, topic, data, options } = req;
    const messages: any[] = Array.isArray(data) ? data : [data];

    // 解码每条消息并合并
    let offset = 0;
    let frameId = 'map';
    for (const rawMsg of messages) {
      const decoded = decodePointCloud(
        rawMsg,
        options.colorField,
        options.colorScheme,
        options.targetMaxPoints,
      );
      if (!decoded || decoded.length === 0) continue;
      if (offset + decoded.length > MAX_COMBINED) break;

      // 记录首个成功解码的 frameId
      if (offset === 0) frameId = decoded.frameId;

      MERGED_POSITIONS.set(decoded.positions, offset * 3);
      MERGED_COLORS.set(decoded.colors, offset * 3);
      offset += decoded.length;
    }

    if (offset > 0) {
      // slice 拷贝出合并结果并转移所有权
      const mergedPositions = MERGED_POSITIONS.slice(0, offset * 3);
      const mergedColors = MERGED_COLORS.slice(0, offset * 3);

      const payload: PointCloudBinary = {
        length: offset,
        positions: mergedPositions,
        colors: mergedColors,
        frameId,
        pointSize: options.pointSize,
        alpha: options.alpha,
      };

      self.postMessage(
        { id, type: 'PC_RESULT', topic, payload },
        [mergedPositions.buffer, mergedColors.buffer],
      );
    } else {
      self.postMessage({ id, type: 'PC_RESULT', topic, payload: null });
    }
  } else if (req.type === 'GRID_DECODE') {
    const { id, topic, data, options } = req;
    const existing = options.existingWidth != null
      ? { width: options.existingWidth, height: options.existingHeight! }
      : undefined;
    const result = decodeOccupancyGridRaw(data, existing);

    if (result) {
      self.postMessage(
        { id, type: 'GRID_RESULT', topic, payload: result },
        [result.rgba.buffer],
      );
    } else {
      self.postMessage({ id, type: 'GRID_RESULT', topic, payload: null });
    }
  }
};
