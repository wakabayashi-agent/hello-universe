import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

import type { Work, WorkContext } from '../../core/Work'
import {
  PingPong,
  Pass,
  createDataTexture,
  createReferenceAttribute,
  seedPingPong,
} from '../../core/gpu'
import { pointer } from '../../core/pointer'
import { el } from '../../ui/dom'
import { POSITION_FRAG, VELOCITY_FRAG, RENDER_VERT, RENDER_FRAG } from './shaders'
import { generateGalaxy, generateShell, sampleText } from './textToPoints'

const WORLD_WIDTH = 15
const GALAXY_RADIUS = 6.0
const DEFAULT_TEXT = 'HELLO,\nUNIVERSE'

/**
 * 19 秒で一巡するタイムライン。
 * 文字に集まる → 保つ → 爆発する → 銀河になる → また文字に戻る。
 * 各パラメータはキーフレーム間を smoothstep で補間する。
 */
interface Key {
  t: number
  spring: number
  damping: number
  noise: number
  /** 銀河の回転の速さ（rad/s）。角度は update で積算する */
  spinRate: number
  morph: number
}

const CYCLE = 19
const BURST_AT = 8.0

const KEYS: Key[] = [
  // 殻から飛んでくる。減衰を弱めにして尾を引かせる
  { t: 0.0, spring: 5.0, damping: 0.93, noise: 1.0, spinRate: 0, morph: 0 },
  { t: 3.0, spring: 11.0, damping: 0.88, noise: 0.6, spinRate: 0, morph: 0 },
  // 文字を保つ区間。ばねを強く・ノイズを小さくしないと字形が潰れる
  { t: 4.5, spring: 17.0, damping: 0.85, noise: 0.35, spinRate: 0, morph: 0 },
  { t: 7.9, spring: 17.0, damping: 0.85, noise: 0.45, spinRate: 0, morph: 0 },
  // 爆発。ばねを切って慣性だけで飛ばす
  { t: 8.4, spring: 0.0, damping: 0.99, noise: 3.0, spinRate: 0.25, morph: 0 },
  { t: 10.6, spring: 2.5, damping: 0.94, noise: 1.4, spinRate: 0.35, morph: 1 },
  // 銀河として回る
  { t: 13.0, spring: 7.0, damping: 0.9, noise: 0.7, spinRate: 0.45, morph: 1 },
  { t: 16.4, spring: 7.0, damping: 0.9, noise: 0.7, spinRate: 0.45, morph: 1 },
  // 銀河がほどけて文字に戻る
  { t: 17.6, spring: 3.2, damping: 0.92, noise: 1.0, spinRate: 0.2, morph: 0 },
  { t: CYCLE, spring: 5.0, damping: 0.93, noise: 1.0, spinRate: 0, morph: 0 },
]

export interface CosmosOptions {
  /** トップページの背景として動かすモード。入力欄を出さず、少し上に寄せる */
  hero?: boolean
  text?: string
}

export function create(options: Record<string, unknown> = {}): Work {
  return new CosmosWork(options as CosmosOptions)
}

class CosmosWork implements Work {
  readonly id = 'cosmos'

  private opts: CosmosOptions
  private renderer!: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera!: THREE.PerspectiveCamera
  private group = new THREE.Group()
  private composer!: EffectComposer
  private bloom: UnrealBloomPass | null = null

  private size = 512
  private count = 512 * 512
  private canvasWidth = 1600

  private position!: PingPong
  private velocity!: PingPong
  private positionPass!: Pass
  private velocityPass!: Pass
  private textTexture!: THREE.DataTexture
  private galaxyTexture!: THREE.DataTexture
  private points!: THREE.Points
  private pointsMaterial!: THREE.ShaderMaterial

  private time = 0
  private spin = 0
  private pendingBurst = 0
  private mouseWorld = new THREE.Vector3(0, 0, -999)
  private mouseTarget = new THREE.Vector3(0, 0, -999)
  private mouseStrength = 0
  private rotX = 0
  private rotY = 0
  private plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  private raycaster = new THREE.Raycaster()

  private baseBrightness = 0.055
  /** 文字が画面に占める割合。少ない文字ほど粒が密になるので明るさを下げる */
  private coverage = 0.17
  private viewHeightPixels = 1080
  private fit = 1
  private ui: HTMLElement | null = null
  private input: HTMLInputElement | null = null
  private inputTimer = 0
  private currentText: string
  private rebuildToken = 0
  private disposed = false

  constructor(options: CosmosOptions) {
    this.opts = options
    this.currentText = normalizeText(options.text ?? DEFAULT_TEXT)
  }

  async mount(ctx: WorkContext): Promise<void> {
    const { renderer, quality } = ctx
    this.renderer = renderer

    this.size = quality.pick(512, 384, 256)
    this.count = this.size * this.size
    this.canvasWidth = quality.pick(1600, 1200, 900)
    this.baseBrightness = quality.pick(0.055, 0.085, 0.16)

    this.camera = new THREE.PerspectiveCamera(52, ctx.width / ctx.height, 0.1, 200)
    this.camera.position.z = this.opts.hero ? 17.5 : 16
    this.scene.add(this.group)

    // --- GPGPU のバッファ ---
    this.position = new PingPong(this.size, this.size)
    this.velocity = new PingPong(this.size, this.size)

    const shell = generateShell(this.count, WORLD_WIDTH * 0.75)
    const shellTexture = createDataTexture(shell, this.size, this.size)
    seedPingPong(renderer, this.position, shellTexture)
    shellTexture.dispose()

    const zeros = createDataTexture(new Float32Array(this.count * 4), this.size, this.size)
    seedPingPong(renderer, this.velocity, zeros)
    zeros.dispose()

    this.galaxyTexture = createDataTexture(
      generateGalaxy(this.count, GALAXY_RADIUS),
      this.size,
      this.size,
    )
    // 文字のサンプリングが終わるまでの仮置き（銀河をそのまま目標にしておく）
    this.textTexture = createDataTexture(
      generateGalaxy(this.count, GALAXY_RADIUS * 0.7),
      this.size,
      this.size,
    )

    this.positionPass = new Pass(POSITION_FRAG, {
      uPosition: { value: null },
      uVelocity: { value: null },
      uDt: { value: 0 },
    })

    this.velocityPass = new Pass(VELOCITY_FRAG, {
      uPosition: { value: null },
      uVelocity: { value: null },
      uTargetText: { value: this.textTexture },
      uTargetGalaxy: { value: this.galaxyTexture },
      uDt: { value: 0 },
      uTime: { value: 0 },
      uMorph: { value: 0 },
      uSpring: { value: 3 },
      uDamping: { value: 0.9 },
      uNoise: { value: 0.9 },
      uSpin: { value: 0 },
      uMouseForce: { value: 0 },
      uBurst: { value: 0 },
      uMouse: { value: this.mouseWorld },
    })

    // --- 粒子本体 ---
    const geometry = new THREE.BufferGeometry()
    // position 自体は使わない（座標はテクスチャから読む）が、
    // three が描画頂点数を決めるのに必要なので確保する
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(this.count * 3), 3),
    )
    geometry.setAttribute('aRef', createReferenceAttribute(this.size))
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), WORLD_WIDTH)

    this.pointsMaterial = new THREE.ShaderMaterial({
      vertexShader: RENDER_VERT,
      fragmentShader: RENDER_FRAG,
      uniforms: {
        uPosition: { value: null },
        uVelocity: { value: null },
        // 低スペック時はブルームを使わないので、粒を大きくして裾で光らせる
        uSize: { value: quality.pick(2.6, 3.0, 5.0) },
        uGlow: { value: quality.tier === 'low' ? 1 : 0 },
        uPixelRatio: { value: quality.pixelRatio },
        // 粒子が多いほど 1 粒を暗くしないと真っ白に飽和する。
        // 実際の明るさは画面の広さにも依存するので resize で調整する
        uBrightness: { value: quality.pick(0.055, 0.085, 0.16) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    this.points = new THREE.Points(geometry, this.pointsMaterial)
    this.points.frustumCulled = false
    this.group.add(this.points)

    // --- ポストプロセス ---
    this.composer = new EffectComposer(renderer)
    this.composer.setPixelRatio(quality.pixelRatio)
    this.composer.setSize(ctx.width, ctx.height)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    if (quality.tier !== 'low') {
      this.bloom = new UnrealBloomPass(
        new THREE.Vector2(ctx.width, ctx.height),
        quality.pick(0.55, 0.45, 0),
        0.7,
        0.5,
      )
      this.composer.addPass(this.bloom)
    }
    this.composer.addPass(new OutputPass())

    this.buildUI(ctx.overlay)
    void this.rebuildText(this.currentText)
  }

  private buildUI(overlay: HTMLElement): void {
    if (this.opts.hero) return
    const controls = overlay.querySelector<HTMLElement>('.work__controls')
    if (!controls) return

    const input = el('input', {
      type: 'text',
      maxlength: '24',
      placeholder: '好きな言葉を入れてみて',
      'aria-label': '宇宙にする言葉',
      value: this.currentText.replace('\n', ' '),
      spellcheck: 'false',
    })
    input.addEventListener('input', () => {
      window.clearTimeout(this.inputTimer)
      // 一文字打つたびに作り直すと重いので、手が止まってから作る
      this.inputTimer = window.setTimeout(() => this.applyInput(), 420)
    })
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        window.clearTimeout(this.inputTimer)
        this.applyInput()
      }
    })

    this.input = input
    this.ui = el('div', { class: 'wordform' }, [
      input,
      el('button', { class: 'chip', type: 'button', onclick: () => this.applyInput() }, [
        '作り直す',
      ]),
    ])
    controls.append(this.ui)
  }

  private applyInput(): void {
    const raw = this.input?.value ?? ''
    const next = normalizeText(raw)
    if (!next || next === this.currentText) return
    this.currentText = next
    void this.rebuildText(next)
  }

  /** 文字を点群にし直して目標テクスチャを差し替える。 */
  private async rebuildText(text: string): Promise<void> {
    const token = ++this.rebuildToken
    const sample = await sampleText({
      text,
      count: this.count,
      canvasWidth: this.canvasWidth,
      worldWidth: WORLD_WIDTH,
    })
    if (this.disposed || token !== this.rebuildToken) return

    this.coverage = sample.coverage
    this.applyBrightness()

    const next = createDataTexture(sample.points, this.size, this.size)
    this.textTexture.dispose()
    this.textTexture = next
    this.velocityPass.set('uTargetText', next)

    // 一度散らしてから新しい文字に集まらせる
    this.time = 0
    this.pendingBurst = 1.1
  }

  update(dt: number, elapsed: number): void {
    const simDt = Math.min(dt, 1 / 50)

    // タイムラインを進める。周回するので剰余を取る
    const prev = this.time
    this.time = (this.time + dt) % CYCLE
    if (prev < BURST_AT && this.time >= BURST_AT && this.time > prev) {
      this.pendingBurst = 2.6
    }

    const key = interpolate(this.time)
    this.updateMouse(dt)

    const v = this.velocityPass.uniforms
    v.uPosition.value = this.position.read.texture
    v.uVelocity.value = this.velocity.read.texture
    v.uDt.value = simDt
    v.uTime.value = elapsed
    v.uMorph.value = key.morph
    v.uSpring.value = key.spring
    v.uDamping.value = key.damping
    v.uNoise.value = key.noise
    this.spin += key.spinRate * dt
    v.uSpin.value = this.spin
    v.uMouseForce.value = this.mouseStrength * 26
    v.uBurst.value = this.pendingBurst
    this.pendingBurst = 0
    this.velocityPass.render(this.renderer, this.velocity.write)
    this.velocity.swap()

    const p = this.positionPass.uniforms
    p.uPosition.value = this.position.read.texture
    p.uVelocity.value = this.velocity.read.texture
    p.uDt.value = simDt
    this.positionPass.render(this.renderer, this.position.write)
    this.position.swap()

    this.pointsMaterial.uniforms.uPosition.value = this.position.read.texture
    this.pointsMaterial.uniforms.uVelocity.value = this.velocity.read.texture

    // ゆっくり首を振らせつつ、カーソルの位置で視差をつける
    const targetY = Math.sin(elapsed * 0.11) * 0.2 + pointer.nx * 0.2
    const targetX = Math.cos(elapsed * 0.083) * 0.08 - pointer.ny * 0.13
    const ease = Math.min(1, dt * 2.6)
    this.rotY += (targetY - this.rotY) * ease
    this.rotX += (targetX - this.rotX) * ease
    this.group.rotation.set(this.rotX, this.rotY, 0)

    this.composer.render()
  }

  /** カーソルを z=0 平面へ投影し、粒子と同じローカル座標に変換する。 */
  private updateMouse(dt: number): void {
    const want = pointer.active ? 1 : 0
    this.mouseStrength += (want - this.mouseStrength) * Math.min(1, dt * 4)

    if (pointer.active) {
      this.raycaster.setFromCamera(new THREE.Vector2(pointer.nx, pointer.ny), this.camera)
      const hit = new THREE.Vector3()
      if (this.raycaster.ray.intersectPlane(this.plane, hit)) {
        this.group.updateMatrixWorld()
        this.group.worldToLocal(hit)
        this.mouseTarget.copy(hit)
      }
    }
    this.mouseWorld.lerp(this.mouseTarget, Math.min(1, dt * 9))
  }

  resize(width: number, height: number): void {
    const aspect = width / height
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()

    const ratio = this.renderer.getPixelRatio()
    this.composer.setPixelRatio(ratio)
    this.composer.setSize(width, height)
    this.bloom?.setSize(width, height)
    this.pointsMaterial.uniforms.uPixelRatio.value = ratio

    // 縦長の画面では文字が横にはみ出すので、収まるように群れごと縮める
    const visibleHeight =
      2 * Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.position.z
    const visibleWidth = visibleHeight * aspect
    this.fit = Math.min(1, (visibleWidth * 0.92) / WORLD_WIDTH)
    this.group.scale.setScalar(this.fit)
    // トップページでは下にカードが並ぶので、文字を少し上へ逃がす
    this.group.position.y = this.opts.hero ? visibleHeight * 0.1 : 0

    this.viewHeightPixels = (height * ratio) / visibleHeight
    this.applyBrightness()
  }

  /**
   * 1粒あたりの明るさを決める。
   *
   * 粒子の数は固定なので、文字が画面に占める面積が小さいほど粒が重なって
   * 真っ白に飽和する。「文字の実面積 ÷ 粒子数」に比例させると、
   * 短い言葉でも長い言葉でも、狭い画面でも広い画面でも同じ濃さに見える。
   */
  private applyBrightness(): void {
    const worldArea = WORLD_WIDTH * WORLD_WIDTH * 0.5 * this.coverage
    const screenArea = worldArea * this.fit * this.fit * this.viewHeightPixels ** 2
    const perParticle = screenArea / this.count
    this.pointsMaterial.uniforms.uBrightness.value =
      this.baseBrightness * clamp(perParticle / 0.293, 0.15, 2)
  }

  dispose(): void {
    this.disposed = true
    window.clearTimeout(this.inputTimer)
    this.ui?.remove()
    this.ui = null
    this.input = null

    this.group.remove(this.points)
    this.scene.remove(this.group)
    this.points.geometry.dispose()
    this.pointsMaterial.dispose()
    this.position.dispose()
    this.velocity.dispose()
    this.positionPass.dispose()
    this.velocityPass.dispose()
    this.textTexture.dispose()
    this.galaxyTexture.dispose()
    this.bloom?.dispose()
    this.composer.dispose()
  }
}

/** 入力を 2 行までに整える。長い一行は真ん中の空白で折る。 */
function normalizeText(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, 24)
  if (!text) return ''
  if (text.includes('\n')) return text
  if (text.length <= 8) return text

  const spaces = [...text.matchAll(/ /g)].map((m) => m.index ?? -1).filter((i) => i > 0)
  if (spaces.length === 0) return text
  const middle = text.length / 2
  const best = spaces.reduce((a, b) => (Math.abs(b - middle) < Math.abs(a - middle) ? b : a))
  return `${text.slice(0, best)}\n${text.slice(best + 1)}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function interpolate(t: number): Key {
  let i = 0
  while (i < KEYS.length - 2 && KEYS[i + 1].t <= t) i++
  const a = KEYS[i]
  const b = KEYS[i + 1]
  const span = b.t - a.t
  const raw = span <= 0 ? 0 : (t - a.t) / span
  // 直線補間だと切り替わりが目に見えるので滑らかにする
  const k = raw * raw * (3 - 2 * raw)
  return {
    t,
    spring: a.spring + (b.spring - a.spring) * k,
    damping: a.damping + (b.damping - a.damping) * k,
    noise: a.noise + (b.noise - a.noise) * k,
    spinRate: a.spinRate + (b.spinRate - a.spinRate) * k,
    morph: a.morph + (b.morph - a.morph) * k,
  }
}
