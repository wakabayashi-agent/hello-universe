import * as THREE from 'three'

/**
 * 太陽系の軌道力学。
 *
 * 惑星は JPL の近似軌道要素表（Standish, 1800–2050AD 有効）の
 * J2000 平均要素+世紀あたりの変化率をそのまま埋め込み、
 * ケプラー方程式をニュートン法で解いて位置を出す。
 *
 * 距離は r_vis = 9.0 · r_AU^0.45 の動径圧縮（方向は保存）。
 * 楕円は閉曲線のまま、軌道線と惑星位置が厳密に一致する。
 * 惑星半径は別スケール（√系）で、見た目の比較ができる大きさにする。
 */

export type PlanetId =
  | 'mercury'
  | 'venus'
  | 'earth'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune'

export interface PlanetDef {
  id: PlanetId
  /** 表示名（日本語） */
  name: string
  /** 軌道要素 [J2000値, 世紀あたりの変化率] */
  a: [number, number] // AU
  e: [number, number]
  i: [number, number] // deg
  L: [number, number] // 平均黄経 deg
  varpi: [number, number] // 近日点黄経 deg
  Omega: [number, number] // 昇交点黄経 deg
  /** 可視半径（シーン単位） */
  radius: number
  /** 見た目の自転周期（秒/周。負は逆行） */
  spinPeriod: number
  /** 自転軸の傾き(deg) */
  tilt: number
  /** ラベルと軌道線のアクセント色 */
  accent: string
}

/** JPL 近似表の値。列: [J2000, 変化率/世紀] */
export const PLANETS: PlanetDef[] = [
  {
    id: 'mercury', name: '水星',
    a: [0.38709927, 0.00000037], e: [0.20563593, 0.00001906],
    i: [7.00497902, -0.00594749], L: [252.2503235, 149472.67411175],
    varpi: [77.45779628, 0.16047689], Omega: [48.33076593, -0.12534081],
    radius: 0.21, spinPeriod: 170, tilt: 0.03, accent: '#b8b0a8',
  },
  {
    id: 'venus', name: '金星',
    a: [0.72333566, 0.0000039], e: [0.00677672, -0.00004107],
    i: [3.39467605, -0.0007889], L: [181.9790995, 58517.81538729],
    varpi: [131.60246718, 0.00268329], Omega: [76.67984255, -0.27769418],
    radius: 0.33, spinPeriod: -260, tilt: 2.6, accent: '#e8d3a2',
  },
  {
    id: 'earth', name: '地球',
    a: [1.00000261, 0.00000562], e: [0.01671123, -0.00004392],
    i: [-0.00001531, -0.01294668], L: [100.46457166, 35999.37244981],
    varpi: [102.93768193, 0.32327364], Omega: [0, 0],
    radius: 0.34, spinPeriod: 55, tilt: 23.4, accent: '#6fa8ff',
  },
  {
    id: 'mars', name: '火星',
    a: [1.52371034, 0.00001847], e: [0.0933941, 0.00007882],
    i: [1.84969142, -0.00813131], L: [-4.55343205, 19140.30268499],
    varpi: [-23.94362959, 0.44441088], Omega: [49.55953891, -0.29257343],
    radius: 0.25, spinPeriod: 58, tilt: 25.2, accent: '#ff8a5f',
  },
  {
    id: 'jupiter', name: '木星',
    a: [5.202887, -0.00011607], e: [0.04838624, -0.00013253],
    i: [1.30439695, -0.00183714], L: [34.39644051, 3034.74612775],
    varpi: [14.72847983, 0.21252668], Omega: [100.47390909, 0.20469106],
    radius: 1.13, spinPeriod: 22, tilt: 3.1, accent: '#e3b98a',
  },
  {
    id: 'saturn', name: '土星',
    a: [9.53667594, -0.0012506], e: [0.05386179, -0.00050991],
    i: [2.48599187, 0.00193609], L: [49.95424423, 1222.49362201],
    varpi: [92.59887831, -0.41897216], Omega: [113.66242448, -0.28867794],
    radius: 1.03, spinPeriod: 26, tilt: 26.7, accent: '#e8d59f',
  },
  {
    id: 'uranus', name: '天王星',
    a: [19.18916464, -0.00196176], e: [0.04725744, -0.00004397],
    i: [0.77263783, -0.00242939], L: [313.23810451, 428.48202785],
    varpi: [170.9542763, 0.40805281], Omega: [74.01692503, 0.04240589],
    radius: 0.68, spinPeriod: -42, tilt: 97.8, accent: '#9fe0e8',
  },
  {
    id: 'neptune', name: '海王星',
    a: [30.06992276, 0.00026291], e: [0.00859048, 0.00005105],
    i: [1.77004347, 0.00035372], L: [-55.12002969, 218.45945325],
    varpi: [44.96476227, -0.32241464], Omega: [131.78422574, -0.00508664],
    radius: 0.67, spinPeriod: 38, tilt: 28.3, accent: '#7db8ff',
  },
]

/** 太陽の可視半径（実比だと画面が太陽だけになるのでキャップ） */
export const SUN_RADIUS = 2.2
/** 月: 地球周りの簡易円軌道。距離は見えるよう誇張 */
export const MOON = { radius: 0.115, orbitRadius: 0.9, periodDays: 27.322 }

export interface CometDef {
  name: string
  a: number
  e: number
  i: number // deg
  Omega: number
  omega: number // 近日点引数
  /** デモ開始時点の平均近点角(deg)。負 = 近日点の手前 */
  m0: number
}

/**
 * 架空の彗星。m0 は「デモ開始からおよそ何日で近日点に来るか」から逆算した値
 * （B が開始すぐ、A が1〜2分後、C は high ティアのみでゆっくり）。
 * J2000 ではなく「今日」を基準にするため、開始日アンカーからの経過で解く。
 */
export const COMETS: CometDef[] = [
  { name: '彗星A', a: 8.0, e: 0.85, i: 16, Omega: 60, omega: 105, m0: -104 },
  { name: '彗星B', a: 5.5, e: 0.8, i: -24, Omega: 200, omega: 40, m0: -22 },
  { name: '彗星C', a: 11.5, e: 0.92, i: 42, Omega: 310, omega: 250, m0: -155 },
]

/** デモ開始時点の J2000 経過日数（モジュール読み込み時に確定） */
export const EPOCH_DAYS = Date.now() / 86400000 - 10957.5

const DEG = Math.PI / 180
/** ガウス引力定数 k: 平均運動 n = k / a^1.5 [rad/日] */
export const GAUSS_K = 0.01720209895

/** ケプラー方程式 M = E − e·sinE をニュートン法で解く。 */
export function solveKepler(M: number, e: number): number {
  let E = e < 0.8 ? M : Math.PI
  for (let iter = 0; iter < 12; iter++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
    E -= d
    if (Math.abs(d) < 1e-9) break
  }
  return E
}

/** 軌道面座標 (x', y') と軌道要素 → 黄道座標(three.js の並び: Y=北)。 */
function perifocalToScene(
  xp: number,
  yp: number,
  omega: number,
  Omega: number,
  inc: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const co = Math.cos(omega)
  const so = Math.sin(omega)
  const cO = Math.cos(Omega)
  const sO = Math.sin(Omega)
  const ci = Math.cos(inc)
  const si = Math.sin(inc)
  const xe = (co * cO - so * sO * ci) * xp + (-so * cO - co * sO * ci) * yp
  const ye = (co * sO + so * cO * ci) * xp + (-so * sO + co * cO * ci) * yp
  const ze = so * si * xp + co * si * yp
  // 黄道面を XZ 平面に、黄道の北を +Y に
  return out.set(xe, ze, -ye)
}

export interface BodyState {
  /** 黄道座標(AU)。three.js の軸並び */
  posAU: THREE.Vector3
  rAU: number
}

/** 惑星の位置。simDays は J2000 からの経過日数。 */
export function planetState(def: PlanetDef, simDays: number, out: BodyState): BodyState {
  const T = simDays / 36525
  const a = def.a[0] + def.a[1] * T
  const e = def.e[0] + def.e[1] * T
  const inc = (def.i[0] + def.i[1] * T) * DEG
  const L = (def.L[0] + def.L[1] * T) * DEG
  const varpi = (def.varpi[0] + def.varpi[1] * T) * DEG
  const Omega = (def.Omega[0] + def.Omega[1] * T) * DEG
  const omega = varpi - Omega
  const M = wrapAngle(L - varpi)
  const E = solveKepler(M, e)
  const xp = a * (Math.cos(E) - e)
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E)
  perifocalToScene(xp, yp, omega, Omega, inc, out.posAU)
  out.rAU = out.posAU.length()
  return out
}

/** 彗星の位置。m0 はデモ開始時点の位相なので、開始日からの経過で解く。 */
export function cometState(def: CometDef, simDays: number, out: BodyState): BodyState {
  const n = GAUSS_K / Math.pow(def.a, 1.5)
  const M = wrapAngle(def.m0 * DEG + n * (simDays - EPOCH_DAYS))
  const E = solveKepler(M, def.e)
  const xp = def.a * (Math.cos(E) - def.e)
  const yp = def.a * Math.sqrt(1 - def.e * def.e) * Math.sin(E)
  perifocalToScene(xp, yp, def.omega * DEG, def.Omega * DEG, def.i * DEG, out.posAU)
  out.rAU = out.posAU.length()
  return out
}

function wrapAngle(rad: number): number {
  const twoPi = Math.PI * 2
  return ((rad % twoPi) + twoPi) % twoPi
}

/** 距離の動径圧縮。方向は保存するので楕円は閉曲線のまま。 */
export const VIS_K = 9.0
export const VIS_POW = 0.45

export function toVisual(posAU: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const r = posAU.length()
  if (r < 1e-9) return out.set(0, 0, 0)
  const scale = (VIS_K * Math.pow(r, VIS_POW)) / r
  return out.copy(posAU).multiplyScalar(scale)
}

/**
 * 軌道線の点列（可視座標）。離心近点角 E を等分割すると
 * 近日点付近が自然に密になり、圧縮後も滑らか。
 */
export function orbitLinePoints(
  def: PlanetDef | CometDef,
  simDays: number,
  segments: number,
): Float32Array {
  const isPlanet = 'varpi' in def
  const T = simDays / 36525
  const a = isPlanet ? def.a[0] + def.a[1] * T : def.a
  const e = isPlanet ? def.e[0] + def.e[1] * T : def.e
  const inc = (isPlanet ? def.i[0] + def.i[1] * T : def.i) * DEG
  const Omega = (isPlanet ? def.Omega[0] + def.Omega[1] * T : def.Omega) * DEG
  const omega = isPlanet
    ? (def.varpi[0] + def.varpi[1] * T) * DEG - Omega
    : def.omega * DEG

  const out = new Float32Array(segments * 3)
  const p = new THREE.Vector3()
  const v = new THREE.Vector3()
  for (let s = 0; s < segments; s++) {
    const E = (s / segments) * Math.PI * 2
    const xp = a * (Math.cos(E) - e)
    const yp = a * Math.sqrt(1 - e * e) * Math.sin(E)
    perifocalToScene(xp, yp, omega, Omega, inc, p)
    toVisual(p, v)
    out.set([v.x, v.y, v.z], s * 3)
  }
  return out
}

/**
 * 小惑星帯の attribute 群。軌道要素を頂点に焼き、位置は頂点シェーダで解く。
 * カークウッドの空隙（2.50 / 2.82 / 2.95 / 3.27 AU）をガウス棄却で入れる。
 */
export function buildBeltAttributes(count: number): {
  els: Float32Array // (a, e, M0, n)
  axes1: Float32Array // (Px, Py, Pz, size)
  axes2: Float32Array // (Qx, Qy, Qz, colorSeed)
} {
  const els = new Float32Array(count * 4)
  const axes1 = new Float32Array(count * 4)
  const axes2 = new Float32Array(count * 4)
  const GAPS = [2.5, 2.82, 2.95, 3.27]
  const P = new THREE.Vector3()
  const Q = new THREE.Vector3()

  for (let i = 0; i < count; i++) {
    // 空隙を避けた軌道長半径
    let a = 0
    for (let tries = 0; tries < 24; tries++) {
      a = 2.1 + Math.random() * 1.25
      const nearGap = GAPS.some((g) => Math.abs(a - g) < 0.045 && Math.random() < 0.9)
      if (!nearGap) break
    }
    const e = Math.min(0.15, 0.15 * Math.sqrt(Math.random()))
    const inc = gaussian() * 6 * DEG
    const Omega = Math.random() * Math.PI * 2
    const omega = Math.random() * Math.PI * 2
    const M0 = Math.random() * Math.PI * 2
    const n = GAUSS_K / Math.pow(a, 1.5)

    // 近焦点基底 P̂（近日点方向）・Q̂ をシーン座標系で事前計算
    perifocalToScene(1, 0, omega, Omega, inc, P)
    perifocalToScene(0, 1, omega, Omega, inc, Q)

    els.set([a, e, M0, n], i * 4)
    const u = Math.random()
    axes1.set([P.x, P.y, P.z, 0.55 + 1.6 * u * u * u], i * 4)
    axes2.set([Q.x, Q.y, Q.z, Math.random()], i * 4)
  }
  return { els, axes1, axes2 }
}

function gaussian(): number {
  let s = 0
  for (let i = 0; i < 4; i++) s += Math.random()
  return (s - 2) * Math.SQRT2
}
