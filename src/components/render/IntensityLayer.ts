import { PointCloudLayer } from '@deck.gl/layers';

/**
 * IntensityLayer - 基于 GPU 的强度/标量着色图层
 * 在顶点着色器中将单个标量字段映射为全彩色光谱 (Turbo 算法)
 */

// 定义着色器注入：在顶点着色器中计算颜色
const vs_inject = {
  'vs:#decl': `
    in float instanceColorsScalar; // 强度或高度标量
    uniform float minIntensity;
    uniform float maxIntensity;
  `,
  'vs:DECKGL_FILTER_COLOR': `
    // 归一化标量到 0.0 - 1.0
    float normalized = (instanceColorsScalar - minIntensity) / (maxIntensity - minIntensity);
    normalized = clamp(normalized, 0.0, 1.0);

    // GPU 版本的 Turbo 算法（Foxglove 同款颜色映射）
    vec3 turbo;
    float x = normalized;
    turbo.r = 34.61 + x * (1172.33 + x * (-10793.56 + x * (33300.12 + x * (-38394.49 + x * 14825.05))));
    turbo.g = 23.31 + x * (557.33 + x * (1225.33 + x * (-3574.96 + x * (1073.77 + x * 707.56))));
    turbo.b = 27.2 + x * (3211.1 + x * (-15327.97 + x * (27814.0 + x * (-22569.18 + x * 6838.66))));
    
    // 赋值给 Deck.gl 的标准颜色变量 (RGBA)
    turbo /= 255.0;
    turbo = clamp(turbo, 0.0, 1.0);
    turbo.rgb *= 1.5; // 稍微增加一点亮度
    
    // 覆盖默认渲染颜色
    color = vec4(turbo, 1.0);
  `
};

export class IntensityLayer extends PointCloudLayer<any> {
  static layerName = 'IntensityLayer';

  getShaders() {
    const shaders = super.getShaders();
    // 注入着色器代码
    shaders.inject = vs_inject;
    return shaders;
  }

  // 初始化 Attribute 映射
  initializeState() {
    super.initializeState();
    this.getAttributeManager()?.addInstanced({
      instanceColorsScalar: {
        size: 1,
        accessor: 'getColorsScalar',
        defaultValue: 0
      }
    });
  }

  draw(opts: any) {
    // 传给 GPU 的统一变量（归一化范围）
    const { minIntensity = 0, maxIntensity = 100 } = this.props as any;
    opts.uniforms.minIntensity = minIntensity;
    opts.uniforms.maxIntensity = maxIntensity;
    super.draw(opts);
  }
}
