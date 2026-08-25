/**
 * マンデルブロ／ジュリア集合。
 *
 * 深く拡大すると float32（有効数字7桁）では座標が足りず、画面がブロック状に崩れる。
 * よくある対策は float 2つで倍精度を模す double-single だが、
 * これは「桁落ちで消える下位ビットを拾い直す」式に依存しているため、
 * 最適化で式を組み替えるシェーダコンパイラ（WebKit/Metal など）では成立しない。
 *
 * そこで摂動法を使う。
 *   画面中心 C の軌道 Z_n = Z_{n-1}^2 + C は JS の倍精度で計算しておく。
 *   各ピクセルは中心からのずれ dc だけを持ち、差分 dz を単精度で追う：
 *     dz_{n+1} = 2 Z_n dz_n + dz_n^2 + dc
 *   dc も dz も「小さい数」なので、単精度の相対精度がそのまま効く。
 *   誤差補償のトリックが不要なので、どのコンパイラでも壊れない。
 */
export const ORBIT_TEXTURE_WIDTH = 2048

export function buildFractalShader(maxIterations: number): string {
  return /* glsl */ `
precision highp float;
varying vec2 vUv;

#define MAX_ITER ${maxIterations}
#define ORBIT_W ${ORBIT_TEXTURE_WIDTH}.0

uniform sampler2D uOrbit;    // 参照軌道 Z_n（xy に実部・虚部）
uniform int uOrbitLength;
uniform vec2 uRefOffset;     // 参照点の位置（画面中心からのずれ）
uniform float uSpan;         // 画面の高さが複素平面で何単位ぶんか
uniform float uAspect;
uniform int uIterations;
uniform bool uJulia;
uniform vec2 uJuliaC;
uniform float uPaletteShift;

vec2 orbitAt(int n) {
  return texture2D(uOrbit, vec2((float(n) + 0.5) / ORBIT_W, 0.5)).xy;
}

// Inigo Quilez のコサインパレット。
// 位相をずらして t=0 が深い青、進むほど金色になるようにしてある
vec3 palette(float t) {
  vec3 a = vec3(0.50, 0.44, 0.42);
  vec3 b = vec3(0.48, 0.44, 0.44);
  vec3 c = vec3(1.00, 1.00, 1.00);
  vec3 d = vec3(0.50, 0.60, 0.74);
  return a + b * cos(6.28318530718 * (c * t + d));
}

void main() {
  vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);
  // 参照点からのずれ。参照点は必ずしも画面中心ではない（軌道が長く続く点を選ぶ）
  vec2 dc = uv * uSpan - uRefOffset;

  float iter = 0.0;
  float m2 = 0.0;
  bool escaped = false;

  if (uJulia) {
    // ジュリア集合は c が定数で z が画面座標。値が O(1) なので素直に単精度で解く
    vec2 z = uv * uSpan;
    for (int i = 0; i < MAX_ITER; i++) {
      if (i >= uIterations) break;
      float zr2 = z.x * z.x;
      float zi2 = z.y * z.y;
      m2 = zr2 + zi2;
      if (m2 > 256.0) { escaped = true; break; }
      z = vec2(zr2 - zi2 + uJuliaC.x, 2.0 * z.x * z.y + uJuliaC.y);
      iter += 1.0;
    }
  } else {
    vec2 dz = vec2(0.0);
    vec2 Z = vec2(0.0);          // Z_0 = 0
    int n = 0;

    for (int i = 0; i < MAX_ITER; i++) {
      if (i >= uIterations) break;

      // dz_{n+1} = 2 Z_n dz_n + dz_n^2 + dc
      dz = vec2(
        2.0 * (Z.x * dz.x - Z.y * dz.y) + (dz.x * dz.x - dz.y * dz.y),
        2.0 * (Z.x * dz.y + Z.y * dz.x) + 2.0 * dz.x * dz.y
      ) + dc;
      n += 1;
      iter += 1.0;

      Z = orbitAt(n);
      vec2 z = Z + dz;
      m2 = dot(z, z);
      if (m2 > 256.0) { escaped = true; break; }

      // リベース（Zhuoran 法）。
      // 参照軌道から離れすぎたり軌道を使い切ったら、今の点を新しい出発点にする。
      // Z_0 = 0 なので dz = z, n = 0 と置き直すだけで整合する
      if (m2 < dot(dz, dz) || n >= uOrbitLength - 1) {
        dz = z;
        Z = vec2(0.0);
        n = 0;
      }
    }
  }

  if (!escaped) {
    // 集合の内側。真っ黒にせず、ごくわずかに青を残す
    gl_FragColor = vec4(0.015, 0.017, 0.032, 1.0);
    return;
  }

  // 反復回数を連続値に均す（そのままだと等高線のような縞が出る）
  float smoothIter = iter - log2(max(log2(m2) * 0.5, 1e-6));
  // sqrt をかますと浅いところは粗く深いところは細かく縞が入り、
  // どの倍率でも情報量が同じくらいに見える
  float t = sqrt(max(smoothIter, 0.0)) * 0.155 + uPaletteShift;
  vec3 color = palette(t);

  // 集合から遠い（すぐ発散する）領域は落ち着かせて、境界付近を目立たせる
  color *= 0.35 + 0.65 * smoothstep(0.0, 14.0, smoothIter);

  gl_FragColor = vec4(color, 1.0);
}
`
}
