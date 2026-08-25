/**
 * N 体重力シミュレーション。
 * すべての星が、すべての星から引力を受ける（総当たり計算）。
 * 1024〜2048 個なら GPU にとっては軽い仕事なので、素直に全ペアを回す。
 */

/**
 * 速度更新：全ペアの万有引力を足し合わせる。
 * GLSL ES 1.0 のループ上限は定数でなければならないので、
 * テクスチャの一辺を #define として埋め込んでシェーダを組み立てる。
 */
export function buildVelocityShader(texSize: number): string {
  return /* glsl */ `
#define TEX_SIZE ${texSize}
precision highp float;
varying vec2 vUv;

uniform sampler2D uPosition;   // xy = 位置, z = 予備, w = 質量
uniform sampler2D uVelocity;
uniform float uDt;
uniform float uTexSize;
uniform float uGravity;
uniform float uBounds;

void main() {
  vec4 self = texture2D(uPosition, vUv);
  vec3 vel = texture2D(uVelocity, vUv).xyz;
  vec2 accel = vec2(0.0);

  for (int y = 0; y < TEX_SIZE; y++) {
    for (int x = 0; x < TEX_SIZE; x++) {
      vec2 uv = (vec2(float(x), float(y)) + 0.5) / uTexSize;
      vec4 other = texture2D(uPosition, uv);
      vec2 d = other.xy - self.xy;
      float dist2 = dot(d, d);
      // ソフトニング。ゼロ距離で無限大の力が出るのを防ぐ
      float soft = dist2 + 0.35;
      accel += d * (uGravity * other.w / (soft * sqrt(soft)));
    }
  }

  vel.xy += accel * uDt;
  // 数値誤差で加速し続けないよう、ごくわずかに減衰させる
  vel.xy *= 0.9995;
  // 遠くへ飛び去った星は速度を殺しておく（位置側で呼び戻す）
  if (dot(self.xy, self.xy) > uBounds * uBounds) vel.xy *= 0.94;

  gl_FragColor = vec4(vel, 1.0);
}
`
}

/** 位置更新。画面外へ大きく外れた星は中心付近へ呼び戻す。 */
export const POSITION_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uPosition;
uniform sampler2D uVelocity;
uniform float uDt;
uniform float uBounds;

void main() {
  vec4 pos = texture2D(uPosition, vUv);
  vec3 vel = texture2D(uVelocity, vUv).xyz;
  pos.xy += vel.xy * uDt;

  // 飛び去ったままだと画面が寂しくなるので、反対側から戻す
  float r2 = dot(pos.xy, pos.xy);
  if (r2 > uBounds * uBounds * 2.25) {
    pos.xy *= uBounds / max(sqrt(r2), 1e-4);
  }

  gl_FragColor = pos;
}
`

/** 星を1個だけ書き換えるパス（クリックで追加するときに使う）。 */
export const INJECT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uSource;
uniform vec2 uTarget;     // 書き換えるテクセルの uv
uniform float uTexel;
uniform vec4 uValue;

void main() {
  vec4 current = texture2D(uSource, vUv);
  // 対象のテクセルだけ差し替える
  float hit = step(abs(vUv.x - uTarget.x), uTexel * 0.5) *
              step(abs(vUv.y - uTarget.y), uTexel * 0.5);
  gl_FragColor = mix(current, uValue, hit);
}
`

/** 星そのものの描画。質量が大きいほど大きく明るい。 */
export const RENDER_VERT = /* glsl */ `
precision highp float;
attribute vec2 aRef;

uniform sampler2D uPosition;
uniform sampler2D uVelocity;
uniform float uScale;      // ワールド → クリップ
uniform float uAspect;
uniform float uPixelRatio;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec4 pos = texture2D(uPosition, aRef);
  vec3 vel = texture2D(uVelocity, aRef).xyz;

  gl_Position = vec4(pos.x * uScale / uAspect, pos.y * uScale, 0.0, 1.0);

  float speed = length(vel.xy);
  // 速い星ほど白く、ゆっくりな星は橙色に
  float heat = clamp(speed * 0.055, 0.0, 1.0);
  vColor = mix(vec3(1.0, 0.48, 0.18), vec3(1.0, 0.97, 0.9), heat);
  vAlpha = 0.22 + 0.28 * heat;

  gl_PointSize = uPixelRatio * (1.6 + pow(pos.w, 0.42) * 1.9);
}
`

/**
 * 軌跡を線分で描く。
 *
 * 点だけで描くと、1フレームに数ピクセル進む星は破線になってしまう。
 * 「前フレームの位置 → 今の位置」を線で結べば、尾が途切れない。
 */
export const TRAIL_VERT = /* glsl */ `
precision highp float;
attribute vec2 aRef;
attribute float aSide;     // 0 = 尾（前フレームの位置）, 1 = 頭（現在位置）

uniform sampler2D uPosition;
uniform sampler2D uVelocity;
uniform float uScale;
uniform float uAspect;
uniform float uTrailDt;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec4 pos = texture2D(uPosition, aRef);
  vec3 vel = texture2D(uVelocity, aRef).xyz;

  vec2 p = pos.xy - vel.xy * uTrailDt * (1.0 - aSide);
  gl_Position = vec4(p.x * uScale / uAspect, p.y * uScale, 0.0, 1.0);

  float speed = length(vel.xy);
  float heat = clamp(speed * 0.055, 0.0, 1.0);
  vColor = mix(vec3(1.0, 0.42, 0.14), vec3(1.0, 0.95, 0.86), heat);
  // 重い星ほど濃い尾を引く
  vAlpha = (0.1 + 0.16 * heat) * (0.5 + min(pos.w, 60.0) * 0.02);
}
`

export const TRAIL_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
void main() { gl_FragColor = vec4(vColor, vAlpha); }
`

export const RENDER_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 offset = gl_PointCoord - 0.5;
  float d2 = dot(offset, offset);
  if (d2 > 0.25) discard;
  float falloff = smoothstep(0.25, 0.0, d2);
  gl_FragColor = vec4(vColor, falloff * vAlpha);
}
`

/** 前フレームの絵をわずかに暗くして残す。これが軌跡になる。 */
export const FADE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform float uFade;

void main() {
  vec4 c = texture2D(uSource, vUv) * uFade;
  // 完全に消えきらずに薄く残り続けるのを防ぐ
  gl_FragColor = max(c - 0.004, vec4(0.0));
}
`

/** 軌跡バッファを画面へ。淡いところを持ち上げて星雲らしくする。 */
export const DISPLAY_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSource;

void main() {
  vec3 c = texture2D(uSource, vUv).rgb;
  // 軌跡は加算で溜まるので、そのまま出すと重なった所が真っ白に潰れる。
  // Reinhard トーンマップで上を寝かせつつ、暗部を持ち上げる
  c = c / (1.0 + c);
  c = pow(c, vec3(0.82));
  gl_FragColor = vec4(c, 1.0);
}
`
