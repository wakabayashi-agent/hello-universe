/**
 * Stable Fluids（Jos Stam, 1999）の GPU 実装で使うシェーダ群。
 *
 * 1フレームの流れ：
 *   splat（外力と色を注入）
 *   → curl → vorticity（渦を強調して、すぐ均されないようにする）
 *   → divergence → pressure(ヤコビ反復) → gradientSubtract（非圧縮にする）
 *   → advect(速度) → advect(色) → display
 */

const HEADER = /* glsl */ `
precision highp float;
varying vec2 vUv;
`

/** 移流：その点の値を「速度を逆にたどった先」から拾ってくる。 */
export const ADVECTION_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexelSize;
uniform float uDt;
uniform float uDissipation;

void main() {
  vec2 coord = vUv - uDt * texture2D(uVelocity, vUv).xy * uTexelSize;
  vec4 result = texture2D(uSource, coord);
  // 時間とともにゆっくり薄れる。これが無いと画面が色で埋まる
  gl_FragColor = result / (1.0 + uDissipation * uDt);
}
`

/** 発散：その点から湧き出している量。これを圧力で打ち消す。 */
export const DIVERGENCE_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D uVelocity;
uniform vec2 uTexelSize;

void main() {
  float L = texture2D(uVelocity, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture2D(uVelocity, vUv + vec2(uTexelSize.x, 0.0)).x;
  float B = texture2D(uVelocity, vUv - vec2(0.0, uTexelSize.y)).y;
  float T = texture2D(uVelocity, vUv + vec2(0.0, uTexelSize.y)).y;

  // 画面の縁は壁。速度を反転させて跳ね返す
  vec2 C = texture2D(uVelocity, vUv).xy;
  if (vUv.x - uTexelSize.x < 0.0) { L = -C.x; }
  if (vUv.x + uTexelSize.x > 1.0) { R = -C.x; }
  if (vUv.y - uTexelSize.y < 0.0) { B = -C.y; }
  if (vUv.y + uTexelSize.y > 1.0) { T = -C.y; }

  gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}
`

/** 渦度（回転の強さ）を測る。 */
export const CURL_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D uVelocity;
uniform vec2 uTexelSize;

void main() {
  float L = texture2D(uVelocity, vUv - vec2(uTexelSize.x, 0.0)).y;
  float R = texture2D(uVelocity, vUv + vec2(uTexelSize.x, 0.0)).y;
  float B = texture2D(uVelocity, vUv - vec2(0.0, uTexelSize.y)).x;
  float T = texture2D(uVelocity, vUv + vec2(0.0, uTexelSize.y)).x;
  gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}
`

/**
 * 渦度閉じ込め。数値計算で消えてしまう細かい渦にエネルギーを戻す。
 * これが無いと、かき混ぜてもすぐのっぺりしてしまう。
 */
export const VORTICITY_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform vec2 uTexelSize;
uniform float uCurlStrength;
uniform float uDt;

void main() {
  float L = texture2D(uCurl, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture2D(uCurl, vUv + vec2(uTexelSize.x, 0.0)).x;
  float B = texture2D(uCurl, vUv - vec2(0.0, uTexelSize.y)).x;
  float T = texture2D(uCurl, vUv + vec2(0.0, uTexelSize.y)).x;
  float C = texture2D(uCurl, vUv).x;

  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 1e-4;
  force *= uCurlStrength * C;
  force.y *= -1.0;

  vec2 velocity = texture2D(uVelocity, vUv).xy + force * uDt;
  gl_FragColor = vec4(clamp(velocity, -1000.0, 1000.0), 0.0, 1.0);
}
`

/**
 * テクスチャを定数倍する。圧力場を毎フレーム減衰させるのに使う。
 *
 * これが無いと圧力が毎フレーム積み上がり、half float の表現範囲を
 * 越えて Inf → NaN になり、画面が真っ黒になる。
 */
export const CLEAR_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D uTexture;
uniform float uValue;
void main() { gl_FragColor = texture2D(uTexture, vUv) * uValue; }
`

/** 圧力のポアソン方程式をヤコビ法で解く（1反復ぶん）。 */
export const PRESSURE_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexelSize;

void main() {
  float L = texture2D(uPressure, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture2D(uPressure, vUv + vec2(uTexelSize.x, 0.0)).x;
  float B = texture2D(uPressure, vUv - vec2(0.0, uTexelSize.y)).x;
  float T = texture2D(uPressure, vUv + vec2(0.0, uTexelSize.y)).x;
  float divergence = texture2D(uDivergence, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  // 念のための安全弁。一度でも Inf が混ざると場全体が NaN で汚染される
  gl_FragColor = vec4(clamp(pressure, -3000.0, 3000.0), 0.0, 0.0, 1.0);
}
`

/** 圧力の勾配を引いて、湧き出しのない（非圧縮な）速度場にする。 */
export const GRADIENT_SUBTRACT_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform vec2 uTexelSize;

void main() {
  float L = texture2D(uPressure, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture2D(uPressure, vUv + vec2(uTexelSize.x, 0.0)).x;
  float B = texture2D(uPressure, vUv - vec2(0.0, uTexelSize.y)).x;
  float T = texture2D(uPressure, vUv + vec2(0.0, uTexelSize.y)).x;
  vec2 velocity = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
  gl_FragColor = vec4(velocity, 0.0, 1.0);
}
`

/** 指の位置にガウス分布で力（または色）を足し込む。 */
export const SPLAT_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D uTarget;
uniform float uAspectRatio;
uniform vec3 uColor;
uniform vec2 uPoint;
uniform float uRadius;

void main() {
  vec2 p = vUv - uPoint;
  p.x *= uAspectRatio;
  vec3 splat = exp(-dot(p, p) / uRadius) * uColor;
  gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + splat, 1.0);
}
`

/**
 * 画面へ出す。色の勾配から擬似的な陰影をつけると、
 * ただの塗りが「厚みのある液体」に見える。
 */
export const DISPLAY_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D uTexture;
uniform vec2 uTexelSize;

void main() {
  vec3 c = texture2D(uTexture, vUv).rgb;

  float l = length(texture2D(uTexture, vUv - vec2(uTexelSize.x, 0.0)).rgb);
  float r = length(texture2D(uTexture, vUv + vec2(uTexelSize.x, 0.0)).rgb);
  float b = length(texture2D(uTexture, vUv - vec2(0.0, uTexelSize.y)).rgb);
  float t = length(texture2D(uTexture, vUv + vec2(0.0, uTexelSize.y)).rgb);

  vec3 normal = normalize(vec3(r - l, t - b, 0.18));
  float light = clamp(dot(normal, normalize(vec3(-0.4, 0.7, 0.6))), 0.0, 1.0);
  // 陰影は「足す」方向だけにする。掛けて暗くすると画面全体が沈む
  c *= 1.0 + 0.75 * light;

  // 濃いところを飛ばして艶を出す
  c += pow(clamp(length(c) - 0.7, 0.0, 1.0), 1.4) * 0.6;

  gl_FragColor = vec4(c, 1.0);
}
`
