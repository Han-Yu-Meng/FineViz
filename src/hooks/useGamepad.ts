import { useEffect, useRef, useState, useCallback } from 'react';

interface GamepadSettings {
  maxLinearSpeed: number;  // 最大线速度 m/s
  maxAngularSpeed: number; // 最大角速度 rad/s
  publishRate: number;     // 发送频率 (ms)
  deadzone: number;        // 死区
  enabled?: boolean;       // 是否启用控制
}

export function useGamepad(
  publish: (topic: string, type: string, data: any) => void,
  settings: GamepadSettings = { 
    maxLinearSpeed: 0.5, 
    maxAngularSpeed: 1.0, 
    publishRate: 33,       // 提高到 30Hz，获得更跟手的体验
    deadzone: 0.1,
    enabled: true
  }
) {
  const [gamepadInfo, setGamepadInfo] = useState<{
    connected: boolean, 
    id: string,
    axes: number[],
    v: { x: number, y: number, w: number }
  }>({
    connected: false,
    id: '',
    axes: [],
    v: { x: 0, y: 0, w: 0 }
  });

  // 使用 Ref 存储手动控制值，避免高频操作导致整个 App 重渲染
  const manualVRef = useRef({ x: 0, y: 0, w: 0 });
  const [manualVState, setManualVState] = useState({ x: 0, y: 0, w: 0 }); // 仅用于 UI 显示，低频更新

  const requestRef = useRef<number>(0);
  const lastPubTimeRef = useRef<number>(0);
  const lastLogTimeRef = useRef<number>(0);
  const lastUIUpdateTimeRef = useRef<number>(0);
  const isStoppedRef = useRef<boolean>(true); 

  // 外部调用的更新方法
  const setManualV = useCallback((val: { x: number, y: number, w: number } | ((prev: any) => { x: number, y: number, w: number })) => {
    const nextVal = typeof val === 'function' ? val(manualVRef.current) : val;
    manualVRef.current = nextVal;
    
    // 低频更新 UI 状态 (约 10Hz)
    const now = Date.now();
    if (now - lastUIUpdateTimeRef.current > 100) {
      setManualVState(nextVal);
    }
  }, []);

  // 核心逻辑：获取并处理手柄数据
  const updateLoop = () => {
    const gamepads = navigator.getGamepads();
    
    let activeGp: Gamepad | null = null;
    for (const gp of gamepads) {
      if (gp && gp.connected) {
        activeGp = gp;
        break;
      }
    }

    const now = Date.now();
    let vx = 0;
    let vy = 0;
    let w = 0;

    if (activeGp) {
      const rawAngular = -activeGp.axes[0];
      const rawVx = -activeGp.axes[3];
      const rawVy = -activeGp.axes[2];

      vx = Math.abs(rawVx) > settings.deadzone ? rawVx * settings.maxLinearSpeed : 0;
      vy = Math.abs(rawVy) > settings.deadzone ? rawVy * settings.maxLinearSpeed : 0;
      w = Math.abs(rawAngular) > settings.deadzone ? rawAngular * settings.maxAngularSpeed : 0;

      const shouldUpdateUI = !gamepadInfo.connected || 
                            Math.abs(vx - gamepadInfo.v.x) > 0.05 || 
                            Math.abs(vy - gamepadInfo.v.y) > 0.05 ||
                            Math.abs(w - gamepadInfo.v.w) > 0.05 ||
                            now - lastUIUpdateTimeRef.current > 200;

      if (shouldUpdateUI) {
        lastUIUpdateTimeRef.current = now;
        setGamepadInfo({ 
          connected: true, 
          id: activeGp.id,
          axes: [...activeGp.axes],
          v: { x: vx, y: vy, w: w }
        });
      }
    } else {
      // 使用 Ref 中的值，无重渲染开销
      vx = manualVRef.current.x * settings.maxLinearSpeed;
      vy = manualVRef.current.y * settings.maxLinearSpeed;
      w = manualVRef.current.w * settings.maxAngularSpeed;

      if (gamepadInfo.connected) {
        setGamepadInfo({ 
          connected: false, 
          id: '', 
          axes: [],
          v: { x: 0, y: 0, w: 0 }
        });
      }
    }

    // 3. 发布逻辑控制
    if (settings.enabled && now - lastPubTimeRef.current > settings.publishRate) {
      if (vx !== 0 || vy !== 0 || w !== 0) {
        publish('/cmd_vel', 'geometry_msgs/msg/Twist', {
          linear: { x: vx, y: vy, z: 0 },
          angular: { x: 0, y: 0, z: w }
        });
        isStoppedRef.current = false;
      } else if (!isStoppedRef.current) {
        publish('/cmd_vel', 'geometry_msgs/msg/Twist', {
          linear: { x: 0, y: 0, z: 0 },
          angular: { x: 0, y: 0, z: 0 }
        });
        isStoppedRef.current = true;
      }
      lastPubTimeRef.current = now;
    }

    requestRef.current = requestAnimationFrame(updateLoop);
  };

  useEffect(() => {
    const onConnect = (e: GamepadEvent) => console.log("%c[Gamepad] Connected", "color: #22c55e");
    const onDisconnect = (e: GamepadEvent) => console.log("%c[Gamepad] Disconnected", "color: #ef4444");

    window.addEventListener("gamepadconnected", onConnect);
    window.addEventListener("gamepaddisconnected", onDisconnect);
    
    requestRef.current = requestAnimationFrame(updateLoop);

    return () => {
      window.removeEventListener("gamepadconnected", onConnect);
      window.removeEventListener("gamepaddisconnected", onDisconnect);
      cancelAnimationFrame(requestRef.current);
    };
  }, [publish, settings.enabled]); // 移除了对 manualV 的依赖，循环现在是完全独立的

  return { 
    gamepadConnected: gamepadInfo.connected, 
    gamepadId: gamepadInfo.id,
    axes: gamepadInfo.axes,
    v: gamepadInfo.connected ? gamepadInfo.v : {
      x: manualVRef.current.x * settings.maxLinearSpeed,
      y: manualVRef.current.y * settings.maxLinearSpeed,
      w: manualVRef.current.w * settings.maxAngularSpeed
    },
    manualV: manualVState,
    setManualV
  };
}