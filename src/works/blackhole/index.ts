import * as THREE from 'three'

import type { Work, WorkContext } from '../../core/Work'
import { Pass, createRenderTarget } from '../../core/gpu'
import { pointer } from '../../core/pointer'
import { el } from '../../ui/dom'
import { BLUR_FRAG, BRIGHT_FRAG, COMPOSITE_FRAG, buildBlackholeShader } from './shaders'

/** 初期視点。円盤をやや見下ろして、奥の円盤が上下に回り込む構図 */
const HOME = { azimuth: -Math.PI / 2, incl: (12 * Math.PI) / 180, radius: 13 }
const MIN_RADIUS = 4.5
const MAX_RADIUS = 24
/** 仰角の可動域。真横（0°付近）は円盤の横断判定がチャタつくので避ける */
const EDGE_INCL = (2 * Math.PI) / 180
const MAX_INCL = (82 * Math.PI) / 180
/** 放置時の自動演出：方位角のドリフトと、仰角のゆっくりした呼吸 */
const AUTO_SPIN = 0.03
const BREATH_AMP = (10 * Math.PI) / 180
const BREATH_PERIOD = 40
/** 視野角 60°（縦）。tan(30°) をシェーダへ渡す */
const TAN_HALF_FOV = Math.tan(Math.PI / 6)

const WORLD_UP = new THREE.Vector3(0, 1, 0)

export function create(): Work {
  return new BlackholeWork()
}

class BlackholeWork implements Work {
  readonly id = 'blackhole'

  private renderer!: THREE.WebGLRenderer
  private canvas!: HTMLCanvasElement

  private mainPass!: Pass
  private brightPass!: Pass
  private blurPass!: Pass
  private compositePass!: Pass
  private sceneRT!: THREE.WebGLRenderTarget
  private bloomA!: THREE.WebGLRenderTarget
  private bloomB!: THREE.WebGLRenderTarget
  /** レイマーチのコストは解像度×ステップ数。低ティアは内部解像度を落として上へ伸ばす */
  private internalScale = 1
  private bloomTexel = new THREE.Vector2()
  private aspect = 1

  // カメラは球座標（方位角・仰角・距離）で持つ
  private azimuth = HOME.azimuth
  private incl = HOME.incl
  private radius = HOME.radius
  private azVel = 0
  private inclVel = 0
  /** 自動周回の効き（0..1）。操作中は 0 へ、放置で 1 へ戻す */
  private autoWeight = 1
  private parX = 0
  private parY = 0

  private dragging = false
  private dragDX = 0
  private dragDY = 0
  private lastDrag = { x: 0, y: 0 }
  private ui: HTMLElement | null = null

  private camPos = new THREE.Vector3()
  private camRight = new THREE.Vector3()
  private camUp = new THREE.Vector3()
  private camFwd = new THREE.Vector3()

  mount(ctx: WorkContext): void {
    const { renderer, quality } = ctx
    this.renderer = renderer
    this.canvas = renderer.domElement
    this.aspect = ctx.width / ctx.height

    // ティアは mount 時に確定してシェーダへ焼き込む
    const steps = quality.pick(220, 140, 90)
    const octaves = quality.pick(3, 2, 2)
    this.internalScale = quality.pick(1, 0.75, 0.55)

    const half: { type: THREE.TextureDataType; filter: THREE.MagnificationTextureFilter } = {
      // HDR で描いてから合成パスでトーンマップする。
      // 縮小レンダリングを拡大して出すので LinearFilter が必須
      type: THREE.HalfFloatType,
      filter: THREE.LinearFilter,
    }
    this.sceneRT = createRenderTarget(1, 1, half)
    this.bloomA = createRenderTarget(1, 1, half)
    this.bloomB = createRenderTarget(1, 1, half)

    this.mainPass = new Pass(buildBlackholeShader(steps, octaves), {
      uCamPos: { value: this.camPos },
      uCamRight: { value: this.camRight },
      uCamUp: { value: this.camUp },
      uCamFwd: { value: this.camFwd },
      uTanHalfFov: { value: TAN_HALF_FOV },
      uAspect: { value: this.aspect },
      uTime: { value: 0 },
      uDiskDir: { value: 1 },
    })
    this.brightPass = new Pass(BRIGHT_FRAG, { uScene: { value: null } })
    this.blurPass = new Pass(BLUR_FRAG, {
      uSource: { value: null },
      uDir: { value: new THREE.Vector2() },
    })
    this.compositePass = new Pass(COMPOSITE_FRAG, {
      uScene: { value: null },
      uBloom: { value: null },
      uBloomStrength: { value: quality.pick(0.9, 0.7, 0.5) },
    })

    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)

    this.buildUI(ctx.overlay)
    this.resize(ctx.width, ctx.height)
  }

  private buildUI(overlay: HTMLElement): void {
    const controls = overlay.querySelector<HTMLElement>('.work__controls')
    if (!controls) return
    this.ui = el('div', { class: 'work__controls' }, [
      el('button', { class: 'chip', type: 'button', onclick: () => this.resetView() }, [
        '最初の視点に戻る',
      ]),
    ])
    controls.append(this.ui)
  }

  private resetView(): void {
    this.azimuth = HOME.azimuth
    this.incl = HOME.incl
    this.radius = HOME.radius
    this.azVel = 0
    this.inclVel = 0
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    // deltaY の単位はブラウザによって px / 行 / ページと違う（fractal と同じ正規化）
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
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return
    this.dragDX += event.clientX - this.lastDrag.x
    this.dragDY += event.clientY - this.lastDrag.y
    this.lastDrag = { x: event.clientX, y: event.clientY }
  }

  private onPointerUp = (): void => {
    this.dragging = false
  }

  update(dt: number, elapsed: number): void {
    const step = Math.min(dt, 1 / 30)

    // 操作をやめてしばらくすると自動演出がゆっくり効き始める。
    // 即座に戻すと「手を離した瞬間に勝手に動く」違和感が出る
    const wantAuto = !this.dragging && pointer.idleFor(4000) ? 1 : 0
    this.autoWeight += (wantAuto - this.autoWeight) * Math.min(1, step * 1.5)

    // 常時ゆっくり周回 + 仰角の呼吸。目的地を持たないので
    // ユーザー操作とは同じ状態変数への加算で自然に合流する
    this.azimuth += AUTO_SPIN * this.autoWeight * step
    const breathRate = Math.cos((elapsed * Math.PI * 2) / BREATH_PERIOD)
    this.incl = clampIncl(
      this.incl + breathRate * BREATH_AMP * ((Math.PI * 2) / BREATH_PERIOD) * this.autoWeight * step,
    )

    // ドラッグの反映と、離したあとの慣性
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

    // マウス位置の視差。触れただけで視点がわずかに応える
    const targetX = pointer.active ? pointer.nx * 0.05 : 0
    const targetY = pointer.active ? pointer.ny * 0.035 : 0
    this.parX += (targetX - this.parX) * Math.min(1, step * 2.6)
    this.parY += (targetY - this.parY) * Math.min(1, step * 2.6)

    this.updateCamera()
    this.mainPass.set('uTime', elapsed)
    this.mainPass.set('uAspect', this.aspect)
    this.mainPass.render(this.renderer, this.sceneRT)

    // ミニブルーム：明部抽出 → 横 → 縦
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

  /** 球座標からカメラ位置と基底を組み立てる。行列はシェーダに渡さない */
  private updateCamera(): void {
    const az = this.azimuth + this.parX
    const incl = clampIncl(this.incl + this.parY)
    const ce = Math.cos(incl)
    this.camPos
      .set(Math.cos(az) * ce, Math.sin(incl), Math.sin(az) * ce)
      .multiplyScalar(this.radius)
    this.camFwd.copy(this.camPos).multiplyScalar(-1).normalize()
    this.camRight.crossVectors(this.camFwd, WORLD_UP).normalize()
    this.camUp.crossVectors(this.camRight, this.camFwd)
  }

  resize(width: number, height: number): void {
    this.aspect = width / height
    // Quality.scale の自動降格は drawing buffer の縮小として現れるので、
    // 内部レンダーターゲットもそこから追随させる
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
    this.ui?.remove()
    this.sceneRT.dispose()
    this.bloomA.dispose()
    this.bloomB.dispose()
    for (const pass of [this.mainPass, this.brightPass, this.blurPass, this.compositePass]) {
      pass.dispose()
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 仰角を可動域に収める。真横（±2°未満）は避けて滑らかに押し出す */
function clampIncl(value: number): number {
  const clamped = clamp(value, -MAX_INCL, MAX_INCL)
  if (Math.abs(clamped) >= EDGE_INCL) return clamped
  return clamped >= 0 ? EDGE_INCL : -EDGE_INCL
}
