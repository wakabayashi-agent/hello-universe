import * as THREE from 'three'

import type { Work, WorkContext } from '../../core/Work'
import { Pass, createRenderTarget } from '../../core/gpu'
import { pointer } from '../../core/pointer'
import { el } from '../../ui/dom'
import { LINES, PALACE, YAMANOTE_GHOST } from './data'
import {
  buildLineGeometry,
  buildTimetable,
  project,
  sampleLine,
  sampleTimetable,
  type LineGeometry,
  type Timetable,
} from './network'
import {
  BLUR_FRAG,
  BRIGHT_FRAG,
  COMPOSITE_FRAG,
  GHOST_LINE_FRAG,
  GHOST_LINE_VERT,
  GRID_FRAG,
  GRID_VERT,
  LABEL_FRAG,
  LABEL_VERT,
  STATION_FRAG,
  STATION_VERT,
  TRAIN_FRAG,
  TRAIN_VERT,
  TUBE_FRAG,
  TUBE_VERT,
} from './shaders'

/** 初期視点。網の全体が収まる斜め見下ろし */
const HOME = { azimuth: -Math.PI / 2, incl: (38 * Math.PI) / 180, radius: 22 }
const HOME_TARGET = new THREE.Vector3(0, -0.9, 0)
const MIN_RADIUS = 2.5
const MAX_RADIUS = 48
const MIN_INCL = (8 * Math.PI) / 180
const MAX_INCL = (85 * Math.PI) / 180
/** 放置時の自動周回 */
const AUTO_SPIN = 0.04
const BREATH_AMP = (12 * Math.PI) / 180
const BREATH_PERIOD = 45
/** 実時間の何倍で運行するか。×45 = 駅間(実100秒)が約2.2秒 */
const TIME_SCALE = 45
/** 開幕から在線している状態で始めるためのオフセット（実時間秒） */
const SIM_OFFSET = 5000
const TRAIN_CAPACITY = 256
const X_AXIS = new THREE.Vector3(1, 0, 0)

interface TrainDef {
  line: number
  dir: 0 | 1
  k: number
  nPerDir: number
}

interface LabelInfo {
  line: number
  level: 1 | 2
  pos: THREE.Vector3
  order: number
}

export function create(): Work {
  return new MetroWork()
}

class MetroWork implements Work {
  readonly id = 'metro'

  private renderer!: THREE.WebGLRenderer
  private canvas!: HTMLCanvasElement
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400)

  private geos: LineGeometry[] = []
  private tables: Timetable[] = []
  private colors: THREE.Color[] = []
  private dims = new Array(9).fill(1) as number[]
  private dimTargets = new Array(9).fill(1) as number[]
  private lineCentroids: THREE.Vector3[] = []

  private tubeMaterial!: THREE.ShaderMaterial
  private stationMaterial!: THREE.ShaderMaterial
  private trainMaterial!: THREE.ShaderMaterial
  private labelMaterial: THREE.ShaderMaterial | null = null
  private extraMaterials: THREE.ShaderMaterial[] = []
  private geometries: THREE.BufferGeometry[] = []
  private trains!: THREE.InstancedMesh
  private trainDefs: TrainDef[] = []
  private dummy = new THREE.Object3D()

  private atlasTexture: THREE.CanvasTexture | null = null
  private labels: LabelInfo[] = []
  private labelVis: THREE.InstancedBufferAttribute | null = null
  private defaultLabelCount = 12

  private sceneRT!: THREE.WebGLRenderTarget
  private bloomA!: THREE.WebGLRenderTarget
  private bloomB!: THREE.WebGLRenderTarget
  private brightPass!: Pass
  private blurPass!: Pass
  private compositePass!: Pass
  private internalScale = 1
  private bloomTexel = new THREE.Vector2()

  // カメラ状態（blackhole と同じ球座標+慣性モデル）
  private azimuth = HOME.azimuth
  private incl = HOME.incl
  private radius = HOME.radius
  private azVel = 0
  private inclVel = 0
  private autoWeight = 1
  private lookTarget = HOME_TARGET.clone()
  private lookCurrent = HOME_TARGET.clone()

  private dragging = false
  private dragDX = 0
  private dragDY = 0
  private lastDrag = { x: 0, y: 0 }
  private pressAt: { x: number; y: number; time: number } | null = null

  private selected = -1
  private attractActive = false
  private attractTimer = 0
  private attractIndex = -1

  private badge: HTMLElement | null = null

  mount(ctx: WorkContext): void {
    const { renderer, quality } = ctx
    this.renderer = renderer
    this.canvas = renderer.domElement
    this.camera.aspect = ctx.width / ctx.height

    const tubularPerStation = quality.pick(12, 8, 6)
    const radialSegments = quality.pick(6, 4, 3)
    this.internalScale = quality.pick(1, 0.75, 0.6)
    const bloomStrength = quality.pick(0.9, 0.7, 0.5)
    this.defaultLabelCount = quality.pick(18, 12, 8)
    const withShafts = quality.tier !== 'low'
    const withYamanote = quality.tier !== 'low'
    const withPalace = quality.tier === 'high'

    // 幾何と時刻表（純粋計算）
    this.geos = LINES.map((line, i) => buildLineGeometry(line, i))
    this.tables = this.geos.map((g, i) => buildTimetable(g, LINES[i].vmax))
    // 公式色は sRGB 値をそのまま使う（この作品のパイプラインは自前トーンマップ）
    this.colors = LINES.map((l) =>
      new THREE.Color().setHex(parseInt(l.color.slice(1), 16), THREE.LinearSRGBColorSpace),
    )
    this.lineCentroids = this.geos.map((g) => {
      const c = new THREE.Vector3()
      for (const p of g.stationPos) c.add(p)
      return c.divideScalar(g.stationPos.length)
    })

    // 全体を加算合成で重ねる。奥行きの遮蔽をあえて捨てることで、
    // 地下の路線が層のまま透けて見える（この作品の見せ方の核）
    const additive = {
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    } as const

    // 路線チューブ
    this.tubeMaterial = new THREE.ShaderMaterial({
      vertexShader: TUBE_VERT,
      fragmentShader: TUBE_FRAG,
      uniforms: {
        uColor: { value: this.colors },
        uDim: { value: this.dims },
        uCamPos: { value: this.camera.position },
      },
      ...additive,
    })
    for (let i = 0; i < LINES.length; i++) {
      const tubular = LINES[i].stations.length * tubularPerStation
      const geom = new THREE.TubeGeometry(this.geos[i].curve, tubular, 0.05, radialSegments, false)
      geom.setAttribute(
        'aLine',
        new THREE.BufferAttribute(new Float32Array(geom.attributes.position.count).fill(i), 1),
      )
      this.geometries.push(geom)
      const mesh = new THREE.Mesh(geom, this.tubeMaterial)
      mesh.frustumCulled = false
      this.scene.add(mesh)
    }

    this.buildStationsAndShafts(withShafts)
    this.buildGround(withYamanote, withPalace)
    this.buildTrains()
    this.buildLabels()

    // HDR とミニブルーム（全部加算なので深度バッファは不要）
    const half: { type: THREE.TextureDataType; filter: THREE.MagnificationTextureFilter } = {
      type: THREE.HalfFloatType,
      filter: THREE.LinearFilter,
    }
    this.sceneRT = createRenderTarget(1, 1, half)
    this.bloomA = createRenderTarget(1, 1, half)
    this.bloomB = createRenderTarget(1, 1, half)
    this.brightPass = new Pass(BRIGHT_FRAG, { uScene: { value: null } })
    this.blurPass = new Pass(BLUR_FRAG, {
      uSource: { value: null },
      uDir: { value: new THREE.Vector2() },
    })
    this.compositePass = new Pass(COMPOSITE_FRAG, {
      uScene: { value: null },
      uBloom: { value: null },
      uBloomStrength: { value: bloomStrength },
    })

    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)

    this.buildUI(ctx.overlay)
    this.resize(ctx.width, ctx.height)
  }

  /** 駅ノードと、同名駅を縦に結ぶ乗換シャフト。 */
  private buildStationsAndShafts(withShafts: boolean): void {
    // 駅名 → 出現位置の集計（乗換駅の自動検出）
    const byName = new Map<string, { pts: THREE.Vector3[]; lines: Set<number> }>()
    for (let i = 0; i < LINES.length; i++) {
      LINES[i].stations.forEach((s, j) => {
        const entry = byName.get(s.name) ?? { pts: [], lines: new Set<number>() }
        entry.pts.push(this.geos[i].stationPos[j])
        entry.lines.add(i)
        byName.set(s.name, entry)
      })
    }

    const count = this.geos.reduce((n, g) => n + g.stationPos.length, 0)
    const positions = new Float32Array(count * 3)
    const sizes = new Float32Array(count)
    const colors = new Float32Array(count * 3)
    const lineIdx = new Float32Array(count)
    let n = 0
    const white = new THREE.Color(1, 1, 1)
    const tmp = new THREE.Color()
    for (let i = 0; i < LINES.length; i++) {
      LINES[i].stations.forEach((s, j) => {
        const p = this.geos[i].stationPos[j]
        const interchange = (byName.get(s.name)?.lines.size ?? 1) >= 2
        positions.set([p.x, p.y, p.z], n * 3)
        sizes[n] = interchange ? 6.2 : 3.4
        tmp.copy(this.colors[i]).lerp(white, interchange ? 0.6 : 0.15)
        colors.set([tmp.r, tmp.g, tmp.b], n * 3)
        lineIdx[n] = i
        n++
      })
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
    geom.setAttribute('aColor', new THREE.BufferAttribute(colors, 3))
    geom.setAttribute('aLine', new THREE.BufferAttribute(lineIdx, 1))
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.geometries.push(geom)
    this.stationMaterial = new THREE.ShaderMaterial({
      vertexShader: STATION_VERT,
      fragmentShader: STATION_FRAG,
      uniforms: {
        uDim: { value: this.dims },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const points = new THREE.Points(geom, this.stationMaterial)
    points.frustumCulled = false
    this.scene.add(points)

    if (!withShafts) return
    // 乗換シャフト: 同名駅の最浅と最深を結ぶ縦線。地下の「層」が一目で分かる
    const segs: number[] = []
    for (const entry of byName.values()) {
      if (entry.lines.size < 2) continue
      let minY = Infinity
      let maxY = -Infinity
      let cx = 0
      let cz = 0
      for (const p of entry.pts) {
        minY = Math.min(minY, p.y)
        maxY = Math.max(maxY, p.y)
        cx += p.x
        cz += p.z
      }
      cx /= entry.pts.length
      cz /= entry.pts.length
      segs.push(cx, minY, cz, cx, maxY + 0.06, cz)
    }
    this.addGhostLine(new Float32Array(segs), new THREE.Color(0.16, 0.18, 0.22), true)
  }

  /** 地表の参照: 1km格子 + 山手線ゴースト + 皇居。 */
  private buildGround(withYamanote: boolean, withPalace: boolean): void {
    const plane = new THREE.PlaneGeometry(90, 90, 1, 1)
    plane.rotateX(-Math.PI / 2)
    this.geometries.push(plane)
    const gridMaterial = new THREE.ShaderMaterial({
      vertexShader: GRID_VERT,
      fragmentShader: GRID_FRAG,
      uniforms: {},
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.extraMaterials.push(gridMaterial)
    const grid = new THREE.Mesh(plane, gridMaterial)
    grid.frustumCulled = false
    this.scene.add(grid)

    if (withYamanote) {
      const pts = YAMANOTE_GHOST.map(([lat, lng]) => {
        const { x, z } = project(lat, lng)
        return new THREE.Vector3(x, 0.02, z)
      })
      const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal')
      const loop = curve.getPoints(180)
      const arr = new Float32Array(loop.length * 3)
      loop.forEach((p, i) => arr.set([p.x, p.y, p.z], i * 3))
      this.addGhostLine(arr, new THREE.Color(0.09, 0.1, 0.12), false)
    }
    if (withPalace) {
      const arr = new Float32Array(49 * 3)
      const { x, z } = project(PALACE.lat, PALACE.lng)
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2
        arr.set([x + Math.cos(a) * PALACE.rxKm, 0.02, z + Math.sin(a) * PALACE.ryKm], i * 3)
      }
      this.addGhostLine(arr, new THREE.Color(0.05, 0.08, 0.07), false)
    }
  }

  private addGhostLine(positions: Float32Array, tint: THREE.Color, segments: boolean): void {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.geometries.push(geom)
    const material = new THREE.ShaderMaterial({
      vertexShader: GHOST_LINE_VERT,
      fragmentShader: GHOST_LINE_FRAG,
      uniforms: { uTint: { value: tint } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.extraMaterials.push(material)
    const line = segments
      ? new THREE.LineSegments(geom, material)
      : new THREE.Line(geom, material)
    line.frustumCulled = false
    this.scene.add(line)
  }

  /** 列車。ヘッドウェイから在線本数を決め、位相をずらして常時運行させる。 */
  private buildTrains(): void {
    for (let i = 0; i < LINES.length; i++) {
      const nPerDir = Math.ceil(this.tables[i].totalTime / LINES[i].headway)
      for (const dir of [0, 1] as const) {
        for (let k = 0; k < nPerDir; k++) {
          if (this.trainDefs.length >= TRAIN_CAPACITY) break
          this.trainDefs.push({ line: i, dir, k, nPerDir })
        }
      }
    }

    const box = new THREE.BoxGeometry(1, 1, 1)
    box.setAttribute(
      'aTrainLine',
      new THREE.InstancedBufferAttribute(
        new Float32Array(this.trainDefs.map((d) => d.line)),
        1,
      ),
    )
    this.geometries.push(box)
    this.trainMaterial = new THREE.ShaderMaterial({
      vertexShader: TRAIN_VERT,
      fragmentShader: TRAIN_FRAG,
      uniforms: { uColor: { value: this.colors }, uDim: { value: this.dims } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.trains = new THREE.InstancedMesh(box, this.trainMaterial, this.trainDefs.length)
    this.trains.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.trains.frustumCulled = false
    this.scene.add(this.trains)
  }

  /** 駅名ラベル。Canvas2D で1枚のアトラスに焼き、ビルボードで出す。 */
  private buildLabels(): void {
    for (let i = 0; i < LINES.length; i++) {
      LINES[i].stations.forEach((s, j) => {
        if (!s.label) return
        this.labels.push({
          line: i,
          level: s.label,
          pos: this.geos[i].stationPos[j],
          order: this.labels.length,
        })
      })
    }
    if (this.labels.length === 0) return

    const cellW = 256
    const cellH = 56
    const cols = 4
    const rows = Math.ceil(this.labels.length / cols)
    const canvas = document.createElement('canvas')
    canvas.width = cellW * cols
    canvas.height = cellH * rows
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return
    ctx2d.font = "bold 30px 'Hiragino Sans', 'Noto Sans JP', sans-serif"
    ctx2d.textAlign = 'center'
    ctx2d.textBaseline = 'middle'
    ctx2d.fillStyle = '#ffffff'
    ctx2d.shadowColor = 'rgba(200, 220, 255, 0.9)'
    ctx2d.shadowBlur = 7

    const uvRects = new Float32Array(this.labels.length * 4)
    const labelPos = new Float32Array(this.labels.length * 3)
    const vis = new Float32Array(this.labels.length)
    this.labels.forEach((label, i) => {
      const cx = i % cols
      const cy = Math.floor(i / cols)
      uvRects.set(
        [
          (cx * cellW) / canvas.width,
          1 - ((cy + 1) * cellH) / canvas.height,
          cellW / canvas.width,
          cellH / canvas.height,
        ],
        i * 4,
      )
      labelPos.set([label.pos.x, label.pos.y, label.pos.z], i * 3)
    })
    // アトラスへの描画は登録順のまま。tier 別・選択時の表示は aVis で制御する
    let idx = 0
    for (let i = 0; i < LINES.length; i++) {
      for (const s of LINES[i].stations) {
        if (!s.label) continue
        const cx = idx % cols
        const cy = Math.floor(idx / cols)
        ctx2d.fillText(s.name, cx * cellW + cellW / 2, cy * cellH + cellH / 2, cellW - 16)
        idx++
      }
    }

    this.atlasTexture = new THREE.CanvasTexture(canvas)
    this.atlasTexture.generateMipmaps = false
    this.atlasTexture.minFilter = THREE.LinearFilter

    const plane = new THREE.PlaneGeometry(1, 1)
    const geom = new THREE.InstancedBufferGeometry()
    geom.index = plane.index
    geom.setAttribute('position', plane.attributes.position)
    geom.setAttribute('uv', plane.attributes.uv)
    geom.instanceCount = this.labels.length
    geom.setAttribute('aLabelPos', new THREE.InstancedBufferAttribute(labelPos, 3))
    geom.setAttribute('aUvRect', new THREE.InstancedBufferAttribute(uvRects, 4))
    this.labelVis = new THREE.InstancedBufferAttribute(vis, 1)
    this.labelVis.setUsage(THREE.DynamicDrawUsage)
    geom.setAttribute('aVis', this.labelVis)
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.geometries.push(plane)
    this.geometries.push(geom)

    this.labelMaterial = new THREE.ShaderMaterial({
      vertexShader: LABEL_VERT,
      fragmentShader: LABEL_FRAG,
      uniforms: {
        uAtlas: { value: this.atlasTexture },
        uCamPos: { value: this.camera.position },
        uCamRight: { value: new THREE.Vector3(1, 0, 0) },
        uCamUp: { value: new THREE.Vector3(0, 1, 0) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const mesh = new THREE.Mesh(geom, this.labelMaterial)
    mesh.frustumCulled = false
    mesh.renderOrder = 10
    this.scene.add(mesh)
    this.applyLabelVisibility()
  }

  private applyLabelVisibility(): void {
    if (!this.labelVis) return
    const arr = this.labelVis.array as Float32Array
    this.labels.forEach((label, i) => {
      if (this.selected >= 0) {
        arr[i] = label.line === this.selected ? 1 : 0
      } else if (this.defaultLabelCount >= 18) {
        arr[i] = 1
      } else if (this.defaultLabelCount >= 12) {
        arr[i] = label.level === 1 ? 1 : 0
      } else {
        // low: level1 の先頭8つだけ
        arr[i] = label.level === 1 && this.level1Rank(i) < 8 ? 1 : 0
      }
    })
    this.labelVis.needsUpdate = true
  }

  private level1Rank(index: number): number {
    let rank = 0
    for (let i = 0; i < index; i++) if (this.labels[i].level === 1) rank++
    return rank
  }

  private buildUI(overlay: HTMLElement): void {
    const bar = overlay.querySelector<HTMLElement>('.work__bar')
    if (bar) {
      this.badge = el('span', { class: 'badge' }, [''])
      bar.append(this.badge)
    }
  }

  /** 路線を選ぶ／解除する。減光・ラベル・注視点・バッジをまとめて切り替える。 */
  private selectLine(index: number, fromAttract: boolean): void {
    this.selected = index
    this.attractActive = fromAttract
    for (let i = 0; i < 9; i++) {
      this.dimTargets[i] = index < 0 ? 1 : i === index ? 1.25 : 0.16
    }
    if (index >= 0) {
      this.lookTarget.copy(this.lineCentroids[index])
      this.lookTarget.y = Math.max(this.lookTarget.y, -1.6)
    } else {
      this.lookTarget.copy(HOME_TARGET)
    }
    if (this.badge) this.badge.textContent = index >= 0 ? LINES[index].name : ''
    this.applyLabelVisibility()
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    let pixels = event.deltaY
    if (event.deltaMode === 1) pixels *= 33
    else if (event.deltaMode === 2) pixels *= 300
    const factor = Math.exp(clamp(pixels, -300, 300) * 0.0016)
    this.radius = clamp(this.radius * factor, MIN_RADIUS, MAX_RADIUS)
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    this.dragging = true
    this.dragDX = 0
    this.dragDY = 0
    this.lastDrag = { x: event.clientX, y: event.clientY }
    this.pressAt = { x: event.clientX, y: event.clientY, time: performance.now() }
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return
    this.dragDX += event.clientX - this.lastDrag.x
    this.dragDY += event.clientY - this.lastDrag.y
    this.lastDrag = { x: event.clientX, y: event.clientY }
  }

  private onPointerUp = (event: PointerEvent): void => {
    this.dragging = false
    const press = this.pressAt
    this.pressAt = null
    if (!press) return
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y)
    if (moved < 5 && performance.now() - press.time < 350) {
      this.handleClick(event.clientX, event.clientY)
    }
  }

  /**
   * クリック位置に最も近い路線を選ぶ。レイキャストではなく、
   * 弧長LUTの点列をスクリーン投影して最近傍を取る（チューブ半径に依存せず堅い）。
   */
  private handleClick(clientX: number, clientY: number): void {
    const width = Math.max(1, window.innerWidth)
    const height = Math.max(1, window.innerHeight)
    const v = new THREE.Vector3()
    let bestLine = -1
    let bestDist = 28 * 28
    for (let i = 0; i < this.geos.length; i++) {
      const p = this.geos[i].positions
      for (let j = 0; j < p.length; j += 6) {
        v.set(p[j], p[j + 1], p[j + 2]).project(this.camera)
        if (v.z > 1 || v.z < -1) continue
        const sx = (v.x * 0.5 + 0.5) * width
        const sy = (-v.y * 0.5 + 0.5) * height
        const d = (sx - clientX) ** 2 + (sy - clientY) ** 2
        if (d < bestDist) {
          bestDist = d
          bestLine = i
        }
      }
    }
    if (bestLine >= 0 && bestLine !== this.selected) this.selectLine(bestLine, false)
    else this.selectLine(-1, false)
  }

  update(dt: number, elapsed: number): void {
    const step = Math.min(dt, 1 / 30)

    // 放置検出と自動演出（blackhole と同じ合流のさせ方）
    const wantAuto = !this.dragging && pointer.idleFor(4000) ? 1 : 0
    this.autoWeight += (wantAuto - this.autoWeight) * Math.min(1, step * 1.5)
    this.azimuth += AUTO_SPIN * this.autoWeight * step
    const breath = Math.cos((elapsed * Math.PI * 2) / BREATH_PERIOD)
    this.incl = clampIncl(
      this.incl + breath * BREATH_AMP * ((Math.PI * 2) / BREATH_PERIOD) * this.autoWeight * step,
    )

    // さらに長い放置で、路線紹介の無限ループ（操作で即解除）
    if (pointer.idleFor(12000)) {
      this.attractTimer -= step
      if (this.attractTimer <= 0) {
        this.attractIndex = (this.attractIndex + 1) % LINES.length
        this.selectLine(this.attractIndex, true)
        this.attractTimer = 6
      }
    } else if (this.attractActive) {
      this.selectLine(-1, false)
      this.attractTimer = 0
    }

    // ドラッグと慣性
    const height = Math.max(1, window.innerHeight)
    if (this.dragging) {
      const dAz = (this.dragDX * 2.6) / height
      const dIn = (this.dragDY * 2.0) / height
      this.azimuth += dAz
      this.incl = clampIncl(this.incl + dIn)
      this.azVel = 0.65 * this.azVel + 0.35 * (dAz / Math.max(step, 1e-3))
      this.inclVel = 0.65 * this.inclVel + 0.35 * (dIn / Math.max(step, 1e-3))
      this.dragDX = 0
      this.dragDY = 0
    } else {
      this.azimuth += this.azVel * step
      this.incl = clampIncl(this.incl + this.inclVel * step)
      const damp = Math.exp(-2.5 * step)
      this.azVel *= damp
      this.inclVel *= damp
    }

    // 減光と注視点のイーズ
    for (let i = 0; i < 9; i++) {
      this.dims[i] += (this.dimTargets[i] - this.dims[i]) * Math.min(1, step * 6)
    }
    this.lookCurrent.lerp(this.lookTarget, Math.min(1, step * 2))

    this.updateCamera()
    this.updateTrains(elapsed)

    // 描画: シーン → HDR RT → 明部抽出 → 横縦ブラー → 合成
    this.renderer.setRenderTarget(this.sceneRT)
    this.renderer.render(this.scene, this.camera)
    this.renderer.setRenderTarget(null)

    this.brightPass.set('uScene', this.sceneRT.texture)
    this.brightPass.render(this.renderer, this.bloomA)
    const dir = this.blurPass.uniforms.uDir.value as THREE.Vector2
    this.blurPass.set('uSource', this.bloomA.texture)
    dir.set(this.bloomTexel.x, 0)
    this.blurPass.render(this.renderer, this.bloomB)
    this.blurPass.set('uSource', this.bloomB.texture)
    dir.set(0, this.bloomTexel.y)
    this.blurPass.render(this.renderer, this.bloomA)

    this.compositePass.set('uScene', this.sceneRT.texture)
    this.compositePass.set('uBloom', this.bloomA.texture)
    this.compositePass.render(this.renderer, null)
  }

  private updateCamera(): void {
    const incl = clampIncl(this.incl)
    const ce = Math.cos(incl)
    this.camera.position
      .set(Math.cos(this.azimuth) * ce, Math.sin(incl), Math.sin(this.azimuth) * ce)
      .multiplyScalar(this.radius)
      .add(this.lookCurrent)
    this.camera.lookAt(this.lookCurrent)
    this.camera.updateMatrixWorld()

    if (this.labelMaterial) {
      const m = this.camera.matrixWorld.elements
      ;(this.labelMaterial.uniforms.uCamRight.value as THREE.Vector3).set(m[0], m[1], m[2])
      ;(this.labelMaterial.uniforms.uCamUp.value as THREE.Vector3).set(m[4], m[5], m[6])
    }
  }

  /** 時刻表LUTを引いて全列車の instanceMatrix を更新する。 */
  private updateTrains(elapsed: number): void {
    const simTime = SIM_OFFSET + elapsed * TIME_SCALE
    const pos = new THREE.Vector3()
    const tan = new THREE.Vector3()
    for (let t = 0; t < this.trainDefs.length; t++) {
      const def = this.trainDefs[t]
      const table = this.tables[def.line]
      const geo = this.geos[def.line]
      const headway = LINES[def.line].headway
      const cycle = def.nPerDir * headway
      // 方向ごとに位相を半分ずらすと、単線上ですれ違いが生まれる
      const offset = def.dir === 1 ? headway * 0.5 : 0
      const tau = (simTime + def.k * headway + offset) % cycle

      if (tau > table.totalTime) {
        this.dummy.scale.setScalar(0)
        this.dummy.position.set(0, 100, 0)
      } else {
        let arc = sampleTimetable(table, tau)
        if (def.dir === 1) arc = geo.totalLength - arc
        sampleLine(geo, arc, pos, tan)
        if (def.dir === 1) tan.negate()
        this.dummy.position.copy(pos)
        this.dummy.quaternion.setFromUnitVectors(X_AXIS, tan)
        this.dummy.scale.set(0.35, 0.055, 0.055)
      }
      this.dummy.updateMatrix()
      this.trains.setMatrixAt(t, this.dummy.matrix)
    }
    this.trains.instanceMatrix.needsUpdate = true
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    if (this.stationMaterial) {
      this.stationMaterial.uniforms.uPixelRatio.value = this.renderer.getPixelRatio()
    }
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    const w = Math.max(1, Math.round(size.x * this.internalScale))
    const h = Math.max(1, Math.round(size.y * this.internalScale))
    this.sceneRT.setSize(w, h)
    const bw = Math.max(1, Math.round(w / 4))
    const bh = Math.max(1, Math.round(h / 4))
    this.bloomA.setSize(bw, bh)
    this.bloomB.setSize(bw, bh)
    this.bloomTexel.set(1 / bw, 1 / bh)
  }

  dispose(): void {
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.badge?.remove()
    for (const g of this.geometries) g.dispose()
    this.tubeMaterial.dispose()
    this.stationMaterial.dispose()
    this.trainMaterial.dispose()
    this.labelMaterial?.dispose()
    for (const m of this.extraMaterials) m.dispose()
    this.atlasTexture?.dispose()
    this.trains.dispose()
    this.sceneRT.dispose()
    this.bloomA.dispose()
    this.bloomB.dispose()
    for (const pass of [this.brightPass, this.blurPass, this.compositePass]) pass.dispose()
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clampIncl(value: number): number {
  return clamp(value, MIN_INCL, MAX_INCL)
}
