/**
 * 稲妻。空・雲・地面は1枚のフラグメントシェーダで描き、
 * 稲妻本体は CPU で生成した折れ線をクアッドリボンとして加算合成する。
 *
 * 座標系はすべて「画面の高さ = 1」の等方座標（x は 0..aspect、y は下が 0）。
 * 解像度に依存する値を持たないので、内部解像度を落としても見た目が保たれる。
 */
import { GLSL_NOISE } from '../../core/gpu'

/** 雲・空・地面。オクターブ数は GLSL ES 1.0 の定数ループ制約のため #define で焼き込む */
export function buildCloudShader(octaves: number): string {
  return /* glsl */ `
precision highp float;
varying vec2 vUv;

#define OCTAVES ${octaves}
#define MAX_FLASH 4

uniform float uTime;
uniform float uAspect;
// 直近の落雷。xy = 発光点（等方座標）, z = 現在の強度
uniform vec3 uFlashes[MAX_FLASH];
// 雲全体が内側から光るシートフラッシュ
uniform float uSheet;

${GLSL_NOISE}

float fbm(vec3 p) {
  float n = 0.0;
  float amp = 0.55;
  for (int o = 0; o < OCTAVES; o++) {
    n += amp * snoise(p);
    p = p * 2.02 + vec3(19.7);
    amp *= 0.5;
  }
  return n;
}

// 地面の稜線。index.ts の ridgeBase() と同じ式にしておくこと
// （CPU 側が着弾点をこの高さに合わせて狙う）
float ridgeBase(float x) {
  return 0.10 + 0.035 * sin(x * 3.1 + 1.7) + 0.018 * sin(x * 7.3 + 0.4)
       + 0.010 * sin(x * 13.7 + 2.6);
}

void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);

  // 空。地平線の際だけわずかに明るい
  vec3 col = mix(vec3(0.036, 0.044, 0.078), vec3(0.013, 0.016, 0.032),
                 smoothstep(0.0, 0.8, vUv.y));

  // フラッシュ光源の合計。1/d^2 で減衰させ、シート分は全体に足す
  float light = uSheet * 0.6;
  for (int i = 0; i < MAX_FLASH; i++) {
    vec3 f = uFlashes[i];
    vec2 d = p - f.xy;
    light += f.z / (1.0 + dot(d, d) * 30.0);
  }

  // 雷雲。雲底の高さがノイズで揺れ、上へ行くほど密度が上がる
  float drift = uTime * 0.014;
  float n = fbm(vec3(p.x * 1.3 + drift, p.y * 2.2, uTime * 0.025));
  float ceiling = 0.60 + 0.14 * n;
  float body = smoothstep(ceiling - 0.05, ceiling + 0.25, vUv.y);
  float density = body * clamp(0.6 + 0.9 * n, 0.0, 1.5);

  // 雲底ほどフラッシュに照らされる（光源は雲の下にあるため）
  float under = smoothstep(ceiling + 0.30, ceiling, vUv.y);
  vec3 cloud = vec3(0.030, 0.036, 0.062) * (0.4 + 0.6 * density)
             + vec3(0.60, 0.67, 1.0) * light * density * (0.5 + 0.9 * under);
  col = mix(col, cloud, body);

  // 雲間の常時の微光。真っ暗な放置画面を避け、嵐の気配を出す
  float pulse = 0.16 + 0.09 * sin(uTime * 0.6 + n * 5.0);
  col += vec3(0.06, 0.07, 0.12) * body * max(n, 0.0) * (pulse + 1.2 * light);

  // 地面の稜線シルエット
  float ridge = ridgeBase(p.x) + 0.006 * snoise(vec3(p.x * 6.0, 31.0, 0.0));
  float ground = 1.0 - smoothstep(ridge - 0.003, ridge + 0.003, vUv.y);
  vec3 gcol = vec3(0.004, 0.005, 0.009) + vec3(0.35, 0.42, 0.70) * light * 0.10;
  col = mix(col, gcol, ground);

  // 地表付近の霞。落雷のとき着弾点のまわりがふわっと浮かび上がる
  float haze = exp(-max(vUv.y - ridge, 0.0) * 9.0) * (1.0 - ground);
  col += vec3(0.10, 0.12, 0.20) * haze * light * 0.8;

  gl_FragColor = vec4(col, 1.0);
}
`
}

/**
 * 稲妻のクアッドリボン。WebGL の線幅は 1px 固定なので、
 * 線分ごとに4頂点のクアッドを持ち、頂点シェーダで法線方向へ太らせる。
 * ボルト単位の明滅は uniform 配列で渡す（動的 index の保証がある頂点側で参照）。
 */
export function buildBoltVert(slots: number): string {
  return /* glsl */ `
precision highp float;
#define SLOTS ${slots}

attribute vec4 aSeg;    // xy = 始点, zw = 終点（等方座標）
attribute vec2 aCorner; // x = 線分に沿う位置 0/1, y = 横断方向 -1/+1
attribute vec3 aMeta;   // x = 半幅, y = セグメント輝度, z = スロット番号

uniform float uAspect;
uniform float uIntensity[SLOTS];

varying float vAcross;
varying float vGlow;

void main() {
  // 自分のスロットの明滅強度を拾う。定数ループなので ES 1.0 でも安全
  float k = 0.0;
  for (int i = 0; i < SLOTS; i++) {
    if (abs(float(i) - aMeta.z) < 0.5) k = uIntensity[i];
  }

  vec2 a = aSeg.xy;
  vec2 b = aSeg.zw;
  vec2 d = b - a;
  float len = max(length(d), 1e-6);
  vec2 t = d / len;
  vec2 nrm = vec2(-t.y, t.x);

  // 消えているボルトは面積ゼロに潰して描画コストごと消す
  float w = aMeta.x * step(0.002, k);
  vec2 pos = mix(a, b, aCorner.x)
           + nrm * (aCorner.y * w)
           + t * ((aCorner.x * 2.0 - 1.0) * w); // 端を半幅ぶん伸ばして継ぎ目を埋める

  vAcross = aCorner.y;
  vGlow = aMeta.y * k;
  gl_Position = vec4(pos.x / uAspect * 2.0 - 1.0, pos.y * 2.0 - 1.0, 0.0, 1.0);
}
`
}

/**
 * 白い芯 + 青紫の裾。加算合成なので alpha は 1.0 に固定する
 * （AdditiveBlending の src 係数は SrcAlpha。0 にすると寄与が消える）。
 */
export const BOLT_FRAG = /* glsl */ `
precision highp float;
varying float vAcross;
varying float vGlow;

void main() {
  float core = exp(-vAcross * vAcross * 7.0);
  float halo = exp(-abs(vAcross) * 2.4) * 0.42;
  float e = (core * 2.6 + halo) * vGlow;
  vec3 col = mix(vec3(0.50, 0.56, 1.0), vec3(1.0), min(core * 1.15, 1.0));
  gl_FragColor = vec4(col * e, 1.0);
}
`

/**
 * 雨。1滴 = 2頂点の線分で、位置は種と時刻から毎フレーム頂点シェーダで求める
 * （CPU からの頂点更新なし）。fract のラップは1滴の基準点にだけ掛かるので、
 * 2頂点が画面をまたいで繋がることはない。
 */
export const RAIN_VERT = /* glsl */ `
precision highp float;

attribute vec3 aSeed;  // x = 横位置の種, y = 落下位相の種, z = 深度 0..1
attribute float aTip;  // 0 = 尾（上端）, 1 = 頭（下端）

uniform float uTime;
uniform float uAspect;
uniform float uWind;

varying float vA;

void main() {
  float depth = aSeed.z;
  float speed = 0.55 + depth * 0.75; // 画面高/秒。手前の滴ほど速い
  float y = fract(aSeed.y - uTime * speed);
  float x = fract(aSeed.x + uTime * uWind * 0.03 * (0.4 + depth));

  vec2 dir = normalize(vec2(uWind * 0.35, -1.0));
  float len = 0.014 + depth * 0.026;
  // 上下に少しはみ出させて、ラップの瞬間を画面外に隠す
  vec2 p = vec2(x * uAspect, y * 1.10 - 0.05) + dir * (len * aTip);

  vA = (0.25 + 0.75 * depth) * mix(0.25, 1.0, aTip);
  gl_Position = vec4(p.x / uAspect * 2.0 - 1.0, p.y * 2.0 - 1.0, 0.0, 1.0);
}
`

export const RAIN_FRAG = /* glsl */ `
precision highp float;
uniform float uGlint; // 落雷の光を受けて雨が瞬く
varying float vA;

void main() {
  vec3 col = vec3(0.42, 0.52, 0.78) * (0.09 + uGlint * 0.5);
  gl_FragColor = vec4(col * vA, 1.0);
}
`

/** しきい値より明るい成分だけを取り出す（ソフトニー）。1/4 解像度へ描く。 */
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

/** 9タップのガウシアンブラー。uDir を (texel,0) / (0,texel) にして2回かける。 */
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

/**
 * 合成して画面へ。HDR をトーンマップし、グローと全画面フラッシュを乗せる。
 * 稲妻の一瞬の白がこの作品の主役なので、暗部はほぼ持ち上げない。
 */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uLift; // 落雷直後だけ画面全体が青白く持ち上がる

void main() {
  vec3 c = texture2D(uScene, vUv).rgb + texture2D(uBloom, vUv).rgb * uBloomStrength;
  c += uLift * vec3(0.10, 0.12, 0.19);
  c = c / (1.0 + c); // Reinhard
  c = pow(c, vec3(0.85));
  vec2 q = vUv - 0.5;
  c *= 1.0 - 0.30 * dot(q, q); // 軽いビネット

  // 暗い空に伸びるグローの裾のバンディングを 1/255 のディザで均す
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  c += (dither - 0.5) / 255.0;

  gl_FragColor = vec4(c, 1.0);
}
`
