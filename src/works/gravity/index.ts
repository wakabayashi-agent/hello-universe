import * as THREE from 'three'

import type { Work, WorkContext } from '../../core/Work'
import {
  Pass,
  PingPong,
  createDataTexture,
  createReferenceAttribute,
  fullscreenCamera,
  seedPingPong,
} from '../../core/gpu'
import { el } from '../../ui/dom'
import {
  DISPLAY_FRAG,
  FADE_FRAG,
  INJECT_FRAG,
  POSITION_FRAG,
  RENDER_FRAG,
  RENDER_VERT,
  TRAIL_FRAG,
  TRAIL_VERT,
  buildVelocityShader,
} from './shaders'

/** 画面の高さがワールド座標で何単位ぶんか。 */
const VIEW_HALF_HEIGHT = 18
const BOUNDS = 26
const GRAVITY = 0.35
const SUN_MASS = 1200
const COMPANION_MASS = 220
const DUST_MASS = 0.05
/** クリックで置く星の質量。周りを揺らせる程度に重く、系を壊さない程度に軽く */
const SEED_MASS = 26

export function create(): Work {
  return new GravityWork()
}

class GravityWork implements Work {
  readonly id = 'gravity'

  private renderer!: THREE.WebGLRenderer
  private size = 40
  private count = 1600

  private position!: PingPong
  private velocity!: PingPong
  private trail!: PingPong
  private velocityPass!: Pass
  private positionPass!: Pass
  private injectPass!: Pass
  private fadePass!: Pass
  private displayPass!: Pass

  private pointsScene = new THREE.Scene()
  private points!: THREE.Points
  private pointsMaterial!: THREE.ShaderMaterial
  private streaks!: THREE.LineSegments
  private streakMaterial!: THREE.ShaderMaterial

  private aspect = 1
  private injectIndex = 2
  private pressAt: { x: number; y: number } | null = null
  private canvas!: HTMLCanvasElement
  private ui: HTMLElement | null = null

  mount(ctx: WorkContext): void {
    const { renderer, quality } = ctx
    this.renderer = renderer
    this.canvas = renderer.domElement
    this.aspect = ctx.width / ctx.height

    // 総当たり計算なので計算量は粒子数の2乗。ここは控えめに刻む
    this.size = quality.pick(40, 28, 20)
    this.count = this.size * this.size

    this.position = new PingPong(this.size, this.size)
    this.velocity = new PingPong(this.size, this.size)

    const initial = this.buildInitialState()
    const posTexture = createDataTexture(initial.position, this.size, this.size)
    const velTexture = createDataTexture(initial.velocity, this.size, this.size)
    seedPingPong(renderer, this.position, posTexture)
    seedPingPong(renderer, this.velocity, velTexture)
    posTexture.dispose()
    velTexture.dispose()

    this.velocityPass = new Pass(buildVelocityShader(this.size), {
      uPosition: { value: null },
      uVelocity: { value: null },
      uDt: { value: 0 },
      uTexSize: { value: this.size },
      uGravity: { value: GRAVITY },
      uBounds: { value: BOUNDS },
    })
    this.positionPass = new Pass(POSITION_FRAG, {
      uPosition: { value: null },
      uVelocity: { value: null },
      uDt: { value: 0 },
      uBounds: { value: BOUNDS },
    })
    this.injectPass = new Pass(INJECT_FRAG, {
      uSource: { value: null },
      uTarget: { value: new THREE.Vector2() },
      uTexel: { value: 1 / this.size },
      uValue: { value: new THREE.Vector4() },
    })
    this.fadePass = new Pass(FADE_FRAG, {
      uSource: { value: null },
      uFade: { value: 0.945 },
    })
    this.displayPass = new Pass(DISPLAY_FRAG, { uSource: { value: null } })

    // 軌跡を溜めるバッファ。HDR で貯めたいので half float
    this.trail = new PingPong(1, 1, {
      type: THREE.HalfFloatType,
      filter: THREE.LinearFilter,
    })

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(this.count * 3), 3),
    )
    geometry.setAttribute('aRef', createReferenceAttribute(this.size))
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

    this.pointsMaterial = new THREE.ShaderMaterial({
      vertexShader: RENDER_VERT,
      fragmentShader: RENDER_FRAG,
      uniforms: {
        uPosition: { value: null },
        uVelocity: { value: null },
        uScale: { value: 1 / VIEW_HALF_HEIGHT },
        uAspect: { value: this.aspect },
        uPixelRatio: { value: quality.pixelRatio },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.points = new THREE.Points(geometry, this.pointsMaterial)
    this.points.frustumCulled = false
    this.pointsScene.add(this.points)

    // 星ごとに「前フレームの位置 → 現在位置」を結ぶ線分を1本ずつ用意する
    const streakGeometry = new THREE.BufferGeometry()
    const refs = createReferenceAttribute(this.size).array as Float32Array
    const streakRefs = new Float32Array(this.count * 4)
    const sides = new Float32Array(this.count * 2)
    for (let i = 0; i < this.count; i++) {
      streakRefs[i * 4] = refs[i * 2]
      streakRefs[i * 4 + 1] = refs[i * 2 + 1]
      streakRefs[i * 4 + 2] = refs[i * 2]
      streakRefs[i * 4 + 3] = refs[i * 2 + 1]
      sides[i * 2] = 0
      sides[i * 2 + 1] = 1
    }
    streakGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(this.count * 6), 3),
    )
    streakGeometry.setAttribute('aRef', new THREE.BufferAttribute(streakRefs, 2))
    streakGeometry.setAttribute('aSide', new THREE.BufferAttribute(sides, 1))
    streakGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

    this.streakMaterial = new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      uniforms: {
        uPosition: { value: null },
        uVelocity: { value: null },
        uScale: { value: 1 / VIEW_HALF_HEIGHT },
        uAspect: { value: this.aspect },
        uTrailDt: { value: 1 / 60 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.streaks = new THREE.LineSegments(streakGeometry, this.streakMaterial)
    this.streaks.frustumCulled = false
    this.pointsScene.add(this.streaks)

    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointerup', this.onPointerUp)

    this.buildUI(ctx.overlay)
    this.resize(ctx.width, ctx.height)
  }

  private buildUI(overlay: HTMLElement): void {
    const controls = overlay.querySelector<HTMLElement>('.work__controls')
    if (!controls) return
    this.ui = el('div', { class: 'work__controls' }, [
      el('button', { class: 'chip', type: 'button', onclick: () => this.reset() }, ['やり直す']),
    ])
    controls.append(this.ui)
  }

  /**
   * 初期配置：中心の太陽 + 伴星 + それを回る塵の円盤。
   * 伴星が円盤をかき混ぜて、勝手に渦ができる。
   */
  private buildInitialState(): { position: Float32Array; velocity: Float32Array } {
    const position = new Float32Array(this.count * 4)
    const velocity = new Float32Array(this.count * 4)

    const setBody = (i: number, x: number, y: number, vx: number, vy: number, mass: number) => {
      position[i * 4] = x
      position[i * 4 + 1] = y
      position[i * 4 + 2] = 0
      position[i * 4 + 3] = mass
      velocity[i * 4] = vx
      velocity[i * 4 + 1] = vy
    }

    // 0番＝太陽、1番＝伴星。二体が共通重心を回るよう運動量をゼロに揃える
    const companionR = 15
    const totalMass = SUN_MASS + COMPANION_MASS
    const relativeSpeed = Math.sqrt((GRAVITY * totalMass) / companionR)
    const sunSpeed = (relativeSpeed * COMPANION_MASS) / totalMass
    const companionSpeed = (relativeSpeed * SUN_MASS) / totalMass

    setBody(0, 0, 0, 0, -sunSpeed, SUN_MASS)
    setBody(1, companionR, 0, 0, companionSpeed, COMPANION_MASS)

    for (let i = 2; i < this.count; i++) {
      // 太陽のまわりの円盤と、二重星ぜんたいを回る外側の環
      const outer = i % 6 === 0
      const radius = outer
        ? 21 + Math.random() * 4
        : 2.2 + Math.pow(Math.random(), 0.75) * 7.5
      const angle = Math.random() * Math.PI * 2
      const enclosed = outer ? totalMass : SUN_MASS
      // その半径で円軌道になる速さ。少しばらつかせて楕円軌道も混ぜる
      const speed = Math.sqrt((GRAVITY * enclosed) / radius) * (0.95 + Math.random() * 0.1)
      // 内側の円盤は太陽と一緒に動く。
      // 太陽が止まっている前提で速度を与えると、円盤ごと置いていかれて散る
      const carryY = outer ? 0 : -sunSpeed
      setBody(
        i,
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
        -Math.sin(angle) * speed,
        Math.cos(angle) * speed + carryY,
        DUST_MASS,
      )
    }

    // 全体の重心を原点に、全体の運動量をゼロに揃える。
    // やらないと系そのものが画面外へ流れていってしまう
    let systemMass = 0
    let cx = 0
    let cy = 0
    let px = 0
    let py = 0
    for (let i = 0; i < this.count; i++) {
      const m = position[i * 4 + 3]
      systemMass += m
      cx += position[i * 4] * m
      cy += position[i * 4 + 1] * m
      px += velocity[i * 4] * m
      py += velocity[i * 4 + 1] * m
    }
    cx /= systemMass
    cy /= systemMass
    px /= systemMass
    py /= systemMass
    for (let i = 0; i < this.count; i++) {
      position[i * 4] -= cx
      position[i * 4 + 1] -= cy
      velocity[i * 4] -= px
      velocity[i * 4 + 1] -= py
    }

    return { position, velocity }
  }

  private reset(): void {
    const initial = this.buildInitialState()
    const posTexture = createDataTexture(initial.position, this.size, this.size)
    const velTexture = createDataTexture(initial.velocity, this.size, this.size)
    seedPingPong(this.renderer, this.position, posTexture)
    seedPingPong(this.renderer, this.velocity, velTexture)
    posTexture.dispose()
    velTexture.dispose()
    this.injectIndex = 2
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    this.pressAt = { x: event.clientX, y: event.clientY }
  }

  private onPointerUp = (event: PointerEvent): void => {
    const press = this.pressAt
    this.pressAt = null
    if (!press) return

    const world = this.worldAt(press.x, press.y)
    const dragX = event.clientX - press.x
    const dragY = event.clientY - press.y
    const drag = Math.hypot(dragX, dragY)

    let vx: number
    let vy: number
    if (drag < 9) {
      // ただのクリック：その場で周回するちょうどよい速さを与える。
      // 初速ゼロだと太陽へ落ちるだけで面白くない
      const radius = Math.max(1.5, Math.hypot(world.x, world.y))
      const speed = Math.sqrt((GRAVITY * SUN_MASS) / radius)
      vx = (-world.y / radius) * speed
      vy = (world.x / radius) * speed
    } else {
      // ドラッグした向きと長さがそのまま初速になる
      const scale = VIEW_HALF_HEIGHT / Math.max(1, window.innerHeight) * 2.4
      vx = dragX * scale
      vy = -dragY * scale
    }

    this.inject(world.x, world.y, vx, vy)
  }

  /** 画面座標をワールド座標に変換する。 */
  private worldAt(clientX: number, clientY: number): { x: number; y: number } {
    const width = Math.max(1, window.innerWidth)
    const height = Math.max(1, window.innerHeight)
    const ndcX = (clientX / width) * 2 - 1
    const ndcY = -((clientY / height) * 2 - 1)
    return { x: ndcX * VIEW_HALF_HEIGHT * this.aspect, y: ndcY * VIEW_HALF_HEIGHT }
  }

  /** 星を1個、データテクスチャに書き込む。 */
  private inject(x: number, y: number, vx: number, vy: number): void {
    // 0番(太陽)と1番(伴星)は上書きしない
    const index = this.injectIndex
    this.injectIndex = this.injectIndex + 1 >= this.count ? 2 : this.injectIndex + 1

    const target = this.injectPass.uniforms.uTarget.value as THREE.Vector2
    const value = this.injectPass.uniforms.uValue.value as THREE.Vector4
    target.set(((index % this.size) + 0.5) / this.size, (Math.floor(index / this.size) + 0.5) / this.size)

    value.set(x, y, 0, SEED_MASS)
    this.injectPass.set('uSource', this.position.read.texture)
    this.injectPass.render(this.renderer, this.position.write)
    this.position.swap()

    value.set(vx, vy, 0, 1)
    this.injectPass.set('uSource', this.velocity.read.texture)
    this.injectPass.render(this.renderer, this.velocity.write)
    this.velocity.swap()
  }

  update(dt: number): void {
    const step = Math.min(dt, 1 / 45)

    const v = this.velocityPass.uniforms
    v.uPosition.value = this.position.read.texture
    v.uVelocity.value = this.velocity.read.texture
    v.uDt.value = step
    this.velocityPass.render(this.renderer, this.velocity.write)
    this.velocity.swap()

    const p = this.positionPass.uniforms
    p.uPosition.value = this.position.read.texture
    p.uVelocity.value = this.velocity.read.texture
    p.uDt.value = step
    this.positionPass.render(this.renderer, this.position.write)
    this.position.swap()

    // 前フレームの絵を薄めて残し、その上に今の星を重ねる＝軌跡
    this.fadePass.set('uSource', this.trail.read.texture)
    this.fadePass.render(this.renderer, this.trail.write)

    this.pointsMaterial.uniforms.uPosition.value = this.position.read.texture
    this.pointsMaterial.uniforms.uVelocity.value = this.velocity.read.texture
    this.streakMaterial.uniforms.uPosition.value = this.position.read.texture
    this.streakMaterial.uniforms.uVelocity.value = this.velocity.read.texture
    // 尾の長さ＝この1フレームで進んだ距離。こうすると尾が隙間なくつながる
    this.streakMaterial.uniforms.uTrailDt.value = step
    this.renderer.autoClear = false
    this.renderer.setRenderTarget(this.trail.write)
    this.renderer.render(this.pointsScene, fullscreenCamera)
    this.renderer.setRenderTarget(null)
    this.renderer.autoClear = true
    this.trail.swap()

    this.displayPass.set('uSource', this.trail.read.texture)
    this.displayPass.render(this.renderer, null)
  }

  resize(width: number, height: number): void {
    this.aspect = width / height
    this.pointsMaterial.uniforms.uAspect.value = this.aspect
    this.streakMaterial.uniforms.uAspect.value = this.aspect
    const ratio = this.renderer.getPixelRatio()
    this.pointsMaterial.uniforms.uPixelRatio.value = ratio
    this.trail.setSize(Math.round(width * ratio), Math.round(height * ratio))
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.ui?.remove()
    this.pointsScene.remove(this.points)
    this.pointsScene.remove(this.streaks)
    this.points.geometry.dispose()
    this.pointsMaterial.dispose()
    this.streaks.geometry.dispose()
    this.streakMaterial.dispose()
    this.position.dispose()
    this.velocity.dispose()
    this.trail.dispose()
    for (const pass of [
      this.velocityPass,
      this.positionPass,
      this.injectPass,
      this.fadePass,
      this.displayPass,
    ]) {
      pass.dispose()
    }
  }
}
