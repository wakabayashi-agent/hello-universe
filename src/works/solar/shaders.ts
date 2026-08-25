/**
 * 太陽系シミュレーターのシェーダ群。
 *
 * 惑星表面はすべて手続き生成。UV を使わず object 空間の単位球方向を
 * 3D ノイズに直接食わせるので、極のピンチも経度の継ぎ目も原理的に出ない。
 * ライティングも object 空間（球なので法線 ≡ 方向が厳密に成り立つ）。
 *
 * 加算合成のフラグメントは必ず vec4(rgb, 1.0) の形（SrcAlpha の罠）。
 */
import { GLSL_NOISE } from '../../core/gpu'
import type { PlanetId } from './data'

/** 惑星・太陽で共通の頂点シェーダ。object 空間位置をそのまま渡す。 */
export const PLANET_VERT = /* glsl */ `
varying vec3 vObj;

void main() {
  vObj = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

/** fbm と共通ヘルパー。OCTAVES はティアで焼き込む。 */
function commonChunk(octaves: number): string {
  return /* glsl */ `
${GLSL_NOISE}
#define OCTAVES ${octaves}

float fbm(vec3 p) {
  float n = 0.0;
  float amp = 0.55;
  for (int o = 0; o < OCTAVES; o++) {
    n += amp * snoise(p);
    p = p * 2.03 + vec3(19.1);
    amp *= 0.5;
  }
  return n;
}
`
}

/** 惑星ごとの表面チャンク。albedo / emissive / specMask / rim を決める。 */
const SURFACES: Record<PlanetId | 'moon', string> = {
  // 水星: セル法クレーター（セル内に収まる半径なので継ぎ目なし）+ エンボス陰影
  mercury: /* glsl */ `
float craters(vec3 dir, float s) {
  vec3 p = dir * s;
  vec3 cell = floor(p);
  vec3 h = hash33(cell) * 0.5 + 0.5;
  vec3 center = cell + 0.3 + h * 0.4;
  float r = 0.08 + h.y * 0.1;
  float q = length(p - center);
  float rim = smoothstep(r * 1.4, r, q) - smoothstep(r * 0.9, r * 0.4, q) * 1.5;
  return rim * step(h.z, 0.6);
}

void surface(vec3 dir, out vec3 albedo, out vec3 emissive, out float specMask,
             out vec3 rimColor, out float rimStrength) {
  vec3 tang = normalize(uSunDirObj - dir * dot(uSunDirObj, dir) + vec3(1e-4));
  vec3 dir2 = normalize(dir + tang * 0.02);
  float hc = craters(dir, 6.0) + craters(dir, 14.0) * 0.6;
  float hs = craters(dir2, 6.0) + craters(dir2, 14.0) * 0.6;
  float emboss = (hc - hs) * 1.6;
  albedo = vec3(0.6, 0.56, 0.52) * (0.72 + 0.28 * fbm(dir * 2.5)) + vec3(emboss * 0.4 + hc * 0.06);
  emissive = vec3(0.0);
  specMask = 0.0;
  rimColor = vec3(0.4, 0.4, 0.42);
  rimStrength = 0.12;
}
`,
  // 金星: 硫酸の雲。緯度依存のせん断で V 字の流れを作る
  venus: /* glsl */ `
void surface(vec3 dir, out vec3 albedo, out vec3 emissive, out float specMask,
             out vec3 rimColor, out float rimStrength) {
  float ang = atan(dir.z, dir.x) + dir.y * dir.y * 1.8 + uTime * 0.015;
  vec3 q = vec3(cos(ang) * 1.4, dir.y * 2.6, sin(ang) * 1.4);
  float clouds = fbm(q + vec3(fbm(q * 2.0)) * 0.35);
  albedo = mix(vec3(0.82, 0.68, 0.42), vec3(0.97, 0.9, 0.68), 0.5 + clouds * 0.55);
  emissive = vec3(0.0);
  specMask = 0.0;
  rimColor = vec3(0.95, 0.9, 0.75);
  rimStrength = 0.55;
}
`,
  // 地球: 海と大陸・雲層・夜側の都市の光・青い大気の縁
  earth: /* glsl */ `
void surface(vec3 dir, out vec3 albedo, out vec3 emissive, out float specMask,
             out vec3 rimColor, out float rimStrength) {
  float h = fbm(dir * 2.2);
  float land = smoothstep(0.015, 0.05, h);
  float ice = smoothstep(0.78, 0.86, abs(dir.y) + 0.06 * fbm(dir * 5.0));

  vec3 ocean = mix(vec3(0.015, 0.07, 0.2), vec3(0.03, 0.19, 0.3), smoothstep(-0.25, 0.02, h));
  vec3 landCol = mix(vec3(0.11, 0.28, 0.1), vec3(0.3, 0.4, 0.17), fbm(dir * 5.7) * 0.5 + 0.5);
  float desert = smoothstep(0.55, 0.85, 1.0 - abs(dir.y)) * smoothstep(0.1, 0.5, fbm(dir * 3.1 + 7.0));
  landCol = mix(landCol, vec3(0.6, 0.48, 0.28), desert);

  vec3 surf = mix(ocean, landCol, land);
  surf = mix(surf, vec3(0.9, 0.93, 0.97), ice);

  // 雲層は表面より少し速く回す（別の生き物に見える）
  float ca = uTime * 0.012;
  vec3 cd = vec3(dir.x * cos(ca) - dir.z * sin(ca), dir.y, dir.x * sin(ca) + dir.z * cos(ca));
  float cl = smoothstep(0.08, 0.5, fbm(cd * 3.4 + vec3(fbm(cd * 7.0)) * 0.5));
  albedo = mix(surf, vec3(0.95), cl * 0.85);

  specMask = (1.0 - land) * (1.0 - cl) * (1.0 - ice);
  float city = smoothstep(0.45, 0.75, fbm(dir * 8.0 + 3.7)) * land * (1.0 - ice) * (1.0 - cl);
  emissive = vec3(1.0, 0.72, 0.35) * city * 0.7;
  rimColor = vec3(0.35, 0.55, 1.0);
  rimStrength = 0.8;
}
`,
  // 火星: 酸化鉄のまだら + 暗色玄武岩地域 + 小さな極冠
  mars: /* glsl */ `
void surface(vec3 dir, out vec3 albedo, out vec3 emissive, out float specMask,
             out vec3 rimColor, out float rimStrength) {
  float m = fbm(dir * 3.2);
  albedo = mix(vec3(0.42, 0.19, 0.1), vec3(0.78, 0.42, 0.22), 0.5 + 0.5 * m);
  albedo = mix(albedo, vec3(0.24, 0.13, 0.08), smoothstep(0.15, 0.45, fbm(dir * 1.7 + 11.0)));
  float ice = smoothstep(0.86, 0.93, abs(dir.y) + 0.03 * fbm(dir * 6.0));
  albedo = mix(albedo, vec3(0.92, 0.88, 0.85), ice);
  emissive = vec3(0.0);
  specMask = 0.0;
  rimColor = vec3(0.9, 0.6, 0.4);
  rimStrength = 0.22;
}
`,
  // 木星: うねる緯度バンド + 帯ごとの差動ドリフト + 大赤斑
  jupiter: /* glsl */ `
void surface(vec3 dir, out vec3 albedo, out vec3 emissive, out float specMask,
             out vec3 rimColor, out float rimStrength) {
  float lat = dir.y;
  float drift = uTime * 0.02 * sign(sin(lat * 7.0) + 0.001);
  float ang = atan(dir.z, dir.x) + drift;
  vec3 bq = vec3(cos(ang), lat * 3.6, sin(ang));
  float band = lat * 5.5 + fbm(bq * 2.2) * 0.6;
  float f = fract(band);
  vec3 c = mix(vec3(0.72, 0.56, 0.38), vec3(0.95, 0.9, 0.78), smoothstep(0.0, 0.35, f));
  c = mix(c, vec3(0.55, 0.34, 0.22), smoothstep(0.42, 0.62, f));
  c = mix(c, vec3(0.72, 0.56, 0.38), smoothstep(0.7, 1.0, f));
  c = mix(c, vec3(0.5, 0.4, 0.3), smoothstep(0.65, 0.95, abs(lat)) * 0.55);

  // 大赤斑（緯度方向に潰した楕円マスク + 内側の渦もよう）
  vec3 spot = normalize(vec3(0.62, -0.34, 0.71));
  float ds = distance(dir * vec3(1.0, 1.8, 1.0), spot * vec3(1.0, 1.8, 1.0));
  float inSpot = smoothstep(0.42, 0.12, ds);
  c = mix(c, vec3(0.8, 0.3, 0.16), inSpot * 0.9);
  c += vec3(0.14, 0.07, 0.03) * inSpot * fbm(dir * 9.0 + uTime * 0.06);

  albedo = c;
  emissive = vec3(0.0);
  specMask = 0.0;
  rimColor = vec3(0.9, 0.8, 0.6);
  rimStrength = 0.3;
}
`,
  // 土星: 木星の弱コントラスト版
  saturn: /* glsl */ `
void surface(vec3 dir, out vec3 albedo, out vec3 emissive, out float specMask,
             out vec3 rimColor, out float rimStrength) {
  float band = dir.y * 6.0 + fbm(vec3(dir.x, dir.y * 3.0, dir.z) * 1.8) * 0.3;
  albedo = mix(vec3(0.8, 0.7, 0.48), vec3(0.94, 0.88, 0.7), 0.5 + 0.5 * sin(band * 6.2831853));
  albedo = mix(albedo, vec3(0.68, 0.6, 0.45), smoothstep(0.75, 0.95, abs(dir.y)) * 0.4);
  emissive = vec3(0.0);
  specMask = 0.0;
  rimColor = vec3(0.95, 0.88, 0.68);
  rimStrength = 0.3;
}
`,
  // 天王星: ほぼ一様な青緑（軸傾き98°が主役）
  uranus: /* glsl */ `
void surface(vec3 dir, out vec3 albedo, out vec3 emissive, out float specMask,
             out vec3 rimColor, out float rimStrength) {
  albedo = vec3(0.55, 0.78, 0.83) * (0.95 + 0.05 * sin(dir.y * 14.0 + fbm(dir * 2.0) * 2.0));
  emissive = vec3(0.0);
  specMask = 0.0;
  rimColor = vec3(0.5, 0.85, 0.95);
  rimStrength = 0.6;
}
`,
  // 海王星: 群青の縞 + 暗斑 + 巻雲のストリーク
  neptune: /* glsl */ `
void surface(vec3 dir, out vec3 albedo, out vec3 emissive, out float specMask,
             out vec3 rimColor, out float rimStrength) {
  float band = sin(dir.y * 9.0 + fbm(dir * 2.4 + vec3(uTime * 0.02)) * 1.5);
  albedo = mix(vec3(0.12, 0.24, 0.6), vec3(0.3, 0.45, 0.85), 0.5 + 0.28 * band);
  vec3 spot = normalize(vec3(-0.5, 0.25, 0.83));
  float ds = distance(dir * vec3(1.0, 1.6, 1.0), spot * vec3(1.0, 1.6, 1.0));
  albedo = mix(albedo, vec3(0.07, 0.12, 0.38), smoothstep(0.3, 0.1, ds) * 0.8);
  albedo += vec3(0.55) * smoothstep(0.14, 0.05, abs(ds - 0.22)) * 0.22;
  emissive = vec3(0.0);
  specMask = 0.0;
  rimColor = vec3(0.4, 0.6, 1.0);
  rimStrength = 0.7;
}
`,
  // 月: 水星と同じクレーター機構の色違い
  moon: /* glsl */ `
float craters(vec3 dir, float s) {
  vec3 p = dir * s;
  vec3 cell = floor(p);
  vec3 h = hash33(cell) * 0.5 + 0.5;
  vec3 center = cell + 0.3 + h * 0.4;
  float r = 0.08 + h.y * 0.1;
  float q = length(p - center);
  float rim = smoothstep(r * 1.4, r, q) - smoothstep(r * 0.9, r * 0.4, q) * 1.5;
  return rim * step(h.z, 0.6);
}

void surface(vec3 dir, out vec3 albedo, out vec3 emissive, out float specMask,
             out vec3 rimColor, out float rimStrength) {
  vec3 tang = normalize(uSunDirObj - dir * dot(uSunDirObj, dir) + vec3(1e-4));
  vec3 dir2 = normalize(dir + tang * 0.025);
  float hc = craters(dir, 7.0) + craters(dir, 16.0) * 0.6;
  float hs = craters(dir2, 7.0) + craters(dir2, 16.0) * 0.6;
  // 海（暗い玄武岩の平原）
  float mare = smoothstep(0.1, 0.4, fbm(dir * 1.9 + 5.0));
  albedo = mix(vec3(0.62, 0.62, 0.6), vec3(0.3, 0.3, 0.32), mare) + vec3((hc - hs) * 1.5 * 0.4);
  emissive = vec3(0.0);
  specMask = 0.0;
  rimColor = vec3(0.3, 0.3, 0.3);
  rimStrength = 0.08;
}
`,
}

/** 惑星シェーダを組み立てる。共通ライティング + 惑星別 surface。 */
export function buildPlanetShader(body: PlanetId | 'moon', octaves: number): string {
  return /* glsl */ `
precision highp float;
varying vec3 vObj;

uniform vec3 uSunDirObj;   // 太陽の方向（object 空間・単位ベクトル）
uniform vec3 uCamPosObj;   // カメラ位置（object 空間）
uniform float uTime;

${commonChunk(octaves)}
${SURFACES[body]}

void main() {
  vec3 dir = normalize(vObj);
  vec3 albedo;
  vec3 emissive;
  float specMask;
  vec3 rimColor;
  float rimStrength;
  surface(dir, albedo, emissive, specMask, rimColor, rimStrength);

  float d = dot(dir, uSunDirObj);
  float day = smoothstep(-0.12, 0.25, d);
  vec3 lit = albedo * (max(d, 0.0) * 1.05 + 0.05);
  // 夜側は青黒くシルエットだけ残す
  vec3 night = albedo * 0.035 * vec3(0.55, 0.65, 1.0);
  vec3 col = mix(night, lit, day) + emissive * (1.0 - day);

  vec3 view = normalize(uCamPosObj - vObj);
  // 海の太陽ギラリ（specMask を持つ惑星のみ）
  float spec = pow(max(dot(reflect(-uSunDirObj, dir), view), 0.0), 60.0);
  col += vec3(1.0, 0.95, 0.85) * spec * specMask * day;
  // 大気の縁
  float rim = pow(1.0 - max(dot(dir, view), 0.0), 3.0);
  col += rimColor * rim * rimStrength * (0.25 + 0.75 * day);

  gl_FragColor = vec4(col, 1.0);
}
`
}

/** 太陽。粒状斑が流れ、HDR 輝度でブルームが光冠を作る。 */
export function buildSunShader(octaves: number): string {
  return /* glsl */ `
precision highp float;
varying vec3 vObj;

uniform vec3 uCamPosObj;
uniform float uTime;

${commonChunk(octaves)}

void main() {
  vec3 dir = normalize(vObj);
  float g = fbm(dir * 7.0 + vec3(uTime * 0.1, uTime * 0.07, 0.0));
  vec3 col = mix(vec3(1.0, 0.42, 0.08), vec3(1.0, 0.9, 0.58), 0.5 + 0.5 * g) * 4.5;
  vec3 view = normalize(uCamPosObj - vObj);
  col *= 0.55 + 0.45 * pow(max(dot(dir, view), 0.0), 0.6); // 縁の減光
  gl_FragColor = vec4(col, 1.0);
}
`
}

/** カメラ正対のビルボードグロー（太陽・彗星のコマ）。 */
export const GLOW_VERT = /* glsl */ `
uniform float uSize;
varying vec2 vQuad;

void main() {
  vQuad = position.xy;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}
`

export const GLOW_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vQuad;

void main() {
  float r = length(vQuad) * 2.0;
  gl_FragColor = vec4(uColor * exp(-r * 3.2) * uIntensity, 1.0);
}
`

/**
 * 土星の輪。半径方向のノイズの筋 + カッシーニの間隙 + 本体が落とす影。
 * ローカル座標系（惑星半径=1、輪面=XZ）で計算する。
 */
export function buildRingShader(octaves: number): string {
  return /* glsl */ `
precision highp float;
varying vec3 vObj;

uniform vec3 uSunDirObj;

${commonChunk(octaves)}

#define R_IN 1.24
#define R_OUT 2.3

void main() {
  float r = length(vObj.xz);
  float tR = (r - R_IN) / (R_OUT - R_IN);
  if (tR < 0.0 || tR > 1.0) discard;

  // 半径方向の筋
  float streak = 0.5 + 0.5 * snoise(vec3(tR * 36.0, 0.7, 1.3));
  float fine = 0.7 + 0.3 * snoise(vec3(tR * 110.0, 4.2, 8.8));
  float alpha = (0.22 + 0.78 * streak) * fine;
  // カッシーニの間隙とエンケの空隙
  alpha *= mix(1.0, 0.1, smoothstep(0.06, 0.015, abs(tR - 0.55)));
  alpha *= mix(1.0, 0.35, smoothstep(0.02, 0.005, abs(tR - 0.86)));
  alpha *= smoothstep(0.0, 0.06, tR) * smoothstep(1.0, 0.9, tR);

  // 本体の影: 反太陽側で、太陽方向の軸からの距離が本体半径未満なら影
  float tp = dot(vObj, uSunDirObj);
  float perp = length(vObj - uSunDirObj * tp);
  float shadow = tp < 0.0 ? smoothstep(0.9, 1.12, perp) : 1.0;

  float lit = 0.3 + 0.7 * abs(uSunDirObj.y);
  vec3 col = vec3(0.89, 0.8, 0.6) * alpha * (0.2 + 0.9 * shadow * lit);
  gl_FragColor = vec4(col, 1.0);
}
`
}

/** 小惑星帯。軌道要素を attribute に焼き、頂点シェーダ内でケプラー運動を解く。 */
export const BELT_VERT = /* glsl */ `
attribute vec4 aEls;    // (a[AU], e, M0, n[rad/日])
attribute vec4 aAxes1;  // (近日点方向 P̂, size)
attribute vec4 aAxes2;  // (Q̂, colorSeed)

uniform float uDays;
uniform float uPixelRatio;

varying vec3 vColor;

void main() {
  float e = aEls.y;
  float M = mod(aEls.z + aEls.w * uDays, 6.2831853);
  // e ≤ 0.15 なので級数2項で十分（誤差 ~3e-3 rad、視認不能）
  float E = M + e * sin(M) + 0.5 * e * e * sin(2.0 * M);
  float ce = cos(E);
  float se = sin(E);
  float r = aEls.x * (1.0 - e * ce);
  float cv = (ce - e) / (1.0 - e * ce);
  float sv = sqrt(1.0 - e * e) * se / (1.0 - e * ce);
  vec3 posAU = r * (cv * aAxes1.xyz + sv * aAxes2.xyz);
  // 惑星と同じ動径圧縮
  vec3 pos = posAU * (9.0 * pow(r, 0.45) / r);

  vColor = mix(vec3(0.4, 0.37, 0.34), vec3(0.5, 0.4, 0.3), aAxes2.w) * 0.38;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = aAxes1.w * uPixelRatio * clamp(30.0 / -mv.z, 0.4, 2.0);
  gl_Position = projectionMatrix * mv;
}
`

export const BELT_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;

void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d2 = dot(q, q);
  if (d2 > 0.25) discard;
  gl_FragColor = vec4(vColor * smoothstep(0.25, 0.05, d2), 1.0);
}
`

/**
 * 彗星の尾。全粒の形状が uniform 駆動の解析形なので CPU 更新ゼロ。
 * イオンテイル（uCurve=0、反太陽の直線）とダストテイル（uCurve>0、
 * 軌道速度の逆方向へ曲がる）を同じシェーダのパラメータ違いで描く。
 */
export const COMET_TAIL_VERT = /* glsl */ `
attribute vec4 aRand;  // (t=0..1, ゲート, 散らし1, 散らし2)

uniform vec3 uCometPos;
uniform vec3 uAntiSun;
uniform vec3 uVelDir;
uniform float uActivity;
uniform float uTime;
uniform float uCurve;
uniform float uLenBase;
uniform float uLenGain;
uniform float uSpread;
uniform float uPixelRatio;

varying float vFade;

void main() {
  float t = aRand.x;
  // 活動度が低いほど粒を間引く（近日点で尾が濃く長くなる）
  float alive = step(aRand.y, uActivity * 1.3);
  vec3 dir = normalize(uAntiSun + uCurve * t * (-uVelDir) + vec3(1e-5));
  vec3 side1 = normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
  vec3 side2 = cross(dir, side1);
  float wob = 0.7 + 0.3 * sin(uTime * 3.0 + aRand.z * 40.0);
  vec3 offset = (side1 * (aRand.z - 0.5) + side2 * (aRand.w - 0.5)) * uSpread * (0.2 + t) * wob;
  float len = uLenBase + uLenGain * uActivity;
  vec3 pos = uCometPos + dir * (t * t * len) + offset;

  vFade = (1.0 - t) * alive * min(uActivity * 1.6, 1.2);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = (1.2 + 2.6 * (1.0 - t)) * uPixelRatio * clamp(26.0 / -mv.z, 0.3, 2.2) * alive;
  gl_Position = projectionMatrix * mv;
}
`

export const COMET_TAIL_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
varying float vFade;

void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d2 = dot(q, q);
  if (d2 > 0.25) discard;
  gl_FragColor = vec4(uColor * vFade * smoothstep(0.25, 0.03, d2), 1.0);
}
`

/** 星空球（BackSide）。セルごとの hash で星を撒く手続き星空。輝度は 1 未満に抑える。 */
export const STARS_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const STARS_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;

${GLSL_NOISE}

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

void main() {
  vec3 dir = normalize(vDir);
  float band = exp(-pow(dot(dir, vec3(0.5257, 0.7896, 0.3158)), 2.0) * 18.0);
  vec3 c = vec3(0.05, 0.06, 0.09) * band * max(0.5 + 0.5 * snoise(dir * 3.7), 0.0);
  c += starLayer(dir, 60.0, 0.09, 30.0, 0.85);
  c += starLayer(dir, 130.0, 0.1, 12.0, 0.3);
  gl_FragColor = vec4(c, 1.0);
}
`

/** 軌道線。惑星のアクセント色を極薄く。 */
export const ORBIT_VERT = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const ORBIT_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uTint;

void main() {
  gl_FragColor = vec4(uTint, 1.0);
}
`

/** しきい値より明るい成分だけを取り出す（ソフトニー）。 */
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
  c *= 1.0 - 0.25 * dot(q, q);

  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  c += (dither - 0.5) / 255.0;

  gl_FragColor = vec4(c, 1.0);
}
`
