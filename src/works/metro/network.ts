import * as THREE from 'three'

import type { LineDef } from './data'

/**
 * 路線データを描画・運行に使える形へ変換する純粋計算のモジュール。
 *
 * - 投影: 東京駅原点の正距円筒。1 scene unit = 1km（水平）
 * - 深度: 実深度(m) × 誇張90倍 を y に。地下40mが約3.6unit下に見える
 * - 線形: Catmull-Rom（centripetal。駅間隔が不均一でも暴れない）を
 *   弧長50m刻みで一様リサンプルし、O(1)ルックアップの LUT にする
 * - 運行: 「発車からの経過時間 → 弧長位置」の時刻表LUTを実時間1秒刻みで焼く
 */

const ORIGIN = { lat: 35.6812, lng: 139.7671 } // 東京駅付近を原点に
const KM_PER_DEG_LAT = 110.95
const KM_PER_DEG_LNG = 111.32 * Math.cos((ORIGIN.lat * Math.PI) / 180)
/** 深度の垂直誇張。1m → 0.09 unit（=90倍） */
const DEPTH_SCALE = 0.09
/** 弧長LUTの刻み(m) */
const ARC_STEP = 50
/** 加速度・減速度 (m/s²)。実勢 3.3〜3.5 km/h/s */
const ACCEL = 0.92
const DECEL = 0.97
/** 駅停車時間（実時間秒） */
const DWELL = 35

/** 緯度経度→シーン座標(km)。y は呼び出し側で深度から決める */
export function project(lat: number, lng: number): { x: number; z: number } {
  return {
    x: (lng - ORIGIN.lng) * KM_PER_DEG_LNG,
    z: -(lat - ORIGIN.lat) * KM_PER_DEG_LAT,
  }
}

export function depthToY(depthMeters: number): number {
  return -depthMeters * DEPTH_SCALE
}

export interface LineGeometry {
  /** 弧長50m刻みの点列 (x,y,z)×M */
  positions: Float32Array
  /** 同じ刻みの単位接線 */
  tangents: Float32Array
  /** 全長(m) */
  totalLength: number
  /** 各駅の弧長位置(m) */
  stationArc: Float32Array
  /** 各駅のシーン座標 */
  stationPos: THREE.Vector3[]
  /** 元カーブ（チューブ生成に使う） */
  curve: THREE.CatmullRomCurve3
}

/** 路線1本ぶんの幾何を構築する。 */
export function buildLineGeometry(line: LineDef, lineIndex: number): LineGeometry {
  const stationPos = line.stations.map((s, i) => {
    const { x, z } = project(s.lat, s.lng)
    const depth = s.depth ?? line.baseDepth
    // 駅間が単調な水平線にならないよう、小さくうねらせる
    const wobble = Math.sin(i * 1.7 + lineIndex * 13.7) * 0.15
    return new THREE.Vector3(x, depthToY(depth) + wobble, z)
  })

  const curve = new THREE.CatmullRomCurve3(stationPos, false, 'centripetal')

  const totalLength = curve.getLength() * 1000 // unit=km → m
  const samples = Math.max(2, Math.ceil(totalLength / ARC_STEP))
  const spaced = curve.getSpacedPoints(samples) // 弧長で等間隔の samples+1 点

  const positions = new Float32Array((samples + 1) * 3)
  for (let i = 0; i <= samples; i++) {
    positions[i * 3] = spaced[i].x
    positions[i * 3 + 1] = spaced[i].y
    positions[i * 3 + 2] = spaced[i].z
  }
  // 接線は前後差分から。端は片側差分
  const tangents = new Float32Array((samples + 1) * 3)
  const t = new THREE.Vector3()
  for (let i = 0; i <= samples; i++) {
    const a = Math.max(0, i - 1)
    const b = Math.min(samples, i + 1)
    t.set(
      positions[b * 3] - positions[a * 3],
      positions[b * 3 + 1] - positions[a * 3 + 1],
      positions[b * 3 + 2] - positions[a * 3 + 2],
    ).normalize()
    tangents[i * 3] = t.x
    tangents[i * 3 + 1] = t.y
    tangents[i * 3 + 2] = t.z
  }

  // 各駅の弧長位置: 累積長テーブルから駅パラメータ t=i/(n-1) の位置を引く
  const divisions = line.stations.length * 64
  const lengths = curve.getLengths(divisions) // divisions+1 個の累積長(unit)
  const stationArc = new Float32Array(line.stations.length)
  for (let i = 0; i < line.stations.length; i++) {
    const u = i / (line.stations.length - 1)
    const j = Math.min(divisions, Math.round(u * divisions))
    stationArc[i] = lengths[j] * 1000
  }
  // 数値誤差の保険: 単調増加を強制し、端点を厳密に合わせる
  stationArc[0] = 0
  stationArc[line.stations.length - 1] = totalLength
  for (let i = 1; i < line.stations.length; i++) {
    if (stationArc[i] <= stationArc[i - 1]) stationArc[i] = stationArc[i - 1] + 1
  }

  return { positions, tangents, totalLength, stationArc, stationPos, curve }
}

/** 弧長(m) → シーン座標と接線。LUT の線形補間で O(1)。 */
export function sampleLine(
  geo: LineGeometry,
  arcMeters: number,
  outPos: THREE.Vector3,
  outTan: THREE.Vector3,
): void {
  const count = geo.positions.length / 3 - 1
  const f = Math.min(Math.max(arcMeters / geo.totalLength, 0), 1) * count
  const i = Math.min(count - 1, Math.floor(f))
  const s = f - i
  const p = geo.positions
  const g = geo.tangents
  outPos.set(
    p[i * 3] + (p[(i + 1) * 3] - p[i * 3]) * s,
    p[i * 3 + 1] + (p[(i + 1) * 3 + 1] - p[i * 3 + 1]) * s,
    p[i * 3 + 2] + (p[(i + 1) * 3 + 2] - p[i * 3 + 2]) * s,
  )
  outTan
    .set(
      g[i * 3] + (g[(i + 1) * 3] - g[i * 3]) * s,
      g[i * 3 + 1] + (g[(i + 1) * 3 + 1] - g[i * 3 + 1]) * s,
      g[i * 3 + 2] + (g[(i + 1) * 3 + 2] - g[i * 3 + 2]) * s,
    )
    .normalize()
}

export interface Timetable {
  /** τ(実時間秒、1秒刻み) → 弧長(m)。 */
  lut: Float32Array
  /** 終点到達までの実時間(秒) */
  totalTime: number
}

/**
 * 時刻表LUTを焼く。駅間ごとに台形速度プロファイル（短い駅間は三角形）、
 * 駅到着ごとにドウェル。全列車が同じプロファイルなので路線に1本で足りる。
 */
export function buildTimetable(geo: LineGeometry, vmaxKmh: number): Timetable {
  const vmax = (vmaxKmh * 1000) / 3600 // m/s
  // まず「時刻(秒)→弧長」の区分点列を作る
  const times: number[] = [0]
  const arcs: number[] = [0]
  let clock = 0

  for (let i = 0; i < geo.stationArc.length - 1; i++) {
    const from = geo.stationArc[i]
    const to = geo.stationArc[i + 1]
    const dist = to - from

    // この駅間で出せる頂点速度（台形が組めなければ三角形）
    const vpeak = Math.min(vmax, Math.sqrt((2 * dist * ACCEL * DECEL) / (ACCEL + DECEL)))
    const tAcc = vpeak / ACCEL
    const dAcc = 0.5 * ACCEL * tAcc * tAcc
    const tDec = vpeak / DECEL
    const dDec = 0.5 * DECEL * tDec * tDec
    const dCruise = Math.max(0, dist - dAcc - dDec)
    const tCruise = dCruise / vpeak

    // 加速・巡航・減速を1秒より細かい区分点で記録
    const segs: [number, number][] = [] // [時刻, 弧長]
    const steps = 24
    for (let k = 1; k <= steps; k++) {
      const tt = (tAcc * k) / steps
      segs.push([clock + tt, from + 0.5 * ACCEL * tt * tt])
    }
    if (tCruise > 0) segs.push([clock + tAcc + tCruise, from + dAcc + dCruise])
    for (let k = 1; k <= steps; k++) {
      const tt = (tDec * k) / steps
      segs.push([
        clock + tAcc + tCruise + tt,
        from + dAcc + dCruise + vpeak * tt - 0.5 * DECEL * tt * tt,
      ])
    }
    for (const [tt, aa] of segs) {
      times.push(tt)
      arcs.push(Math.min(aa, to))
    }
    clock += tAcc + tCruise + tDec

    // 駅停車（終点はドウェル不要）
    if (i < geo.stationArc.length - 2) {
      clock += DWELL
      times.push(clock)
      arcs.push(to)
    }
  }

  const totalTime = clock
  // 1秒刻みへリサンプル
  const lut = new Float32Array(Math.ceil(totalTime) + 2)
  let j = 0
  for (let sec = 0; sec < lut.length; sec++) {
    const t = Math.min(sec, totalTime)
    while (j < times.length - 2 && times[j + 1] < t) j++
    const span = times[j + 1] - times[j]
    const s = span > 0 ? (t - times[j]) / span : 0
    lut[sec] = arcs[j] + (arcs[j + 1] - arcs[j]) * Math.min(Math.max(s, 0), 1)
  }
  lut[lut.length - 1] = geo.totalLength
  return { lut, totalTime }
}

/** 時刻表LUTを引く。τ(実時間秒) → 弧長(m)。 */
export function sampleTimetable(table: Timetable, tau: number): number {
  const t = Math.min(Math.max(tau, 0), table.totalTime)
  const i = Math.min(table.lut.length - 2, Math.floor(t))
  return table.lut[i] + (table.lut[i + 1] - table.lut[i]) * (t - i)
}
