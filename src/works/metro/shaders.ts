/**
 * 東京メトロ3D運行のシェーダ群。
 *
 * すべて HDR(HalfFloat RT)前提で、輝度 1.0 超はミニブルームが拾って
 * 発光の裾になる。加算合成のフラグメントは必ず vec4(rgb, 1.0) の形にする
 * （three.js の AdditiveBlending は src 係数が SrcAlpha — 既知の落とし穴）。
 *
 * uniform 配列（uColor[9] / uDim[9]）の動的添字は GLSL ES 1.0 では
 * 頂点シェーダでのみ安全なので、色は必ず vertex で引いて varying で渡す。
 */

/** 路線チューブ。フレネルで稜線を HDR に光らせる。 */
export const TUBE_VERT = /* glsl */ `
attribute float aLine;

uniform vec3 uColor[9];
uniform float uDim[9];

varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorld;

void main() {
  int li = int(aLine + 0.5);
  vColor = uColor[li] * uDim[li];
  vNormal = normal;      // メッシュは無変換なのでそのままワールド法線
  vWorld = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const TUBE_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uCamPos;

varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorld;

void main() {
  vec3 view = normalize(uCamPos - vWorld);
  float fresnel = pow(1.0 - abs(dot(normalize(vNormal), view)), 1.6);
  vec3 col = vColor * (0.42 + 1.5 * fresnel);
  gl_FragColor = vec4(col, 1.0);
}
`

/** 駅ノード。乗換駅は大きく白寄り（色は CPU 側で決めて attribute で渡す）。 */
export const STATION_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aLine;

uniform float uDim[9];
uniform float uPixelRatio;

varying vec3 vColor;

void main() {
  int li = int(aLine + 0.5);
  vColor = aColor * (0.3 + 0.7 * uDim[li]);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPixelRatio * clamp(16.0 / -mv.z, 0.35, 2.6);
  gl_Position = projectionMatrix * mv;
}
`

export const STATION_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;

void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d2 = dot(q, q);
  if (d2 > 0.25) discard;
  float falloff = smoothstep(0.25, 0.02, d2);
  gl_FragColor = vec4(vColor * falloff, 1.0);
}
`

/**
 * 列車。InstancedMesh の箱。ローカル +x が進行方向で、先頭ほど白熱させ、
 * ブルームが進行方向に伸びる光条を作る。
 */
export const TRAIN_VERT = /* glsl */ `
attribute float aTrainLine;

uniform vec3 uColor[9];
uniform float uDim[9];

varying vec3 vColor;

void main() {
  int li = int(aTrainLine + 0.5);
  // 減光中の路線でも列車はうっすら残す（動きの気配は消さない）
  vec3 base = uColor[li] * (0.3 + 0.7 * uDim[li]);
  float head = smoothstep(-0.1, 0.5, position.x);
  vColor = mix(base, vec3(1.35), head * 0.72) * 3.5;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`

export const TRAIN_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;

void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`

/** 淡い線（乗換シャフト・山手線ゴースト・皇居）。uTint で色と強さを渡す。 */
export const GHOST_LINE_VERT = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const GHOST_LINE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uTint;

void main() {
  gl_FragColor = vec4(uTint, 1.0);
}
`

/** 地表の1km格子。中心から遠いほど淡く消える。加算なので地下を隠さない。 */
export const GRID_VERT = /* glsl */ `
varying vec2 vXZ;

void main() {
  vXZ = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const GRID_FRAG = /* glsl */ `
precision highp float;
varying vec2 vXZ;

void main() {
  vec2 g = abs(fract(vXZ) - 0.5);
  float line = smoothstep(0.035, 0.0, min(g.x, g.y));
  float fade = exp(-dot(vXZ, vXZ) / 900.0);
  gl_FragColor = vec4(vec3(0.055, 0.075, 0.12) * line * fade, 1.0);
}
`

/**
 * 駅名ラベル（Canvas2D アトラスのビルボード）。
 * カメラからの距離に比例した大きさにして画面上でほぼ一定サイズに見せる。
 * 輝度は 1.0 未満に抑えてブルームで文字を滲ませない。
 */
export const LABEL_VERT = /* glsl */ `
attribute vec3 aLabelPos;
attribute vec4 aUvRect;
attribute float aVis;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;

varying vec2 vUvRect;
varying float vVis;

void main() {
  vVis = aVis;
  float d = length(uCamPos - aLabelPos);
  vec3 world = aLabelPos
    + uCamRight * position.x * d * 0.135
    + uCamUp * (position.y * d * 0.030 + d * 0.028);
  vUvRect = vec2(aUvRect.x + uv.x * aUvRect.z, aUvRect.y + uv.y * aUvRect.w);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`

export const LABEL_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;

varying vec2 vUvRect;
varying float vVis;

void main() {
  vec4 t = texture2D(uAtlas, vUvRect);
  gl_FragColor = vec4(t.rgb * t.a * 0.88 * vVis, 1.0);
}
`

/** しきい値より明るい成分だけを取り出す（ソフトニー）。blackhole と同型。 */
export const BRIGHT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;

void main() {
  vec3 c = texture2D(uScene, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float k = max(l - 1.0, 0.0) / (l + 1e-4);
  gl_FragColor = vec4(c * k, 1.0);
}
`

/** 9タップのガウシアンブラー。uDir を (texel,0)/(0,texel) にして2回かける。 */
export const BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform vec2 uDir;

void main() {
  vec3 c = texture2D(uSource, vUv).rgb * 0.227027;
  c += texture2D(uSource, vUv + uDir).rgb * 0.1945946;
  c += texture2D(uSource, vUv - uDir).rgb * 0.1945946;
  c += texture2D(uSource, vUv + uDir * 2.0).rgb * 0.1216216;
  c += texture2D(uSource, vUv - uDir * 2.0).rgb * 0.1216216;
  c += texture2D(uSource, vUv + uDir * 3.0).rgb * 0.054054;
  c += texture2D(uSource, vUv - uDir * 3.0).rgb * 0.054054;
  c += texture2D(uSource, vUv + uDir * 4.0).rgb * 0.016216;
  c += texture2D(uSource, vUv - uDir * 4.0).rgb * 0.016216;
  gl_FragColor = vec4(c, 1.0);
}
`

/** 合成して画面へ。ビネットは画面端の路線が沈まないよう弱め。 */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;

void main() {
  vec3 c = texture2D(uScene, vUv).rgb + texture2D(uBloom, vUv).rgb * uBloomStrength;
  c = c / (1.0 + c); // Reinhard
  c = pow(c, vec3(0.85));
  vec2 q = vUv - 0.5;
  c *= 1.0 - 0.22 * dot(q, q);

  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  c += (dither - 0.5) / 255.0;

  gl_FragColor = vec4(c, 1.0);
}
`
