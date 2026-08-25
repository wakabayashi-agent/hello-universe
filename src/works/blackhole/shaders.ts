/**
 * ブラックホール（シュヴァルツシルト時空）の測地線レイトレーサ。
 *
 * 光の経路は、擬ニュートン形式に書き直した測地線方程式
 *   d²x/dλ² = -(3/2) rs h² x / r⁵   （h = |x×v| はレイごとの保存量）
 * に従う。これは null 測地線（光）に対して厳密で、重力レンズ・光子球・
 * 影の半径 (3√3/2)rs ≈ 2.598 がすべて理論どおりの値で出る。
 *
 * 力が位置だけで決まる中心力なので、ベロシティ・ベルレで積分すると
 * シンプレクティックになり、光子球付近を何周も巻き付く軌道が崩れない。
 * 素朴な積和だけで誤差補償を使わないので、式を組み替える
 * シェーダコンパイラ（WebKit/Metal の fast-math）でも壊れない。
 *
 * 注意: v を毎ステップ正規化してはならない。この方程式は |v| が
 * r とともに増減する形でのみ Binet 方程式と一致する（正規化すると
 * 影の半径が理論値からずれる）。
 */
import { GLSL_NOISE } from '../../core/gpu'

export function buildBlackholeShader(steps: number, octaves: number): string {
  return /* glsl */ `
precision highp float;
varying vec2 vUv;

#define STEPS ${steps}
#define OCTAVES ${octaves}

// 単位系: シュヴァルツシルト半径 rs = 1（質量 M = 0.5）
#define DISK_IN 3.0    // 降着円盤の内縁 = 最内安定円軌道（ISCO）
#define DISK_OUT 10.0  // 円盤の外縁
#define FLOW_T 12.0    // 円盤模様のフローマップ周期（秒）

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;
// 円盤の回転方向（±1）。模様の流れる向きとドップラーで明るい側の
// 両方がこの1つから決まる。別々に持つと「流れてくる側が暗い」という
// 物理的に変な絵になる
uniform float uDiskDir;

${GLSL_NOISE}

// 円盤の筋模様。円周上の点を3Dノイズに埋め込むので継ぎ目が出ない。
// 半径方向の周波数を上げ、周方向は円周スケールに任せて筋状にする
float diskPattern(float rd, float ang, float seed) {
  vec3 q = vec3(cos(ang) * rd * 0.55, sin(ang) * rd * 0.55, rd * 2.1 + seed);
  float n = 0.0;
  float amp = 0.6;
  for (int o = 0; o < OCTAVES; o++) {
    n += amp * snoise(q);
    q = q * 2.03 + vec3(11.3);
    amp *= 0.5;
  }
  return n;
}

// 黒体放射風の手調整3点ランプ（低温=深い橙 → 白 → 高温=青白）
vec3 blackbody(float t) {
  vec3 c = mix(vec3(1.0, 0.32, 0.06), vec3(1.0, 0.94, 0.83), smoothstep(0.2, 1.0, t));
  return mix(c, vec3(0.70, 0.81, 1.0), smoothstep(1.05, 2.0, t));
}

// 円盤との交点のシェーディング。rgb = 放射（HDR）、a = 遮蔽率。
// bPhoton は光子の保存量 b = Lz/E（レイ初期化時に1回だけ計算）
vec4 diskShade(vec3 p, float rd, float bPhoton) {
  float ang = atan(p.z, p.x);
  float omega = uDiskDir * sqrt(0.5 / (rd * rd * rd)); // ケプラー角速度（M = 0.5）

  // ケプラー回転で流れる模様。差動回転のせん断でノイズが無限に
  // 引き伸ばされて溶けるので、位相を半周期ずらした2サンプルを
  // 三角波の重みでクロスフェードして筋を保つ
  float t1 = fract(uTime / FLOW_T);
  float t2 = fract(uTime / FLOW_T + 0.5);
  float w = abs(t1 * 2.0 - 1.0);
  float n1 = diskPattern(rd, ang - omega * t1 * FLOW_T, 0.0);
  float n2 = diskPattern(rd, ang - omega * t2 * FLOW_T, 7.31);
  float pattern = clamp(0.66 + 0.72 * mix(n1, n2, w), 0.0, 1.8);

  // 半径プロファイル（Shakura–Sunyaev 風）。内縁で立ち上がり外縁へ減衰
  float xr = rd / DISK_IN;
  float edge = smoothstep(1.0, 1.14, xr) * smoothstep(1.0, 0.70, rd / DISK_OUT);
  float emiss = pow(xr, -2.0) * edge;

  // 周波数比 g = √(1−3M/r) / (1−Ω·b)。分子が重力赤方偏移×時間の遅れ、
  // 分母がドップラー項で、どちらもシュヴァルツシルトの厳密式。
  // clamp は接線ぎりぎりのレイで g が飛ぶのを抑える安全弁
  float g = sqrt(max(0.0, 1.0 - 1.5 / rd)) / (1.0 - omega * bPhoton);
  g = clamp(g, 0.35, 2.4);

  float temp = pow(xr, -0.75) * g;               // ドップラーは黒体温度を g 倍する
  float intensity = emiss * pattern * g * g * g; // ビーミング（I ∝ g³）
  vec3 rgb = blackbody(temp) * intensity * 5.2;

  float alpha = clamp(edge * (0.45 + 0.5 * pattern), 0.0, 0.92);
  return vec4(rgb, alpha);
}

// 天の川の帯の法線（傾けた大円）。レンズで弧に伸びるのが見どころ
const vec3 BAND_N = vec3(0.5257, 0.7896, 0.3158);

// 手続き星空。方向ベクトルを拡大して floor したセルごとに hash で
// 星の有無・位置・明るさ・色味を決める。星をサブピクセルにすると
// レンズ歪みの下でチラつくので、ガウスの裾は 1.5px 相当より太くする
vec3 starLayer(vec3 dir, float scale, float density, float k, float boost) {
  vec3 p = dir * scale;
  vec3 cell = floor(p);
  vec3 h = hash33(cell) * 0.5 + 0.5;
  vec3 pos = cell + 0.5 + hash33(cell + 41.7) * 0.32;
  float d2 = dot(p - pos, p - pos);
  float lit = step(h.x, density);
  float amp = boost * (0.25 + 0.75 * h.y * h.y);
  vec3 tint = mix(vec3(1.0, 0.86, 0.72), vec3(0.74, 0.84, 1.0), h.z);
  return tint * (lit * amp * exp(-d2 * k));
}

// 脱出したレイの行き先。無限遠背景なので方向だけで決まる
vec3 background(vec3 dir) {
  float band = exp(-pow(dot(dir, BAND_N), 2.0) * 18.0);
  float cloud = 0.55 + 0.45 * snoise(dir * 3.7) + 0.25 * snoise(dir * 8.9);
  vec3 c = vec3(0.10, 0.12, 0.17) * band * max(cloud, 0.0);
  c += vec3(0.16, 0.10, 0.08) * band * max(snoise(dir * 6.1 + 3.0), 0.0) * 0.5;
  c += starLayer(dir, 60.0, 0.09, 30.0, 1.5);
  c += starLayer(dir, 130.0, 0.10, 12.0, 0.5);
  return c;
}

void main() {
  vec2 s = (vUv - 0.5) * 2.0;
  vec3 rayDir = normalize(
    uCamFwd + uCamRight * (s.x * uTanHalfFov * uAspect) + uCamUp * (s.y * uTanHalfFov)
  );

  vec3 x = uCamPos;
  vec3 v = rayDir;
  vec3 L = cross(x, v);
  float h2 = dot(L, L);
  // カメラから逆向きに追跡しているので、光子の実際の角運動量は符号が反転する
  float bPhoton = -L.y;

  vec3 col = vec3(0.0);
  float through = 1.0;
  bool escaped = false;

  for (int i = 0; i < STEPS; i++) {
    float r2 = dot(x, x);
    float r = sqrt(r2);
    if (r < 1.02) break; // 事象の地平線に落ちた
    if (r2 > 900.0 && dot(x, v) > 0.0) {
      escaped = true; // 十分遠方で外向き = 脱出
      break;
    }

    // 光子球（r=1.5）付近は細かく、ほぼ直進の遠方は粗く刻む
    float dl = min(1.6, 0.045 + 0.12 * (r - 1.0));

    // ベロシティ・ベルレ（kick-drift-kick）
    vec3 a = -1.5 * h2 * x / (r2 * r2 * r);
    vec3 vh = v + 0.5 * a * dl;
    vec3 xn = x + vh * dl;

    // 赤道面（円盤面）をまたいだら、交点を線形補間で求める。
    // この区間の軌道の曲がりはサブピクセルなので補間で十分。
    // 1回で打ち切らないので、裏側の円盤が上下に回り込んだ像も出る
    if (x.y * xn.y < 0.0) {
      float t = x.y / (x.y - xn.y);
      vec3 p = mix(x, xn, t);
      float rd = length(p.xz);
      if (rd > DISK_IN && rd < DISK_OUT) {
        vec4 disk = diskShade(p, rd, bPhoton);
        col += through * disk.rgb;
        through *= 1.0 - disk.a;
        if (through < 0.02) break; // ほぼ遮られた。以後の寄与は無視できる
      }
    }

    float rn2 = dot(xn, xn);
    float rn = sqrt(rn2);
    vec3 an = -1.5 * h2 * xn / (rn2 * rn2 * rn);
    v = vh + 0.5 * an * dl;
    x = xn;
  }

  // ループを使い切ったレイは光子球へ極限まで巻き付いた光。
  // 無理に背景を出すとノイズの粒になるので捕獲扱い（黒）にして縁を締める
  if (escaped) col += through * background(normalize(v));

  gl_FragColor = vec4(col, 1.0);
}
`
}

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
 * 合成して画面へ。HDR をトーンマップし、グローを乗せる。
 * 影が真っ黒であることがこの作品の主役なので、暗部は持ち上げない。
 */
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
  c *= 1.0 - 0.28 * dot(q, q); // 軽いビネット

  // 黒い空に伸びるグローの裾はそのままだと縞（バンディング）が見える。
  // 1/255 のディザを足して均す
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  c += (dither - 0.5) / 255.0;

  gl_FragColor = vec4(c, 1.0);
}
`
