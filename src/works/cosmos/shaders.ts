import { GLSL_NOISE } from '../../core/gpu'

/** 位置更新：速度を積分するだけ。w には粒子ごとのシードを保持し続ける。 */
export const POSITION_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uPosition;
uniform sampler2D uVelocity;
uniform float uDt;
varying vec2 vUv;

void main() {
  vec4 pos = texture2D(uPosition, vUv);
  vec3 vel = texture2D(uVelocity, vUv).xyz;
  pos.xyz += vel * uDt;
  gl_FragColor = pos;
}
`

/**
 * 速度更新。ここが作品の心臓部。
 * 目標へのばね + カールノイズ + 銀河の自転 + カーソルからの斥力 + 爆発。
 */
export const VELOCITY_FRAG = /* glsl */ `
precision highp float;
${GLSL_NOISE}

uniform sampler2D uPosition;
uniform sampler2D uVelocity;
uniform sampler2D uTargetText;
uniform sampler2D uTargetGalaxy;

uniform float uDt;
uniform float uTime;
uniform float uMorph;      // 0=文字 1=銀河
uniform float uSpring;     // 目標へ引き寄せる強さ
uniform float uDamping;    // 減衰（1 に近いほど慣性が残る）
uniform float uNoise;      // ゆらぎの強さ
uniform float uSpin;       // 銀河の回転角（TS 側で積算した値）
uniform float uMouseForce;
uniform float uBurst;      // 爆発の一撃（1フレームだけ入る）
uniform vec3 uMouse;

varying vec2 vUv;

vec3 safeNormalize(vec3 v) {
  float len = length(v);
  return len > 1e-5 ? v / len : vec3(0.0, 0.0, 1.0);
}

void main() {
  vec4 posSample = texture2D(uPosition, vUv);
  vec3 pos = posSample.xyz;
  float seed = posSample.w;
  vec3 vel = texture2D(uVelocity, vUv).xyz;

  // 銀河は「力で回す」のではなく目標座標そのものを回す。
  // 力で回すと粒が腕からはみ出して、ただの円盤に均されてしまう。
  // 内側ほど速く回すこと（差動回転）で腕が巻き込まれていく
  vec3 galaxy = texture2D(uTargetGalaxy, vUv).xyz;
  float radius = length(galaxy.xy);
  float angle = uSpin / (0.55 + radius * 0.30);
  float ca = cos(angle);
  float sa = sin(angle);
  galaxy.xy = vec2(galaxy.x * ca - galaxy.y * sa, galaxy.x * sa + galaxy.y * ca);

  vec3 target = mix(texture2D(uTargetText, vUv).xyz, galaxy, uMorph);

  // 個体差。全部の粒がぴったり揃うと機械的に見える
  float variance = 0.75 + seed * 0.5;

  vel += (target - pos) * uSpring * variance * uDt;
  vel += curlNoise(pos * 0.21 + vec3(0.0, 0.0, uTime * 0.09)) * uNoise * variance * uDt;

  vec3 toMouse = pos - uMouse;
  vel += safeNormalize(toMouse) * (uMouseForce / (dot(toMouse, toMouse) + 0.7)) * uDt;

  // 中心が空洞になるよう、シードでずらした方向へ飛ばす
  vel += safeNormalize(pos + (vec3(seed, fract(seed * 7.3), fract(seed * 3.1)) - 0.5) * 1.2) * uBurst;

  vel *= pow(uDamping, uDt * 60.0);

  gl_FragColor = vec4(vel, 1.0);
}
`

/** 描画：位置をテクスチャから読んで点を打つ。 */
export const RENDER_VERT = /* glsl */ `
precision highp float;
attribute vec2 aRef;

uniform sampler2D uPosition;
uniform sampler2D uVelocity;
uniform float uSize;
uniform float uPixelRatio;
uniform float uBrightness;

varying vec3 vColor;
varying float vAlpha;

vec3 palette(float t) {
  vec3 cyan  = vec3(0.16, 0.78, 1.00);
  vec3 white = vec3(1.00, 0.96, 0.92);
  vec3 mag   = vec3(0.72, 0.34, 1.00);
  return t < 0.5 ? mix(cyan, white, t * 2.0) : mix(white, mag, (t - 0.5) * 2.0);
}

void main() {
  vec4 posSample = texture2D(uPosition, aRef);
  vec3 vel = texture2D(uVelocity, aRef).xyz;

  vec4 mv = modelViewMatrix * vec4(posSample.xyz, 1.0);
  gl_Position = projectionMatrix * mv;

  float speed = length(vel);
  vColor = palette(clamp(speed * 0.14 + posSample.w * 0.4, 0.0, 1.0));
  // 26万個を加算合成するので 1 粒あたりの寄与はごく小さくする。
  // 明るさは「粒の重なり具合」が作る（密なところだけ白く飽和する）
  vAlpha = uBrightness * (1.0 + 1.4 * smoothstep(0.0, 3.5, speed));

  float depth = max(-mv.z, 0.1);
  gl_PointSize = uSize * uPixelRatio * (11.0 / depth);
}
`

export const RENDER_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;

// 0 のときは芯だけ。1 にすると裾を広げて、ブルーム無しでも光って見せる
uniform float uGlow;

void main() {
  vec2 offset = gl_PointCoord - 0.5;
  float d2 = dot(offset, offset);
  if (d2 > 0.25) discard;
  // 中心が濃く外側がふわっと消える円。四角い点に見せない
  float core = smoothstep(0.25, 0.01, d2);
  float halo = exp(-d2 * 11.0);
  float shape = mix(core, core * 0.55 + halo * 0.5, uGlow);
  gl_FragColor = vec4(vColor, shape * vAlpha);
}
`
