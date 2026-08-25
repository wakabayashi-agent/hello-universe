/**
 * 粘菌（Physarum, Jeff Jones 2010）シミュレーションのシェーダ群。
 *
 * 1フレームの流れ：
 *   splat（マウスの餌・忌避をトレイル場へ注入）
 *   → agent（3点センシング → 旋回 → 前進）
 *   → diffuse（拡散 + 蒸発）
 *   → deposit（エージェント位置へ点描でフェロモンを加算）
 *   → display
 *
 * エージェント状態は Float テクスチャ（rg = 位置 UV, b = 向き, a = 種族）、
 * トレイル場は half float（r = 種族A, g = 種族B, b = 餌。負の餌 = 忌避）。
 * ループを持つシェーダが無いので #define ビルダーは不要。
 */

const HEADER = /* glsl */ `
precision highp float;
varying vec2 vUv;
`

/**
 * エージェント更新。トレイル場を前方・左前・右前の3点でセンシングし、
 * フェロモンの濃い方へ旋回して1歩進む。
 *
 * 向きの角度はスクリーン座標系（uTexel が画面アスペクトに合っているので、
 * どの向きでも画面上で等速に進む）。画面端はトーラス状にラップする。
 * 壁で跳ね返す方式だと壁沿いにエージェントが溜まって額縁模様が出る。
 */
export const AGENT_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D uAgents;
uniform sampler2D uTrail;
uniform vec2 uTexel;        // トレイル場の1テクセル
uniform float uDtScale;     // 1/60s を1とするフレーム時間
uniform float uTime;
uniform float uAspect;
uniform float uSensorAngle;
uniform float uSensorDist;  // トレイル場ピクセル単位
uniform float uTurnAngle;
uniform float uSpeed;       // トレイル場ピクセル / ステップ
uniform float uJitter;
uniform float uAvoid;       // 他種族のフェロモンをどれだけ嫌うか
uniform float uFoodWeight;  // 餌が自トレイルの何倍魅力的か
uniform vec4 uMouse;        // xy = 位置(UV), z = 半径(UV), w = 散乱の強さ 0..1

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// own/other は種族マスク。餌チャンネルが負ならこの式が自動的に忌避になる。
// 自トレイルの感度は飽和させる。飽和が無いと「濃い幹ほど無限に有利」になり、
// 網全体が数本のメガトレイルに合流して崩壊する
float sense(vec2 pos, float ang, vec2 own, vec2 other) {
  vec2 p = fract(pos + vec2(cos(ang), sin(ang)) * uSensorDist * uTexel);
  vec4 t = texture2D(uTrail, p);
  return dot(min(t.rg, 1.6), own) - uAvoid * dot(t.rg, other) + uFoodWeight * t.b;
}

void main() {
  vec4 a = texture2D(uAgents, vUv);
  vec2 pos = a.xy;
  float ang = a.z;
  float species = a.w;
  vec2 own = mix(vec2(1.0, 0.0), vec2(0.0, 1.0), species);
  vec2 other = vec2(own.y, own.x);

  float F = sense(pos, ang, own, other);
  float L = sense(pos, ang + uSensorAngle, own, other);
  float R = sense(pos, ang - uSensorAngle, own, other);

  if (F >= L && F >= R) {
    // 前が一番濃ければ直進
  } else if (L > R) {
    ang += uTurnAngle;
  } else if (R > L) {
    ang -= uTurnAngle;
  } else {
    ang += (hash21(vUv * 811.13 + fract(uTime * 0.731)) - 0.5) * 2.0 * uTurnAngle;
  }
  // 常時のゆらぎ。これが無いと格子方向にロックして網が凍る
  ang += (hash21(vUv * 419.71 + fract(uTime * 1.313)) - 0.5) * uJitter;

  // クリック中はカーソルから外向きへ弾き飛ばす（散乱）
  vec2 dm = vec2((pos.x - uMouse.x) * uAspect, pos.y - uMouse.y);
  float md = length(dm);
  if (uMouse.w > 0.001 && md < uMouse.z) {
    float k = clamp(uMouse.w * (1.0 - md / uMouse.z) * 1.6, 0.0, 1.0);
    vec2 away = dm / max(md, 1e-4);
    vec2 dir = mix(vec2(cos(ang), sin(ang)), away, k) + vec2(1e-5, 0.0);
    ang = atan(dir.y, dir.x);
    pos += away * uTexel * uSpeed * 3.0 * k;
  }

  pos = fract(pos + vec2(cos(ang), sin(ang)) * (uSpeed * uDtScale) * uTexel);
  gl_FragColor = vec4(pos, ang, species);
}
`

/** 堆積：エージェント位置に1テクセルの点を加算合成で打つ。 */
export const DEPOSIT_VERT = /* glsl */ `
precision highp float;
attribute vec2 aRef;

uniform sampler2D uAgents;

varying float vSpecies;

void main() {
  vec4 a = texture2D(uAgents, aRef);
  vSpecies = a.w;
  gl_Position = vec4(a.xy * 2.0 - 1.0, 0.0, 1.0);
  // レンダーターゲット直描きなので pixelRatio は掛けない
  gl_PointSize = 1.0;
}
`

export const DEPOSIT_FRAG = /* glsl */ `
precision highp float;
uniform float uDeposit;
varying float vSpecies;

void main() {
  // three.js の AdditiveBlending は src 係数が SrcAlpha なので、
  // alpha を 0 にすると寄与が全部消える。必ず 1.0 にする
  gl_FragColor = vec4(uDeposit * (1.0 - vSpecies), uDeposit * vSpecies, 0.0, 1.0);
}
`

/**
 * 拡散と蒸発を1パスで。3x3 平均へのブレンドが拡散、uDecay 倍が蒸発。
 * half float の場は毎フレーム必ず減衰させる（積み上がると Inf → NaN）。
 * uDecay は CPU 側でフレーム時間補正（pow(基準, dt*60)）済みの値。
 */
export const DIFFUSE_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D uTrail;
uniform vec2 uTexel;
uniform vec3 uDecay;    // rg = フェロモン蒸発, b = 餌の蒸発（遅め）
uniform float uDiffuse;

void main() {
  vec4 c = texture2D(uTrail, vUv);
  vec4 sum = vec4(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      sum += texture2D(uTrail, vUv + vec2(float(dx), float(dy)) * uTexel);
    }
  }
  vec3 t = mix(c, sum / 9.0, uDiffuse).rgb * uDecay;
  // 消えきらない微小値が薄く残り続けないよう底を切る
  t.rg = max(t.rg - 0.0005, 0.0);
  // 餌は毎フレームのスプラットで際限なく積もる。放置しておくと
  // クリックをやめても数十秒引きずるので、蓄積に上限を切る
  t.b = clamp(t.b, -2.5, 4.0);
  gl_FragColor = vec4(t, 1.0);
}
`

/** カーソル位置にガウス分布で餌（b チャンネル）を足し込む。fluid と同型。 */
export const SPLAT_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D uTarget;
uniform float uAspect;
uniform vec3 uColor;
uniform vec2 uPoint;
uniform float uRadius;

void main() {
  vec2 p = vUv - uPoint;
  p.x *= uAspect;
  vec3 splat = exp(-dot(p, p) / uRadius) * uColor;
  gl_FragColor = vec4(texture2D(uTarget, vUv).rgb + splat, 1.0);
}
`

/**
 * 表示。2種族を2色で塗り分け、密度勾配の擬似ライティングで
 * 平面的な塗りを「厚みのある管」に見せる（fluid と同じ手筋）。
 */
export const DISPLAY_FRAG = /* glsl */ `
${HEADER}
uniform sampler2D uTrail;
uniform vec2 uTexel;
uniform vec3 uColorA;
uniform vec3 uColorB;

void main() {
  vec4 t = texture2D(uTrail, vUv);
  // フィルミックに圧縮。幹の HDR 値(3〜8)が白飛びせずに艶になる
  float la = 1.0 - exp(-t.r * 0.45);
  float lb = 1.0 - exp(-t.g * 0.45);
  vec3 c = uColorA * la + uColorB * lb;

  float sL = dot(texture2D(uTrail, vUv - vec2(uTexel.x, 0.0)).rg, vec2(1.0));
  float sR = dot(texture2D(uTrail, vUv + vec2(uTexel.x, 0.0)).rg, vec2(1.0));
  float sB = dot(texture2D(uTrail, vUv - vec2(0.0, uTexel.y)).rg, vec2(1.0));
  float sT = dot(texture2D(uTrail, vUv + vec2(0.0, uTexel.y)).rg, vec2(1.0));
  vec3 normal = normalize(vec3(sR - sL, sT - sB, 0.35));
  float light = clamp(dot(normal, normalize(vec3(-0.45, 0.65, 0.6))), 0.0, 1.0);
  // 陰影は足す方向だけ。掛けて暗くすると画面全体が沈む
  c *= 1.0 + 0.6 * light;

  // 餌（マウスの軌跡）は暖色の光としてうっすら見せる
  c += vec3(1.0, 0.88, 0.6) * (1.0 - exp(-max(t.b, 0.0) * 0.8)) * 0.28;

  // 背景を完全な黒にしない
  c += vec3(0.010, 0.014, 0.022);
  gl_FragColor = vec4(pow(c, vec3(0.85)), 1.0);
}
`
