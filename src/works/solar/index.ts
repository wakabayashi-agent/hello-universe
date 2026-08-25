import * as THREE from 'three'

import type { Work, WorkContext } from '../../core/Work'
import { Pass, createRenderTarget } from '../../core/gpu'
import { pointer } from '../../core/pointer'
import { el } from '../../ui/dom'
import {
  COMETS,
  EPOCH_DAYS,
  MOON,
  PLANETS,
  SUN_RADIUS,
  buildBeltAttributes,
  cometState,
  orbitLinePoints,
  planetState,
  toVisual,
  type BodyState,
  type CometDef,
  type PlanetDef,
} from './data'
import {
  BELT_FRAG,
  BELT_VERT,
  BLUR_FRAG,
  BRIGHT_FRAG,
  COMET_TAIL_FRAG,
  COMET_TAIL_VERT,
  COMPOSITE_FRAG,
  GLOW_FRAG,
  GLOW_VERT,
  ORBIT_FRAG,
  ORBIT_VERT,
  PLANET_VERT,
  STARS_FRAG,
  STARS_VERT,
  buildPlanetShader,
  buildRingShader,
  buildSunShader,
} from './shaders'

/** オーバービューの視点 */
const OVERVIEW = { azimuth: -Math.PI / 2, incl: (35 * Math.PI) / 180, radius: 78 }
const OVERVIEW_RADIUS_RANGE = [34, 140] as const
/** 時間の速さ（日/実秒）。引いて見る=速く、寄る=ゆっくり */
const DAYS_OVERVIEW = 30
const DAYS_CLOSEUP = 3
/** J2000 からの経過日数を今日の実日付から出す（「今日の本当の並び」で始まる） */
const START_DAYS = EPOCH_DAYS
/** 視点遷移の長さ（秒） */
const TRANSITION = 2.0

interface PlanetNode {
  def: PlanetDef
  group: THREE.Group
  tilt: THREE.Group
  mesh: THREE.Mesh
  material: THREE.ShaderMaterial
  state: BodyState
  visPos: THREE.Vector3
  label: HTMLDivElement
}

interface CometNode {
  def: CometDef
  state: BodyState
  visPos: THREE.Vector3
  velDir: THREE.Vector3
  activity: number
  ionMat: THREE.ShaderMaterial
  dustMat: THREE.ShaderMaterial
  coma: THREE.Object3D
  comaMat: THREE.ShaderMaterial
}

export function create(): Work {
  return new SolarWork()
}

class SolarWork implements Work {
  readonly id = 'solar'

  private renderer!: THREE.WebGLRenderer
  private canvas!: HTMLCanvasElement
  private overlay!: HTMLElement
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000)

  private sphereGeom!: THREE.SphereGeometry
  private planets: PlanetNode[] = []
  private sunMaterial!: THREE.ShaderMaterial
  private moonMesh!: THREE.Mesh
  private moonMaterial!: THREE.ShaderMaterial
  private moonAngle = Math.random() * Math.PI * 2
  private ringMaterial: THREE.ShaderMaterial | null = null
  private beltMaterial!: THREE.ShaderMaterial
  private starsMaterial!: THREE.ShaderMaterial
  private glowMaterials: THREE.ShaderMaterial[] = []
  private orbitMaterials: THREE.ShaderMaterial[] = []
  private geometries: THREE.BufferGeometry[] = []
  private comets: CometNode[] = []

  private sceneRT!: THREE.WebGLRenderTarget
  private bloomA!: THREE.WebGLRenderTarget
  private bloomB!: THREE.WebGLRenderTarget
  private brightPass!: Pass
  private blurPass!: Pass
  private compositePass!: Pass
  private internalScale = 1
  private bloomTexel = new THREE.Vector2()

  // カメラ状態（metro と同じ球座標+慣性モデルを focus 点回りに）
  private azimuth = OVERVIEW.azimuth
  private incl = OVERVIEW.incl
  private radius = OVERVIEW.radius
  private azVel = 0
  private inclVel = 0
  private autoWeight = 1
  private focusIndex = -1
  private focusPoint = new THREE.Vector3()
  /** 視点遷移。transT >= 1 で定常 */
  private transT = 1
  private fromPoint = new THREE.Vector3()
  private fromRadius = OVERVIEW.radius
  private toRadius = OVERVIEW.radius
  private fromAz = OVERVIEW.azimuth
  private toAz = OVERVIEW.azimuth
  private fromIncl = OVERVIEW.incl
  private toIncl = OVERVIEW.incl

  private simDays = START_DAYS
  private daysPerSec = DAYS_OVERVIEW
  private wheelOutAccum = 0

  private dragging = false
  private dragDX = 0
  private dragDY = 0
  private lastDrag = { x: 0, y: 0 }
  private pressAt: { x: number; y: number; time: number } | null = null

  private tourActive = false
  private tourStep = -1
  private tourTimer = 0

  private badge: HTMLElement | null = null
  private badgeText = ''
  private ui: HTMLElement | null = null

  mount(ctx: WorkContext): void {
    const { renderer, quality } = ctx
    this.renderer = renderer
    this.canvas = renderer.domElement
    this.overlay = ctx.overlay
    this.camera.aspect = ctx.width / ctx.height

    const sphereSegsW = quality.pick(96, 64, 48)
    const sphereSegsH = quality.pick(64, 48, 32)
    const octaves = quality.pick(5, 4, 3)
    const beltCount = quality.pick(40000, 18000, 7000)
    const cometCount = quality.pick(3, 3, 2)
    const tailCount = quality.pick(1700, 850, 450)
    this.internalScale = quality.pick(1, 0.85, 0.7)
    const bloomStrength = quality.pick(0.9, 0.7, 0.55)
    const ringSegs = quality.pick(256, 192, 128)

    this.sphereGeom = new THREE.SphereGeometry(1, sphereSegsW, sphereSegsH)
    this.geometries.push(this.sphereGeom)

    this.buildStars()
    this.buildSun(octaves)
    this.buildPlanets(octaves, ringSegs)
    this.buildMoon(octaves)
    this.buildBelt(beltCount)
    this.buildComets(cometCount, tailCount)

    const half: { type: THREE.TextureDataType; filter: THREE.MagnificationTextureFilter } = {
      type: THREE.HalfFloatType,
      filter: THREE.LinearFilter,
    }
    // 惑星・輪・帯の前後関係が要るので、シーン RT だけは depth 付きで直接作る
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    })
    this.sceneRT.texture.generateMipmaps = false
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

  private buildStars(): void {
    const geom = new THREE.SphereGeometry(600, 16, 12)
    this.geometries.push(geom)
    this.starsMaterial = new THREE.ShaderMaterial({
      vertexShader: STARS_VERT,
      fragmentShader: STARS_FRAG,
      uniforms: {},
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    })
    const stars = new THREE.Mesh(geom, this.starsMaterial)
    stars.frustumCulled = false
    stars.renderOrder = -10
    this.scene.add(stars)
  }

  private buildSun(octaves: number): void {
    this.sunMaterial = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: buildSunShader(octaves),
      uniforms: { uCamPosObj: { value: new THREE.Vector3() }, uTime: { value: 0 } },
    })
    const sun = new THREE.Mesh(this.sphereGeom, this.sunMaterial)
    sun.scale.setScalar(SUN_RADIUS)
    sun.frustumCulled = false
    this.scene.add(sun)
    // ビルボードのグロー（low ティアのブルーム弱めでも輝きを保つ）
    this.addGlow(this.scene, 7.5, new THREE.Color(1, 0.72, 0.35), 1.6)
  }

  private addGlow(parent: THREE.Object3D, size: number, color: THREE.Color, intensity: number): THREE.ShaderMaterial {
    const geom = new THREE.PlaneGeometry(2, 2)
    this.geometries.push(geom)
    const material = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      uniforms: {
        uSize: { value: size },
        uColor: { value: color },
        uIntensity: { value: intensity },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.glowMaterials.push(material)
    const mesh = new THREE.Mesh(geom, material)
    mesh.frustumCulled = false
    mesh.renderOrder = 8
    parent.add(mesh)
    return material
  }

  private buildPlanets(octaves: number, ringSegs: number): void {
    for (const def of PLANETS) {
      const group = new THREE.Group()
      const tilt = new THREE.Group()
      tilt.rotation.z = (def.tilt * Math.PI) / 180
      group.add(tilt)

      const material = new THREE.ShaderMaterial({
        vertexShader: PLANET_VERT,
        fragmentShader: buildPlanetShader(def.id, octaves),
        uniforms: {
          uSunDirObj: { value: new THREE.Vector3(1, 0, 0) },
          uCamPosObj: { value: new THREE.Vector3(0, 0, 5) },
          uTime: { value: 0 },
        },
      })
      const mesh = new THREE.Mesh(this.sphereGeom, material)
      mesh.scale.setScalar(def.radius)
      mesh.frustumCulled = false
      tilt.add(mesh)

      if (def.id === 'saturn') {
        const ringGeom = new THREE.RingGeometry(1.24, 2.3, ringSegs, 4)
        ringGeom.rotateX(-Math.PI / 2)
        this.geometries.push(ringGeom)
        this.ringMaterial = new THREE.ShaderMaterial({
          vertexShader: PLANET_VERT,
          fragmentShader: buildRingShader(Math.min(octaves, 4)),
          uniforms: { uSunDirObj: { value: new THREE.Vector3(1, 0, 0) } },
          transparent: true,
          depthTest: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        })
        const ring = new THREE.Mesh(ringGeom, this.ringMaterial)
        ring.scale.setScalar(def.radius)
        ring.frustumCulled = false
        ring.renderOrder = 5
        tilt.add(ring)
      }

      this.scene.add(group)

      // 軌道線（開始時点の要素で固定。永年変化はデモ時間では見えない）
      const pts = orbitLinePoints(def, START_DAYS, 192)
      this.addOrbitLine(pts, new THREE.Color(def.accent), 0.16)

      // 惑星名の DOM ラベル（HDR 経路に乗せると文字が滲むため DOM で出す）
      const label = document.createElement('div')
      label.textContent = def.name
      label.style.cssText =
        'position:absolute;left:0;top:0;font-size:11px;color:rgba(235,240,255,0.82);' +
        'text-shadow:0 0 6px rgba(0,0,0,0.9);white-space:nowrap;display:none;' +
        'transform:translate3d(-100px,-100px,0);will-change:transform'
      this.overlay.append(label)

      this.planets.push({
        def,
        group,
        tilt,
        mesh,
        material,
        state: { posAU: new THREE.Vector3(), rAU: 1 },
        visPos: new THREE.Vector3(),
        label,
      })
    }
  }

  private buildMoon(octaves: number): void {
    this.moonMaterial = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: buildPlanetShader('moon', Math.min(octaves, 4)),
      uniforms: {
        uSunDirObj: { value: new THREE.Vector3(1, 0, 0) },
        uCamPosObj: { value: new THREE.Vector3(0, 0, 5) },
        uTime: { value: 0 },
      },
    })
    this.moonMesh = new THREE.Mesh(this.sphereGeom, this.moonMaterial)
    this.moonMesh.scale.setScalar(MOON.radius)
    this.moonMesh.frustumCulled = false
    const earth = this.planets.find((p) => p.def.id === 'earth')
    if (earth) {
      earth.group.add(this.moonMesh)
      // 月の軌道円
      const pts = new Float32Array(65 * 3)
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2
        pts.set([Math.cos(a) * MOON.orbitRadius, 0, Math.sin(a) * MOON.orbitRadius], i * 3)
      }
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.BufferAttribute(pts, 3))
      geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
      this.geometries.push(geom)
      const material = new THREE.ShaderMaterial({
        vertexShader: ORBIT_VERT,
        fragmentShader: ORBIT_FRAG,
        uniforms: { uTint: { value: new THREE.Color(0.08, 0.09, 0.12) } },
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      this.orbitMaterials.push(material)
      const line = new THREE.Line(geom, material)
      line.frustumCulled = false
      line.renderOrder = -5
      earth.group.add(line)
    }
  }

  private addOrbitLine(pts: Float32Array, color: THREE.Color, strength: number): void {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.geometries.push(geom)
    const material = new THREE.ShaderMaterial({
      vertexShader: ORBIT_VERT,
      fragmentShader: ORBIT_FRAG,
      uniforms: { uTint: { value: color.clone().multiplyScalar(strength) } },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.orbitMaterials.push(material)
    const line = new THREE.LineLoop(geom, material)
    line.frustumCulled = false
    line.renderOrder = -5
    this.scene.add(line)
  }

  private buildBelt(count: number): void {
    const { els, axes1, axes2 } = buildBeltAttributes(count)
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    geom.setAttribute('aEls', new THREE.BufferAttribute(els, 4))
    geom.setAttribute('aAxes1', new THREE.BufferAttribute(axes1, 4))
    geom.setAttribute('aAxes2', new THREE.BufferAttribute(axes2, 4))
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.geometries.push(geom)
    this.beltMaterial = new THREE.ShaderMaterial({
      vertexShader: BELT_VERT,
      fragmentShader: BELT_FRAG,
      uniforms: {
        uDays: { value: 0 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const points = new THREE.Points(geom, this.beltMaterial)
    points.frustumCulled = false
    points.renderOrder = 6
    this.scene.add(points)
  }

  private buildComets(cometCount: number, tailCount: number): void {
    const ionCount = Math.round(tailCount * 0.4)
    const dustCount = tailCount - ionCount
    for (let c = 0; c < cometCount; c++) {
      const def = COMETS[c]
      const makeTail = (
        n: number,
        curve: number,
        lenBase: number,
        lenGain: number,
        spread: number,
        color: THREE.Color,
      ) => {
        const geom = new THREE.BufferGeometry()
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
        const rand = new Float32Array(n * 4)
        for (let i = 0; i < n; i++) {
          rand.set([Math.pow(Math.random(), 1.4), Math.random(), Math.random(), Math.random()], i * 4)
        }
        geom.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))
        geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
        this.geometries.push(geom)
        const material = new THREE.ShaderMaterial({
          vertexShader: COMET_TAIL_VERT,
          fragmentShader: COMET_TAIL_FRAG,
          uniforms: {
            uCometPos: { value: new THREE.Vector3() },
            uAntiSun: { value: new THREE.Vector3(1, 0, 0) },
            uVelDir: { value: new THREE.Vector3(1, 0, 0) },
            uActivity: { value: 0 },
            uTime: { value: 0 },
            uCurve: { value: curve },
            uLenBase: { value: lenBase },
            uLenGain: { value: lenGain },
            uSpread: { value: spread },
            uPixelRatio: { value: this.renderer.getPixelRatio() },
            uColor: { value: color },
          },
          transparent: true,
          depthTest: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
        const points = new THREE.Points(geom, material)
        points.frustumCulled = false
        points.renderOrder = 7
        this.scene.add(points)
        return material
      }

      // イオンテイル（青白・直線）とダストテイル（黄白・曲がる）
      const ionMat = makeTail(ionCount, 0, 2.5, 5.5, 0.5, new THREE.Color(0.45, 0.75, 1.0))
      const dustMat = makeTail(dustCount, 1.4, 1.8, 3.5, 0.9, new THREE.Color(1.0, 0.9, 0.7))
      const comaAnchor = new THREE.Group()
      this.scene.add(comaAnchor)
      const comaMat = this.addGlow(comaAnchor, 1.6, new THREE.Color(0.75, 0.9, 1.0), 0)

      // 彗星の軌道線（さらに薄く）
      this.addOrbitLine(orbitLinePoints(def, START_DAYS, 256), new THREE.Color(0.6, 0.8, 1.0), 0.05)

      this.comets.push({
        def,
        state: { posAU: new THREE.Vector3(), rAU: 5 },
        visPos: new THREE.Vector3(),
        velDir: new THREE.Vector3(1, 0, 0),
        activity: 0,
        ionMat,
        dustMat,
        coma: comaAnchor,
        comaMat,
      })
    }
  }

  private buildUI(overlay: HTMLElement): void {
    const bar = overlay.querySelector<HTMLElement>('.work__bar')
    if (bar) {
      this.badge = el('span', { class: 'badge' }, [''])
      bar.append(this.badge)
    }
    const controls = overlay.querySelector<HTMLElement>('.work__controls')
    if (!controls) return
    this.ui = el('div', { class: 'work__controls' }, [
      el('button', { class: 'chip', type: 'button', onclick: () => this.goOverview() }, [
        '全体を見る',
      ]),
    ])
    controls.append(this.ui)
  }

  /** 惑星クローズアップへ飛ぶ。 */
  private focusPlanet(index: number): void {
    const p = this.planets[index]
    this.focusIndex = index
    this.transT = 0
    this.fromPoint.copy(this.focusPoint)
    this.fromRadius = this.radius
    const R = p.def.radius
    this.toRadius = p.def.id === 'saturn' ? 7 * R : Math.min(Math.max(4.5 * R, 1.2), 12)
    // 到着方位は昼側（太陽—惑星の線から少しずらす）
    const sunDir = p.visPos.clone().multiplyScalar(-1).normalize()
    this.fromAz = this.azimuth
    this.toAz = Math.atan2(sunDir.z, sunDir.x) + 0.7
    this.fromIncl = this.incl
    this.toIncl = 0.3
    this.azVel = 0
    this.inclVel = 0
    this.wheelOutAccum = 0
  }

  private goOverview(): void {
    if (this.focusIndex < 0 && this.transT >= 1) return
    this.focusIndex = -1
    this.transT = 0
    this.fromPoint.copy(this.focusPoint)
    this.fromRadius = this.radius
    this.toRadius = OVERVIEW.radius
    this.fromAz = this.azimuth
    this.toAz = this.azimuth + 0.3
    this.fromIncl = this.incl
    this.toIncl = OVERVIEW.incl
    this.azVel = 0
    this.inclVel = 0
  }

  private stopTour(): void {
    this.tourActive = false
    this.tourStep = -1
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    this.stopTour()
    let pixels = event.deltaY
    if (event.deltaMode === 1) pixels *= 33
    else if (event.deltaMode === 2) pixels *= 300
    pixels = clamp(pixels, -300, 300)
    const factor = Math.exp(pixels * 0.0016)
    if (this.focusIndex >= 0) {
      const R = this.planets[this.focusIndex].def.radius
      const maxR = 14 * R + 2
      const next = this.radius * factor
      if (next > maxR) {
        // 上限に張り付いてさらに引いたら全体へ戻る
        this.wheelOutAccum += Math.max(0, pixels)
        if (this.wheelOutAccum > 200) this.goOverview()
        this.radius = maxR
      } else {
        this.wheelOutAccum = 0
        this.radius = Math.max(next, 2.2 * R)
      }
    } else {
      this.radius = clamp(this.radius * factor, OVERVIEW_RADIUS_RANGE[0], OVERVIEW_RADIUS_RANGE[1])
    }
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    this.stopTour()
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
    if (moved < 9 && performance.now() - press.time < 350) {
      this.handleClick(event.clientX, event.clientY)
    }
  }

  /** クリックした惑星へ寄る。スクリーン距離で判定（数pxの水星も掴める）。 */
  private handleClick(clientX: number, clientY: number): void {
    const width = Math.max(1, window.innerWidth)
    const height = Math.max(1, window.innerHeight)
    const v = new THREE.Vector3()
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < this.planets.length; i++) {
      const p = this.planets[i]
      v.copy(p.visPos).project(this.camera)
      if (v.z > 1 || v.z < -1) continue
      const sx = (v.x * 0.5 + 0.5) * width
      const sy = (-v.y * 0.5 + 0.5) * height
      const dist = Math.hypot(sx - clientX, sy - clientY)
      // 見かけの大きさに応じた当たり判定
      const apparent =
        ((p.def.radius / Math.max(0.1, p.visPos.distanceTo(this.camera.position))) * height) / 1.0
      const threshold = Math.max(28, apparent * 1.5)
      if (dist < threshold && dist < bestDist) {
        bestDist = dist
        best = i
      }
    }
    if (best >= 0 && best !== this.focusIndex) this.focusPlanet(best)
    else if (best < 0 && this.focusIndex >= 0) this.goOverview()
  }

  update(dt: number, elapsed: number): void {
    const step = Math.min(dt, 1 / 30)

    // 時間の速さはモード連動（引くと速く、寄るとゆっくり）
    const targetDays = this.focusIndex >= 0 ? DAYS_CLOSEUP : DAYS_OVERVIEW
    this.daysPerSec += (targetDays - this.daysPerSec) * Math.min(1, step * 1.4)
    this.simDays += this.daysPerSec * step

    // 放置演出: 自動周回と、15秒放置で惑星巡りのツアー
    const wantAuto = !this.dragging && pointer.idleFor(4000) ? 1 : 0
    this.autoWeight += (wantAuto - this.autoWeight) * Math.min(1, step * 1.5)
    this.azimuth += (this.focusIndex >= 0 ? 0.06 : 0.02) * this.autoWeight * step
    this.updateTour(step)

    // ドラッグと慣性
    const height = Math.max(1, window.innerHeight)
    if (this.dragging) {
      const dAz = (this.dragDX * 2.6) / height
      const dIn = (this.dragDY * 2.0) / height
      this.azimuth += dAz
      this.incl = clampIncl(this.incl + dIn, this.focusIndex >= 0)
      this.azVel = 0.65 * this.azVel + 0.35 * (dAz / Math.max(step, 1e-3))
      this.inclVel = 0.65 * this.inclVel + 0.35 * (dIn / Math.max(step, 1e-3))
      this.dragDX = 0
      this.dragDY = 0
    } else {
      this.azimuth += this.azVel * step
      this.incl = clampIncl(this.incl + this.inclVel * step, this.focusIndex >= 0)
      const damp = Math.exp(-2.5 * step)
      this.azVel *= damp
      this.inclVel *= damp
    }

    this.updateBodies(step, elapsed)
    this.updateCameraAndFocus(step)
    this.scene.updateMatrixWorld(true)
    this.updateShaderSpaces(elapsed)
    this.updateLabels()
    this.updateBadge()

    // 描画: シーン → HDR RT → ブルーム → 合成
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

  /** 放置ツアー: 地球→火星→木星→土星→海王星→全体、を巡回。 */
  private updateTour(step: number): void {
    const STOPS: (PlanetDef['id'] | 'overview')[] = [
      'earth',
      'mars',
      'jupiter',
      'saturn',
      'neptune',
      'overview',
    ]
    if (!this.tourActive) {
      if (pointer.idleFor(15000)) {
        this.tourActive = true
        this.tourStep = -1
        this.tourTimer = 0
      }
      return
    }
    this.tourTimer -= step
    if (this.tourTimer > 0) return
    this.tourStep = (this.tourStep + 1) % STOPS.length
    const stop = STOPS[this.tourStep]
    if (stop === 'overview') {
      this.goOverview()
      this.tourTimer = 10
    } else {
      const index = this.planets.findIndex((p) => p.def.id === stop)
      if (index >= 0) this.focusPlanet(index)
      this.tourTimer = 10.5
    }
  }

  /** 惑星・月・彗星の位置と自転。 */
  private updateBodies(step: number, elapsed: number): void {
    for (const p of this.planets) {
      planetState(p.def, this.simDays, p.state)
      toVisual(p.state.posAU, p.visPos)
      p.group.position.copy(p.visPos)
      p.mesh.rotation.y = ((elapsed / Math.abs(p.def.spinPeriod)) * Math.PI * 2) *
        Math.sign(p.def.spinPeriod)
    }

    // 月: 物理レートを角速度上限でクランプ（オーバービューでのストロボ化防止。
    // 位相のずれは装飾なので許容する）
    const moonRate = (Math.PI * 2 * this.daysPerSec) / MOON.periodDays
    this.moonAngle += Math.min(moonRate, 1.5) * step
    this.moonMesh.position.set(
      Math.cos(this.moonAngle) * MOON.orbitRadius,
      0,
      Math.sin(this.moonAngle) * MOON.orbitRadius,
    )

    const tmp = new THREE.Vector3()
    for (const c of this.comets) {
      cometState(c.def, this.simDays, c.state)
      toVisual(c.state.posAU, c.visPos)
      // 軌道速度の向き（数値微分）
      cometState(c.def, this.simDays + 1, { posAU: tmp, rAU: 0 } as BodyState)
      toVisual(tmp, tmp)
      c.velDir.copy(tmp).sub(c.visPos).normalize()
      // 近日点で活発になる
      const r = c.state.rAU
      c.activity = smoothstepJs(4.5, 2.0, r) * Math.min(1.4, (1.6 / r) * (1.6 / r))

      const antiSun = c.visPos.clone().normalize()
      for (const mat of [c.ionMat, c.dustMat]) {
        ;(mat.uniforms.uCometPos.value as THREE.Vector3).copy(c.visPos)
        ;(mat.uniforms.uAntiSun.value as THREE.Vector3).copy(antiSun)
        ;(mat.uniforms.uVelDir.value as THREE.Vector3).copy(c.velDir)
        mat.uniforms.uActivity.value = c.activity
        mat.uniforms.uTime.value = elapsed
      }
      c.coma.position.copy(c.visPos)
      c.comaMat.uniforms.uIntensity.value = 0.4 + 2.2 * c.activity
    }
  }

  /** 視点遷移と focus 追従。 */
  private updateCameraAndFocus(step: number): void {
    if (this.transT < 1) {
      this.transT = Math.min(1, this.transT + step / TRANSITION)
      const e = smoothstepJs(0, 1, this.transT)
      const target = this.focusIndex >= 0 ? this.planets[this.focusIndex].visPos : ORIGIN
      this.focusPoint.lerpVectors(this.fromPoint, target, e)
      this.radius = this.fromRadius + (this.toRadius - this.fromRadius) * e
      this.azimuth = this.fromAz + shortestAngle(this.fromAz, this.toAz) * e
      this.incl = this.fromIncl + (this.toIncl - this.fromIncl) * e
    } else if (this.focusIndex >= 0) {
      this.focusPoint.copy(this.planets[this.focusIndex].visPos)
    } else {
      this.focusPoint.lerp(ORIGIN, Math.min(1, step * 2))
    }

    const incl = clampIncl(this.incl, this.focusIndex >= 0)
    const ce = Math.cos(incl)
    this.camera.position
      .set(Math.cos(this.azimuth) * ce, Math.sin(incl), Math.sin(this.azimuth) * ce)
      .multiplyScalar(this.radius)
      .add(this.focusPoint)
    this.camera.lookAt(this.focusPoint)
    this.camera.updateMatrixWorld()
  }

  /** 各天体の object 空間へ太陽方向とカメラ位置を変換して渡す。 */
  private updateShaderSpaces(elapsed: number): void {
    const q = new THREE.Quaternion()
    const dir = new THREE.Vector3()
    const camLocal = new THREE.Vector3()

    for (const p of this.planets) {
      p.mesh.getWorldQuaternion(q)
      q.invert()
      dir.copy(p.visPos).multiplyScalar(-1).normalize().applyQuaternion(q)
      ;(p.material.uniforms.uSunDirObj.value as THREE.Vector3).copy(dir)
      camLocal.copy(this.camera.position)
      p.mesh.worldToLocal(camLocal)
      ;(p.material.uniforms.uCamPosObj.value as THREE.Vector3).copy(camLocal)
      p.material.uniforms.uTime.value = elapsed
    }
    if (this.ringMaterial) {
      const saturn = this.planets.find((p) => p.def.id === 'saturn')
      if (saturn) {
        saturn.tilt.getWorldQuaternion(q)
        q.invert()
        dir.copy(saturn.visPos).multiplyScalar(-1).normalize().applyQuaternion(q)
        ;(this.ringMaterial.uniforms.uSunDirObj.value as THREE.Vector3).copy(dir)
      }
    }
    // 月
    const moonWorld = new THREE.Vector3()
    this.moonMesh.getWorldPosition(moonWorld)
    this.moonMesh.getWorldQuaternion(q)
    q.invert()
    dir.copy(moonWorld).multiplyScalar(-1).normalize().applyQuaternion(q)
    ;(this.moonMaterial.uniforms.uSunDirObj.value as THREE.Vector3).copy(dir)
    camLocal.copy(this.camera.position)
    this.moonMesh.worldToLocal(camLocal)
    ;(this.moonMaterial.uniforms.uCamPosObj.value as THREE.Vector3).copy(camLocal)
    this.moonMaterial.uniforms.uTime.value = elapsed

    // 太陽
    camLocal.copy(this.camera.position).divideScalar(SUN_RADIUS)
    ;(this.sunMaterial.uniforms.uCamPosObj.value as THREE.Vector3).copy(camLocal)
    this.sunMaterial.uniforms.uTime.value = elapsed

    this.beltMaterial.uniforms.uDays.value = this.simDays % 100000
  }

  /** 惑星名の DOM ラベル。オーバービューのときだけ出す。 */
  private updateLabels(): void {
    const width = Math.max(1, window.innerWidth)
    const height = Math.max(1, window.innerHeight)
    const v = new THREE.Vector3()
    const show = this.focusIndex < 0 && this.transT >= 0.6
    for (const p of this.planets) {
      if (!show) {
        p.label.style.display = 'none'
        continue
      }
      v.copy(p.visPos)
      v.y += p.def.radius + 0.4
      v.project(this.camera)
      if (v.z > 1 || v.z < -1) {
        p.label.style.display = 'none'
        continue
      }
      const sx = (v.x * 0.5 + 0.5) * width
      const sy = (-v.y * 0.5 + 0.5) * height
      p.label.style.display = 'block'
      p.label.style.transform = `translate3d(${Math.round(sx)}px, ${Math.round(sy - 14)}px, 0) translateX(-50%)`
    }
  }

  private updateBadge(): void {
    if (!this.badge) return
    const year = Math.floor(2000 + this.simDays / 365.25)
    const name = this.focusIndex >= 0 ? this.planets[this.focusIndex].def.name : ''
    const text = name ? `${name} ・ 西暦${year}年` : `西暦${year}年`
    if (text !== this.badgeText) {
      this.badgeText = text
      this.badge.textContent = text
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    const ratio = this.renderer.getPixelRatio()
    this.beltMaterial.uniforms.uPixelRatio.value = ratio
    for (const c of this.comets) {
      c.ionMat.uniforms.uPixelRatio.value = ratio
      c.dustMat.uniforms.uPixelRatio.value = ratio
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
    this.ui?.remove()
    for (const p of this.planets) {
      p.label.remove()
      p.material.dispose()
    }
    this.sunMaterial.dispose()
    this.moonMaterial.dispose()
    this.ringMaterial?.dispose()
    this.beltMaterial.dispose()
    this.starsMaterial.dispose()
    for (const m of this.glowMaterials) m.dispose()
    for (const m of this.orbitMaterials) m.dispose()
    for (const c of this.comets) {
      c.ionMat.dispose()
      c.dustMat.dispose()
    }
    for (const g of this.geometries) g.dispose()
    this.sceneRT.dispose()
    this.bloomA.dispose()
    this.bloomB.dispose()
    for (const pass of [this.brightPass, this.blurPass, this.compositePass]) pass.dispose()
  }
}

const ORIGIN = new THREE.Vector3(0, 0, 0)

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 仰角のクランプ。クローズアップでは下からのぞき込むのも許す。 */
function clampIncl(value: number, closeup: boolean): number {
  const limit = (80 * Math.PI) / 180
  const min = closeup ? -limit : (8 * Math.PI) / 180
  return clamp(value, min, limit)
}

function smoothstepJs(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** 角度差を [-π, π] に畳む。 */
function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}
