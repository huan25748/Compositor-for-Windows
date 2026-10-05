/**
 * GLSL ES 3.00 着色器。
 *
 * 这里的分量公式与 src/shared/blend.ts（已被单元测试覆盖）一一对应，
 * 改动其一时必须同步另一处。
 */
import { BLEND_MODES, type BlendMode } from '../../shared/types.ts'

/** 把官方名称映射为着色器里的整数编码，顺序即 BLEND_MODES 的下标。 */
export const BLEND_CODES: Record<BlendMode, number> = Object.fromEntries(
  BLEND_MODES.map((m, i) => [m, i]),
) as Record<BlendMode, number>

/** 调整图层种类的整数编码（顺序与 ADJUSTMENT_KINDS 一致）。 */
export const ADJUST_CODES = {
  'Hue/Saturation': 0,
  Levels: 1,
  Curves: 2,
  Exposure: 3,
  'Gradient Map': 4,
  Grain: 5,
  Invert: 6,
  'Black & White': 7,
  'Color Balance': 8,
  'Gaussian Blur': 9,
  'Motion Blur': 10,
  'Add Noise': 11,
} as const

/** 24 种混合模式的分量函数 + 非分量级函数。 */
const BLEND_LIB = /* glsl */ `
float bDarken(float b, float s) { return min(b, s); }
float bMultiply(float b, float s) { return b * s; }
float bColorBurn(float b, float s) { return s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s); }
float bLinearBurn(float b, float s) { return clamp(b + s - 1.0, 0.0, 1.0); }
float bLighten(float b, float s) { return max(b, s); }
float bScreen(float b, float s) { return b + s - b * s; }
float bColorDodge(float b, float s) { return s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s)); }
float bLinearDodge(float b, float s) { return clamp(b + s, 0.0, 1.0); }
float bHardLight(float b, float s) { return s <= 0.5 ? bMultiply(b, 2.0 * s) : bScreen(b, 2.0 * s - 1.0); }
float bOverlay(float b, float s) { return bHardLight(s, b); }
float bSoftLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
float bVividLight(float b, float s) { return s <= 0.5 ? bColorBurn(b, 2.0 * s) : bColorDodge(b, 2.0 * s - 1.0); }
float bLinearLight(float b, float s) { return s <= 0.5 ? bLinearBurn(b, 2.0 * s) : bLinearDodge(b, 2.0 * s - 1.0); }
float bPinLight(float b, float s) { return s <= 0.5 ? bDarken(b, 2.0 * s) : bLighten(b, 2.0 * s - 1.0); }
float bHardMix(float b, float s) { return bVividLight(b, s) < 0.5 ? 0.0 : 1.0; }
float bDifference(float b, float s) { return abs(b - s); }
float bExclusion(float b, float s) { return b + s - 2.0 * b * s; }
float bSubtract(float b, float s) { return clamp(b - s, 0.0, 1.0); }
float bDivide(float b, float s) { return s <= 0.0 ? 1.0 : clamp(b / s, 0.0, 1.0); }

float lum709(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }

vec3 clipColor(vec3 c) {
  float l = lum709(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum709(c))); }
float satOf(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  vec3 r = vec3(0.0);
  float mn = min(min(c.r, c.g), c.b);
  float mx = max(max(c.r, c.g), c.b);
  float md = c.r + c.g + c.b - mn - mx;
  if (mx > mn) {
    float nm = (md - mn) * s / (mx - mn);
    r.r = c.r == mn ? 0.0 : (c.r == mx ? s : nm);
    r.g = c.g == mn ? 0.0 : (c.g == mx ? s : nm);
    r.b = c.b == mn ? 0.0 : (c.b == mx ? s : nm);
  }
  return r;
}

// mode 编码顺序 = BLEND_MODES 下标
vec3 blendRGB(int mode, vec3 b, vec3 s) {
  if (mode == 0)  return s;                                                  // Normal
  if (mode == 1)  return vec3(bDarken(b.r,s.r), bDarken(b.g,s.g), bDarken(b.b,s.b));
  if (mode == 2)  return vec3(bMultiply(b.r,s.r), bMultiply(b.g,s.g), bMultiply(b.b,s.b));
  if (mode == 3)  return vec3(bColorBurn(b.r,s.r), bColorBurn(b.g,s.g), bColorBurn(b.b,s.b));
  if (mode == 4)  return vec3(bLinearBurn(b.r,s.r), bLinearBurn(b.g,s.g), bLinearBurn(b.b,s.b));
  if (mode == 5)  return vec3(bLighten(b.r,s.r), bLighten(b.g,s.g), bLighten(b.b,s.b));
  if (mode == 6)  return vec3(bScreen(b.r,s.r), bScreen(b.g,s.g), bScreen(b.b,s.b));
  if (mode == 7)  return vec3(bColorDodge(b.r,s.r), bColorDodge(b.g,s.g), bColorDodge(b.b,s.b));
  if (mode == 8)  return vec3(bLinearDodge(b.r,s.r), bLinearDodge(b.g,s.g), bLinearDodge(b.b,s.b));
  if (mode == 9)  return vec3(bOverlay(b.r,s.r), bOverlay(b.g,s.g), bOverlay(b.b,s.b));
  if (mode == 10) return vec3(bSoftLight(b.r,s.r), bSoftLight(b.g,s.g), bSoftLight(b.b,s.b));
  if (mode == 11) return vec3(bHardLight(b.r,s.r), bHardLight(b.g,s.g), bHardLight(b.b,s.b));
  if (mode == 12) return vec3(bVividLight(b.r,s.r), bVividLight(b.g,s.g), bVividLight(b.b,s.b));
  if (mode == 13) return vec3(bLinearLight(b.r,s.r), bLinearLight(b.g,s.g), bLinearLight(b.b,s.b));
  if (mode == 14) return vec3(bPinLight(b.r,s.r), bPinLight(b.g,s.g), bPinLight(b.b,s.b));
  if (mode == 15) return vec3(bHardMix(b.r,s.r), bHardMix(b.g,s.g), bHardMix(b.b,s.b));
  if (mode == 16) return vec3(bDifference(b.r,s.r), bDifference(b.g,s.g), bDifference(b.b,s.b));
  if (mode == 17) return vec3(bExclusion(b.r,s.r), bExclusion(b.g,s.g), bExclusion(b.b,s.b));
  if (mode == 18) return vec3(bSubtract(b.r,s.r), bSubtract(b.g,s.g), bSubtract(b.b,s.b));
  if (mode == 19) return vec3(bDivide(b.r,s.r), bDivide(b.g,s.g), bDivide(b.b,s.b));
  if (mode == 20) return setLum(setSat(s, satOf(b)), lum709(b));   // Hue
  if (mode == 21) return setLum(setSat(b, satOf(s)), lum709(b));   // Saturation
  if (mode == 22) return setLum(s, lum709(b));                     // Color
  return setLum(b, lum709(s));                                     // Luminosity
}

// 带 alpha 的 W3C 合成
vec4 blendOver(int mode, vec4 base, vec4 src) {
  float cs = src.a;
  float cb = base.a;
  vec3 blended = blendRGB(mode, base.rgb, src.rgb);
  float outA = cs + cb * (1.0 - cs);
  if (outA <= 0.0) return vec4(0.0);
  vec3 co = ((1.0 - cb) * cs * src.rgb + cb * cs * blended + (1.0 - cs) * cb * base.rgb) / outA;
  return vec4(co, outA);
}
`

/**
 * 全屏四边形顶点着色器（用于文档尺寸的各趟合成）。
 * 坐标约定：vUV 的 v=0 对应文档顶部，与文档坐标 y 向下一致。
 */
export const QUAD_VS = /* glsl */ `#version 300 es
in vec2 aPos;              // 单位四边形 0..1
out vec2 vUV;
void main() {
  vUV = aPos;
  // 关键：渲染到 FBO 时，vUV.y=0 必须落在 framebuffer 的 texel 行 0（也就是纹理 v=0），
  // 才能让「文档顶部」与「纹理 v=0」对应上。这里若把 y 翻转，
  // 合成结果在纹理里就是上下倒的，最终整幅画面都会被翻过来。
  gl_Position = vec4(aPos.x * 2.0 - 1.0, aPos.y * 2.0 - 1.0, 0.0, 1.0);
}
`

/**
 * 把单位四边形放到屏幕上的任意矩形（用于把合成结果显示到画布）。
 * uRect 以屏幕像素给出，y 向下、原点在左上角。
 */
export const RECT_VS = /* glsl */ `#version 300 es
in vec2 aPos;
uniform vec4 uRect;        // x, y, w, h
uniform vec2 uCanvasSize;
out vec2 vUV;
void main() {
  vUV = aPos;
  vec2 p = uRect.xy + aPos * uRect.zw;
  gl_Position = vec4(p.x / uCanvasSize.x * 2.0 - 1.0, 1.0 - p.y / uCanvasSize.y * 2.0, 0.0, 1.0);
}
`

/**
 * 图层合成：把一张图层纹理（可能带蒙版）按变换、不透明度、混合模式
 * 叠加到已经合成好的背景上。
 *
 * 坐标约定：文档坐标 y 向下，(0,0) 为左上角；纹理 v=0 对应图像顶部。
 */
export const LAYER_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uBase;     // 已合成的背景（文档尺寸）
uniform sampler2D uLayer;    // 本图层像素
uniform sampler2D uMask;     // 蒙版（灰度，可缺省）
uniform sampler2D uClip;     // 剪贴蒙版的源图层像素（可缺省）
uniform mat3 uDocToLayer;    // 文档像素 -> 图层局部 0..1
uniform mat3 uDocToMask;     // 文档像素 -> 蒙版局部 0..1
uniform mat3 uDocToClip;     // 文档像素 -> 剪贴源局部 0..1
uniform vec2 uDocSize;
uniform int  uHasMask;       // 1 = 蒙版存在且启用
uniform int  uHasClip;       // 1 = 有剪贴蒙版
uniform float uClipOpacity;
uniform float uOpacity;
uniform int  uMode;
${BLEND_LIB}

/** 文档坐标（像素）-> 采样用的 uv */
vec2 docUV(vec2 docPx) { return docPx / uDocSize; }

void main() {
  // vUV 覆盖整个文档，换算成文档像素
  vec2 docPx = vUV * uDocSize;

  vec4 base = texture(uBase, docUV(docPx));

  // 图层局部 uv
  vec2 luv = (uDocToLayer * vec3(docPx, 1.0)).xy;
  vec4 src = texture(uLayer, clamp(luv, 0.0, 1.0));
  // 落在图层矩形之外 -> 完全透明
  if (luv.x < 0.0 || luv.x > 1.0 || luv.y < 0.0 || luv.y > 1.0) src = vec4(0.0);

  float a = src.a;

  if (uHasClip == 1) {
    vec2 cuv = (uDocToClip * vec3(docPx, 1.0)).xy;
    float ca = 0.0;
    if (cuv.x >= 0.0 && cuv.x <= 1.0 && cuv.y >= 0.0 && cuv.y <= 1.0) {
      ca = texture(uClip, cuv).a;
    }
    a *= ca * uClipOpacity;
  }

  if (uHasMask == 1) {
    vec2 muv = (uDocToMask * vec3(docPx, 1.0)).xy;
    float m = 1.0;
    if (muv.x >= 0.0 && muv.x <= 1.0 && muv.y >= 0.0 && muv.y <= 1.0) {
      m = texture(uMask, muv).r;
    } else {
      m = 0.0;
    }
    a *= m;
  }

  src.a = clamp(a * uOpacity, 0.0, 1.0);
  fragColor = blendOver(uMode, base, src);
}
`

/** 单纯把一张纹理画到目标（用于组的收尾、显示与导出）。 */
export const BLIT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uTex;
uniform float uOpacity;
void main() {
  vec4 c = texture(uTex, vUV);
  fragColor = vec4(c.rgb, c.a * uOpacity);
}
`

/** 把文档显示到画布：透明处显示棋盘格。 */
export const DISPLAY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uDocSize;      // 文档像素尺寸
uniform float uCheckerSize;
uniform vec3 uCheckerA;
uniform vec3 uCheckerB;
void main() {
  vec4 c = texture(uTex, vUV);
  // 棋盘格按文档像素划分，缩放时格子跟着文档走
  vec2 cell = floor(vUV * uDocSize / uCheckerSize);
  vec3 checker = mix(uCheckerA, uCheckerB, mod(cell.x + cell.y, 2.0));
  fragColor = vec4(mix(checker, c.rgb, c.a), 1.0);
}
`

/**
 * 选区轮廓（蚂蚁线）。
 *
 * 对文档尺寸的选区蒙版做四邻域边缘检测，在边缘上画黑白相间的虚线。
 * 由 RECT_VS 把单位四边形摆到文档在屏幕上的位置，所以缩放与平移都跟得住。
 */
export const SELECTION_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uMask;
uniform vec2 uDocSize;
uniform vec4 uRect;          // 文档在屏幕上的矩形
uniform float uDashPeriod;   // 虚线段长（屏幕像素）
uniform vec3 uColorA;
uniform vec3 uColorB;
void main() {
  vec2 texel = 1.0 / uDocSize;
  float c = texture(uMask, vUV).r;
  float l = texture(uMask, vUV - vec2(texel.x, 0.0)).r;
  float r = texture(uMask, vUV + vec2(texel.x, 0.0)).r;
  float u = texture(uMask, vUV - vec2(0.0, texel.y)).r;
  float d = texture(uMask, vUV + vec2(0.0, texel.y)).r;
  float edge = max(max(abs(c - l), abs(c - r)), max(abs(c - u), abs(c - d)));
  if (edge < 0.35) discard;

  // 沿对角线方向排布虚线段：在水平与垂直边界上都会呈现相间效果
  vec2 screenPx = uRect.xy + vUV * uRect.zw;
  float phase = mod(floor((screenPx.x + screenPx.y) / uDashPeriod), 2.0);
  fragColor = vec4(phase < 1.0 ? uColorA : uColorB, 1.0);
}
`

/**
 * 普通矩形描边（裁剪框、变换框等临时提示）。
 * 同样画在文档于屏幕上的矩形内，边框带宽以屏幕像素给定。
 */
export const RECT_STROKE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform vec4 uRect;          // 文档在屏幕上的矩形
uniform float uOutside;      // 1 = 把框画在矩形外侧（裁剪预览用）
void main() {
  vec2 screenPx = uRect.xy + vUV * uRect.zw;
  // 到矩形四边的距离
  float dl = screenPx.x - uRect.x;
  float dt = screenPx.y - uRect.y;
  float dr = uRect.x + uRect.z - screenPx.x;
  float db = uRect.y + uRect.w - screenPx.y;
  float dist = min(min(dl, dr), min(dt, db));
  // 外侧描边：反转一部分
  float band = 1.5;
  float m = (dist >= 0.0 && dist <= band) ? 1.0 : 0.0;
  if (uOutside > 0.5) {
    float outer = (dist >= -band && dist < 0.0) ? 1.0 : 0.0;
    m = max(m, outer);
  }
  if (m < 0.5) discard;
  fragColor = vec4(1.0, 1.0, 1.0, 0.95);
}
`

// ——————————————————————————————————————————————————————————————
// 图层效果（描边 / 投影 / 内阴影 / 内外发光 / 颜色叠加）
//
// 全部在「图层局部 + 外扩 padding」的空间里完成：先把图层 alpha 做可分离高斯
// 模糊，再用阈值化近似膨胀/腐蚀，最后按官方给出的叠加顺序合成。
// ——————————————————————————————————————————————————————————————

/** 可分离高斯模糊（只取 alpha 通道，用于生成柔化覆盖）。 */
export const DILATE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uStep;      // 方向步长（1/宽 或 1/高）
uniform float uRadius;   // 膨胀半径（像素）
void main() {
  // 形态学膨胀：取该方向 ±uRadius 内的**最大** alpha。
  // 与「模糊 + 阈值化」不同，它不会把边缘摊成渐变，结果就是实色的外扩 ——
  // 这正是描边应有的样子（模糊方案看起来是发虚的）。
  const int N = 32;
  float m = 0.0;
  for (int i = -N; i <= N; i++) {
    float t = float(i) / float(N);
    m = max(m, texture(uSrc, vUV + uStep * uRadius * t).r);
  }
  fragColor = vec4(m);
}
`

export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uStep;      // 方向步长（1/宽 或 1/高）
uniform float uRadius;   // 模糊半径（像素）
uniform float uSigma;
void main() {
  const int N = 24;
  float acc = 0.0;
  float total = 0.0;
  for (int i = -N; i <= N; i++) {
    float t = float(i) / float(N);
    float w = exp(-(t * t) / max(uSigma, 0.0001));
    acc += texture(uSrc, vUV + uStep * uRadius * t).r * w;
    total += w;
  }
  fragColor = vec4(acc / total);
}
`

/** 提取 alpha 为单通道纹理（模糊的输入）。 */
export const ALPHA_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uSrc;
void main() {
  fragColor = vec4(texture(uSrc, vUV).a);
}
`

/**
 * 图层效果合成。
 *
 * 叠加顺序完全按官方文档（自下而上）：
 * 投影 → 外发光 → 外侧描边 → 图层像素 → 颜色叠加 → 内发光 → 内阴影 → 内侧描边。
 */
export const EFFECTS_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uLayer;
uniform sampler2D uShadowBlur;
uniform sampler2D uGlowBlur;
uniform sampler2D uInnerShadowBlur;
uniform sampler2D uInnerGlowBlur;
uniform sampler2D uStrokeBlur;

uniform int uHasShadow;
uniform vec3 uShadowColor;
uniform float uShadowOpacity;
uniform vec2 uShadowOffset;

uniform int uHasGlow;
uniform vec3 uGlowColor;
uniform float uGlowOpacity;

uniform int uHasStroke;
uniform vec3 uStrokeColor;
uniform float uStrokeOpacity;
uniform int uStrokeInside;

uniform int uHasColorOverlay;
uniform vec3 uOverlayColor;
uniform float uOverlayOpacity;

uniform int uHasInnerShadow;
uniform vec3 uInnerShadowColor;
uniform float uInnerShadowOpacity;
uniform vec2 uInnerShadowOffset;

uniform int uHasInnerGlow;
uniform vec3 uInnerGlowColor;
uniform float uInnerGlowOpacity;

vec4 over(vec4 dst, vec4 src) {
  float a = src.a + dst.a * (1.0 - src.a);
  if (a <= 0.0) return vec4(0.0);
  return vec4((src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / a, a);
}

void main() {
  vec4 layer = texture(uLayer, vUV);
  float a = layer.a;
  vec4 acc = vec4(0.0);

  // 1) 投影：模糊后的 alpha 偏移到背后
  if (uHasShadow == 1) {
    float sa = texture(uShadowBlur, vUV - uShadowOffset).r * uShadowOpacity;
    acc = over(acc, vec4(uShadowColor, clamp(sa, 0.0, 1.0)));
  }

  // 2) 外发光：只保留落在图层之外的部分
  if (uHasGlow == 1) {
    float ga = texture(uGlowBlur, vUV).r;
    float m = clamp(ga * (1.0 - a), 0.0, 1.0) * uGlowOpacity;
    acc = over(acc, vec4(uGlowColor, m));
  }

  // 3) 外侧描边：膨胀后的覆盖减去原覆盖
  if (uHasStroke == 1 && uStrokeInside == 0) {
    float ea = texture(uStrokeBlur, vUV).r;
    float ring = clamp(ea - a, 0.0, 1.0) * uStrokeOpacity;
    acc = over(acc, vec4(uStrokeColor, ring));
  }

  // 4) 图层自身的像素
  acc = over(acc, layer);

  // 5) 颜色叠加（保留原有透明度）
  if (uHasColorOverlay == 1) {
    acc = vec4(mix(acc.rgb, uOverlayColor, uOverlayOpacity), acc.a);
  }

  // 6) 内发光：内部且靠近边缘的区域被提亮（screen）
  if (uHasInnerGlow == 1) {
    float ga = texture(uInnerGlowBlur, vUV).r;
    float inner = clamp(1.0 - ga, 0.0, 1.0) * a * uInnerGlowOpacity;
    vec3 blended = 1.0 - (1.0 - acc.rgb) * (1.0 - uInnerGlowColor);
    acc = vec4(mix(acc.rgb, blended, inner), acc.a);
  }

  // 7) 内阴影：反向覆盖偏移后取内部
  if (uHasInnerShadow == 1) {
    float sa = texture(uInnerShadowBlur, vUV - uInnerShadowOffset).r;
    float inner = clamp(1.0 - sa, 0.0, 1.0) * a * uInnerShadowOpacity;
    acc = vec4(mix(acc.rgb, uInnerShadowColor, inner), acc.a);
  }

  // 8) 内侧描边：原覆盖减去腐蚀后的覆盖
  if (uHasStroke == 1 && uStrokeInside == 1) {
    float ea = texture(uStrokeBlur, vUV).r;
    float eroded = smoothstep(0.35, 0.7, ea);
    float ring = clamp(a - eroded, 0.0, 1.0) * uStrokeOpacity;
    acc = vec4(mix(acc.rgb, uStrokeColor, ring), acc.a);
  }

  fragColor = acc;
}
`

/** 把一张纹理按 padding 放大后拷进更大的画布中心（供效果渲染使用）。 */
export const PAD_COPY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uInnerSize;   // 原图尺寸
uniform vec2 uOuterSize;   // 含 padding 的尺寸
void main() {
  vec2 px = vUV * uOuterSize;          // 外扩空间的像素坐标
  vec2 inner = (uOuterSize - uInnerSize) * 0.5;
  vec2 uv = (px - inner) / uInnerSize;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }
  fragColor = texture(uSrc, uv);
}
`

/** 最多同时显示的参考线条数（MVP 上限；官方数据可存 1000 条）。 */
export const MAX_VISIBLE_GUIDES = 16

/**
 * 变换框与四角手柄（移动工具下显示，拖动即可调整图层大小）。
 */
export const TRANSFORM_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform vec4 uRect;      // 图层在屏幕上的矩形
uniform float uHandle;   // 手柄边长（屏幕像素）
void main() {
  vec2 p = uRect.xy + vUV * uRect.zw;
  // 注意：half 是 GLSL ES 的保留字，不能用作变量名
  vec2 halfSize = uRect.zw * 0.5;
  vec2 c = uRect.xy + halfSize;
  vec2 d = abs(p - c) - halfSize;

  float h = max(uHandle * 0.5, 3.0);
  bool onHandle =
    (abs(p.x - uRect.x) <= h || abs(p.x - (uRect.x + uRect.z)) <= h) &&
    (abs(p.y - uRect.y) <= h || abs(p.y - (uRect.y + uRect.w)) <= h);
  if (onHandle) {
    fragColor = vec4(1.0, 1.0, 1.0, 1.0);
    return;
  }

  float border = max(d.x, d.y);
  if (abs(border) < 1.0) {
    fragColor = vec4(1.0, 1.0, 1.0, 0.8);
    return;
  }
  discard;
}
`

/**
 * 画布辅助：网格、像素网格与参考线。
 * 全部按屏幕像素判定线宽，因此缩放时粗细恒定。
 */
export const GRID_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform vec2 uDocSize;
uniform vec4 uRect;          // 文档在屏幕上的矩形（含 dpr）
uniform float uZoom;         // 文档 -> 屏幕的缩放（含 dpr）
uniform float uGridSpacing;
uniform float uShowGrid;
uniform float uShowPixelGrid;
uniform float uGuideCount;
uniform vec2 uGuides[16];    // x: 0=水平 1=垂直，y: 文档坐标
uniform int uActiveGuide;    // 正在拖拽的参考线下标（-1 表示无）
void main() {
  vec2 screenPx = uRect.xy + vUV * uRect.zw;
  vec2 docPx = vUV * uDocSize;
  vec4 col = vec4(0.0);

  if (uShowGrid > 0.5) {
    float step = uGridSpacing * uZoom;
    if (step >= 4.0) {
      vec2 g = abs(fract(docPx / uGridSpacing + 0.5) - 0.5) * step;
      if (min(g.x, g.y) < 1.0) col = vec4(0.52, 0.57, 0.65, 0.45);
    }
  }

  if (uShowPixelGrid > 0.5 && uZoom >= 8.0) {
    vec2 g = abs(fract(docPx) - 0.5) * uZoom;
    if (min(g.x, g.y) < 0.6) col = vec4(0.62, 0.65, 0.72, 0.30);
  }

  for (int i = 0; i < 16; i++) {
    if (float(i) >= uGuideCount) break;
    vec2 gd = uGuides[i];
    if (gd.x < 0.5) {
      float y = uRect.y + gd.y * uZoom;
      if (abs(screenPx.y - y) < 0.75) {
        col = (i == uActiveGuide) ? vec4(1.0, 0.6, 0.2, 1.0) : vec4(0.30, 0.85, 1.0, 0.9);
      }
    } else {
      float x = uRect.x + gd.y * uZoom;
      if (abs(screenPx.x - x) < 0.75) {
        col = (i == uActiveGuide) ? vec4(1.0, 0.6, 0.2, 1.0) : vec4(0.30, 0.85, 1.0, 0.9);
      }
    }
  }

  if (col.a < 0.01) discard;
  fragColor = col;
}
`

/**
 * 调整图层：读取已合成背景，按 kind 变换后与原值按不透明度/蒙版混合。
 * 需要邻域采样的（模糊/噪点）用 uTexel 做多抽样。
 */
export const ADJUST_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uBase;
uniform sampler2D uMask;
uniform mat3 uDocToMask;
uniform vec2 uDocSize;
uniform int  uHasMask;
uniform int  uKind;
uniform float uOpacity;
uniform int  uMode;

// Hue/Saturation
uniform vec3 uHSV;          // hue(度), saturation(-100..100), lightness(-100..100)
uniform float uColorize;
// Levels
uniform vec4 uLevelsRGB;    // black, gamma, white, outWhite
uniform vec4 uLevelsOutRGB;
// Curves（用 4 张 256 宽的 LUT 纹理，见 renderer）
uniform sampler2D uCurveLUT;
uniform int uCurvesActive;
// Exposure
uniform vec3 uExposure;     // exposure, offset, gamma
// Gradient Map
uniform vec3 uGradShadows;
uniform vec3 uGradHighlights;
uniform float uGradReversed;
// Grain / Noise
uniform vec4 uGrain;        // amount, size, roughness, mono
uniform float uSeed;
// Black & White
uniform vec3 uBW1;          // red, yellow, green（0..1 权重，内部已 /100）
uniform vec3 uBW2;          // cyan, blue, magenta
// Color Balance
uniform vec4 uCBShadow;     // cyanRed, magentaGreen, yellowBlue, unused
uniform vec4 uCBMid;
uniform vec4 uCBHighlight;
uniform float uCBPreserve;
// 模糊
uniform vec2 uTexel;
uniform float uBlurRadius;
uniform float uMotionAngle;
uniform float uMotionDistance;

const vec3 LW = vec3(0.3, 0.59, 0.11);
float lum(vec3 c) { return dot(c, LW); }

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

vec3 applyLevels(vec3 c) {
  vec3 x = (c - uLevelsRGB.x) / max(uLevelsRGB.z - uLevelsRGB.x, 1.0 / 255.0);
  x = clamp(x, 0.0, 1.0);
  if (abs(uLevelsRGB.y - 1.0) > 1.0e-4) x = pow(x, vec3(1.0 / uLevelsRGB.y));
  return mix(vec3(uLevelsOutRGB.x), vec3(uLevelsOutRGB.z), x);
}

vec3 applyHueSaturation(vec3 c) {
  vec3 hsv = rgb2hsv(c);
  if (uColorize > 0.5) {
    hsv.x = fract(uHSV.x / 360.0);
  } else {
    hsv.x = fract(hsv.x + uHSV.x / 360.0);
  }
  float s = uHSV.y / 100.0;
  if (s >= 0.0) hsv.y = hsv.y + (1.0 - hsv.y) * s;
  else hsv.y = hsv.y * (1.0 + s);
  float l = uHSV.z / 100.0;
  if (l >= 0.0) hsv.z = hsv.z + (1.0 - hsv.z) * l;
  else hsv.z = hsv.z * (1.0 + l);
  hsv.y = clamp(hsv.y, 0.0, 1.0);
  return hsv2rgb(clamp(hsv, 0.0, 1.0));
}

vec3 applyExposure(vec3 c) {
  vec3 x = c * pow(2.0, uExposure.x) + uExposure.y;
  x = clamp(x, 0.0, 4.0);
  if (abs(uExposure.z - 1.0) > 1.0e-4) x = pow(max(x, 0.0), vec3(1.0 / uExposure.z));
  return clamp(x, 0.0, 1.0);
}

vec3 applyGradientMap(vec3 c) {
  float t = clamp(lum(c), 0.0, 1.0);
  if (uGradReversed > 0.5) t = 1.0 - t;
  return mix(uGradShadows, uGradHighlights, t);
}

vec3 applyBlackWhite(vec3 c) {
  // 简化版：按通道加权求灰度，权重由用户对六色的调整决定
  float w = c.r * uBW1.x + c.g * uBW1.z + c.b * uBW2.y;
  float bias = c.r * uBW1.y + c.g * uBW2.x + c.b * uBW2.z;
  float g = clamp(w + bias * 0.25, 0.0, 1.0);
  return vec3(g);
}

vec3 applyColorBalance(vec3 c) {
  float l = lum(c);
  // 阴影 / 中间调 / 高光 的权重
  float sw = clamp(1.0 - l * 2.0, 0.0, 1.0);
  float hw = clamp(l * 2.0 - 1.0, 0.0, 1.0);
  float mw = clamp(1.0 - sw - hw, 0.0, 1.0);
  vec3 shift =
    vec3(uCBShadow.x, uCBShadow.y, uCBShadow.z) * sw +
    vec3(uCBMid.x, uCBMid.y, uCBMid.z) * mw +
    vec3(uCBHighlight.x, uCBHighlight.y, uCBHighlight.z) * hw;
  vec3 outC = clamp(c + shift / 100.0, 0.0, 1.0);
  if (uCBPreserve > 0.5) {
    float lo = lum(outC);
    outC = clamp(outC + (l - lo), 0.0, 1.0);
  }
  return outC;
}

vec3 sampleBlur(vec2 uv) {
  vec3 acc = vec3(0.0);
  float total = 0.0;
  // 简单的二维高斯（9 抽样），半径按像素给出
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 off = vec2(float(i), float(j)) * uTexel * uBlurRadius;
      float w = 1.0 / (1.0 + float(i * i + j * j));
      acc += texture(uBase, uv + off).rgb * w;
      total += w;
    }
  }
  return acc / total;
}

vec3 sampleMotion(vec2 uv) {
  float ang = radians(uMotionAngle);
  vec2 dir = vec2(cos(ang), sin(ang)) * uTexel * uMotionDistance;
  vec3 acc = vec3(0.0);
  float total = 0.0;
  for (int i = -4; i <= 4; i++) {
    float t = float(i) / 4.0;
    float w = 1.0 - abs(t) * 0.6;
    acc += texture(uBase, uv + dir * t).rgb * w;
    total += w;
  }
  return acc / total;
}

void main() {
  vec4 base = texture(uBase, vUV);
  vec3 c = base.rgb;

  if (uKind == 0) {
    c = applyHueSaturation(c);
  } else if (uKind == 1) {
    c = applyLevels(c);
  } else if (uKind == 2) {
    if (uCurvesActive == 1) {
      c = vec3(
        texture(uCurveLUT, vec2(c.r, 0.125)).r,
        texture(uCurveLUT, vec2(c.g, 0.375)).r,
        texture(uCurveLUT, vec2(c.b, 0.625)).r
      );
      // RGB 复合曲线在 alpha 通道
      float l = lum(c);
      float mapped = texture(uCurveLUT, vec2(l, 0.875)).r;
      c = clamp(c + (mapped - l), 0.0, 1.0);
    }
  } else if (uKind == 3) {
    c = applyExposure(c);
  } else if (uKind == 4) {
    c = applyGradientMap(c);
  } else if (uKind == 5) {
    float n = hash(floor(vUV * uDocSize / max(uGrain.y, 1.0)) + uSeed) - 0.5;
    float amt = uGrain.x / 100.0;
    if (uGrain.w > 0.5) {
      c = clamp(c + n * amt, 0.0, 1.0);
    } else {
      c = clamp(c + vec3(n, hash(floor(vUV * uDocSize) + uSeed + 17.0), hash(floor(vUV * uDocSize) + uSeed + 43.0)) * amt - amt * 0.5, 0.0, 1.0);
    }
  } else if (uKind == 6) {
    c = 1.0 - c;
  } else if (uKind == 7) {
    c = applyBlackWhite(c);
  } else if (uKind == 8) {
    c = applyColorBalance(c);
  } else if (uKind == 9) {
    c = sampleBlur(vUV);
  } else if (uKind == 10) {
    c = sampleMotion(vUV);
  } else if (uKind == 11) {
    float amt = uGrain.x / 100.0;
    float n1 = hash(vUV * uDocSize + uSeed);
    float n2 = hash(vUV * uDocSize * 1.7 + uSeed + 91.0);
    float n3 = hash(vUV * uDocSize * 2.3 + uSeed + 311.0);
    vec3 noise = uGrain.w > 0.5 ? vec3(n1) : vec3(n1, n2, n3);
    c = clamp(c + (noise - 0.5) * amt, 0.0, 1.0);
  }

  // 调整图层自身的覆盖范围（蒙版）与不透明度
  float coverage = uOpacity;
  if (uHasMask == 1) {
    vec2 docPx = vUV * uDocSize;
    vec2 muv = (uDocToMask * vec3(docPx, 1.0)).xy;
    float m = 0.0;
    if (muv.x >= 0.0 && muv.x <= 1.0 && muv.y >= 0.0 && muv.y <= 1.0) m = texture(uMask, muv).r;
    coverage *= m;
  }
  vec3 outRgb = mix(base.rgb, c, clamp(coverage, 0.0, 1.0));
  fragColor = vec4(outRgb, base.a);
}
`
