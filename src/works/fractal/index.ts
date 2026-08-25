import * as THREE from 'three'

import type { Work, WorkContext } from '../../core/Work'
import { Pass, createDataTexture } from '../../core/gpu'
import { pointer } from '../../core/pointer'
import { el } from '../../ui/dom'
import { ORBIT_TEXTURE_WIDTH, buildFractalShader } from './shaders'

/** 初期表示（マンデルブロ集合の全体像）。 */
const HOME = { re: -0.6, im: 0, span: 2.6 }

/**
 * ズームの下限（初期表示の約 260 億倍）。
 * 精度はまだ余裕があるが、これ以上潜ると反復回数が足りず
 * 「発散しない＝集合の内側」と判定される領域が増えて画面が暗くなる。
 */
const MIN_SPAN = 1e-10
const MAX_SPAN = 4

/**
 * 参照点の候補（画面サイズに対する相対位置）。
 * 画面中心の軌道が短いときに、この順で長く続く点を探す。
 */
const REFERENCE_PROBES: [number, number][] = [
  [0, 0.3],
  [0, -0.3],
  [0.3, 0],
  [-0.3, 0],
  [0.25, 0.25],
  [-0.25, 0.25],
  [0.25, -0.25],
  [-0.25, -0.25],
  [0, 0.45],
  [0, -0.45],
]

/** 自動ツアーの行き先。いずれも拡大し甲斐のある有名な座標。 */
const TOUR = [
  { re: -0.743643887037151, im: 0.13182590420533, span: 2e-9 },
  { re: -0.16070135, im: 1.0375665, span: 8e-9 },
  { re: 0.2925755, im: 0.0149977, span: 4e-9 },
  { re: -1.7492046334590113, im: 0.0, span: 6e-9 },
]

export function create(): Work {
  return new FractalWork()
}

class FractalWork implements Work {
  readonly id = 'fractal'

  private renderer!: THREE.WebGLRenderer
  private pass!: Pass
  private maxIterations = 2000

  // 参照軌道（画面中心の軌道）。JS 側で倍精度計算してテクスチャに載せる
  private orbitData!: Float32Array
  private orbitTexture!: THREE.DataTexture
  private orbitLength = 1
  private orbitRe = 0
  private orbitIm = 0
  private centerCacheRe = NaN
  private centerCacheIm = NaN

  private centerRe = HOME.re
  private centerIm = HOME.im
  private span = HOME.span
  private aspect = 1

  private julia = false
  private juliaTime = 0
  private paletteShift = 0

  private tourIndex = 0
  private tourT = 0
  private tourFrom = { ...HOME }
  private touring = false

  private dragging = false
  private lastDrag = { x: 0, y: 0 }
  private canvas!: HTMLCanvasElement
  private ui: HTMLElement | null = null
  private tourChip: HTMLButtonElement | null = null
  private juliaChip: HTMLButtonElement | null = null

  mount(ctx: WorkContext): void {
    const { renderer, quality } = ctx
    this.renderer = renderer
    this.canvas = renderer.domElement
    this.aspect = ctx.width / ctx.height
    // 参照軌道テクスチャの幅がそのまま反復回数の上限になる
    this.maxIterations = Math.min(ORBIT_TEXTURE_WIDTH - 2, quality.pick(2000, 1100, 550))

    this.orbitData = new Float32Array(ORBIT_TEXTURE_WIDTH * 4)
    this.orbitTexture = createDataTexture(this.orbitData, ORBIT_TEXTURE_WIDTH, 1)

    this.pass = new Pass(buildFractalShader(this.maxIterations), {
      uOrbit: { value: this.orbitTexture },
      uOrbitLength: { value: 1 },
      uRefOffset: { value: new THREE.Vector2() },
      uSpan: { value: this.span },
      uAspect: { value: this.aspect },
      uIterations: { value: 200 },
      uJulia: { value: false },
      uJuliaC: { value: new THREE.Vector2(-0.7, 0.27) },
      uPaletteShift: { value: 0 },
    })

    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)

    this.buildUI(ctx.overlay)
  }

  private buildUI(overlay: HTMLElement): void {
    const controls = overlay.querySelector<HTMLElement>('.work__controls')
    if (!controls) return

    this.juliaChip = el(
      'button',
      { class: 'chip', type: 'button', 'aria-pressed': 'false', onclick: () => this.toggleJulia() },
      ['ジュリア集合'],
    )
    this.tourChip = el(
      'button',
      { class: 'chip', type: 'button', 'aria-pressed': 'false', onclick: () => this.toggleTour() },
      ['自動ツアー'],
    )
    this.ui = el('div', { class: 'work__controls' }, [
      this.juliaChip,
      this.tourChip,
      el('button', { class: 'chip', type: 'button', onclick: () => this.goHome() }, ['最初に戻る']),
    ])
    controls.append(this.ui)
  }

  private toggleJulia(): void {
    this.julia = !this.julia
    this.juliaChip?.setAttribute('aria-pressed', String(this.julia))
    this.stopTour()
    // ジュリア集合は原点まわりに広がるので、見やすい位置に戻す
    this.centerRe = this.julia ? 0 : HOME.re
    this.centerIm = 0
    this.span = this.julia ? 3.0 : HOME.span
  }

  private toggleTour(): void {
    if (this.touring) this.stopTour()
    else this.startTour()
  }

  private startTour(): void {
    this.touring = true
    this.tourT = 0
    this.tourFrom = { re: this.centerRe, im: this.centerIm, span: this.span }
    this.tourChip?.setAttribute('aria-pressed', 'true')
  }

  private stopTour(): void {
    if (!this.touring) return
    this.touring = false
    this.tourChip?.setAttribute('aria-pressed', 'false')
  }

  private goHome(): void {
    this.stopTour()
    this.centerRe = HOME.re
    this.centerIm = HOME.im
    this.span = HOME.span
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    this.stopTour()
    const factor = Math.exp(event.deltaY * 0.0016)
    const next = clamp(this.span * factor, MIN_SPAN, MAX_SPAN)
    const applied = next / this.span
    // カーソルの下にある点が動かないように中心をずらす
    const target = this.complexAt(event.clientX, event.clientY)
    this.centerRe = target.re + (this.centerRe - target.re) * applied
    this.centerIm = target.im + (this.centerIm - target.im) * applied
    this.span = next
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    this.stopTour()
    this.dragging = true
    this.lastDrag = { x: event.clientX, y: event.clientY }
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return
    const height = Math.max(1, window.innerHeight)
    this.centerRe -= ((event.clientX - this.lastDrag.x) / height) * this.span
    this.centerIm += ((event.clientY - this.lastDrag.y) / height) * this.span
    this.lastDrag = { x: event.clientX, y: event.clientY }
  }

  private onPointerUp = (): void => {
    this.dragging = false
  }

  /** 画面座標を複素平面の座標に変換する。 */
  private complexAt(clientX: number, clientY: number): { re: number; im: number } {
    const width = Math.max(1, window.innerWidth)
    const height = Math.max(1, window.innerHeight)
    const u = (clientX / width - 0.5) * (width / height)
    const v = -(clientY / height - 0.5)
    return { re: this.centerRe + u * this.span, im: this.centerIm + v * this.span }
  }

  update(dt: number, elapsed: number): void {
    // 一定時間触られていなければ勝手に旅を始める
    if (!this.touring && !this.dragging && pointer.idleFor(14000)) this.startTour()
    if (this.touring) this.advanceTour(dt)

    this.paletteShift = (this.paletteShift + dt * 0.012) % 1
    this.juliaTime += dt

    // 反復が足りないと、発散するはずの点まで「集合の内側」と判定されて
    // 画面が真っ黒になる。深さに比例して増やす
    const iterations = Math.min(
      this.maxIterations,
      Math.round(120 + Math.log2(HOME.span / this.span) * 45),
    )
    this.updateOrbit(iterations)

    const u = this.pass.uniforms
    u.uSpan.value = this.span
    u.uAspect.value = this.aspect
    u.uPaletteShift.value = this.paletteShift
    u.uJulia.value = this.julia
    u.uIterations.value = iterations
    u.uOrbitLength.value = this.orbitLength
    ;(u.uRefOffset.value as THREE.Vector2).set(
      this.orbitRe - this.centerRe,
      this.orbitIm - this.centerIm,
    )

    if (this.julia) {
      // c をゆっくり動かすと、形そのものが生き物のように変わり続ける
      const a = this.juliaTime * 0.07
      ;(u.uJuliaC.value as THREE.Vector2).set(
        0.7885 * Math.cos(a * 1.0 + elapsed * 0.0),
        0.7885 * Math.sin(a * 1.0),
      )
    }

    this.pass.render(this.renderer, null)
  }

  /**
   * 画面中心の軌道を JavaScript の倍精度で計算してテクスチャに焼く。
   * ここだけ精度が高ければ、各ピクセルは単精度の差分計算で足りる。
   */
  private updateOrbit(iterations: number): void {
    if (this.julia) return
    if (this.centerRe === this.centerCacheRe && this.centerIm === this.centerCacheIm) return
    this.centerCacheRe = this.centerRe
    this.centerCacheIm = this.centerIm

    const limit = Math.min(iterations + 2, ORBIT_TEXTURE_WIDTH)

    // まず画面中心を試す。ここで足りればそれが一番素直
    let bestRe = this.centerRe
    let bestIm = this.centerIm
    let bestLength = this.traceOrbit(bestRe, bestIm, limit)

    // 中心の軌道が途中で発散すると、その先はリベース頼みになって
    // 深部の精度が落ちる。画面内で軌道が長く続く点を探し直す
    if (bestLength < limit) {
      for (const [ox, oy] of REFERENCE_PROBES) {
        const re = this.centerRe + ox * this.span * this.aspect
        const im = this.centerIm + oy * this.span
        const length = this.traceOrbit(re, im, limit)
        if (length > bestLength) {
          bestLength = length
          bestRe = re
          bestIm = im
          if (length >= limit) break
        }
      }
      // 勝った候補で書き直す（最後に試した点が残っているとは限らない）
      this.traceOrbit(bestRe, bestIm, limit)
    }

    this.orbitRe = bestRe
    this.orbitIm = bestIm
    this.orbitLength = bestLength
    this.orbitTexture.needsUpdate = true
  }

  /**
   * 参照点の軌道を倍精度で回してテクスチャ用の配列に書く。
   * 戻り値は発散するまでに書けた長さ。
   */
  private traceOrbit(cRe: number, cIm: number, limit: number): number {
    const data = this.orbitData
    let zr = 0
    let zi = 0
    for (let i = 0; i < limit; i++) {
      data[i * 4] = zr
      data[i * 4 + 1] = zi
      const nextR = zr * zr - zi * zi + cRe
      const nextI = 2 * zr * zi + cIm
      zr = nextR
      zi = nextI
      if (zr * zr + zi * zi > 4) return i + 1
    }
    return limit
  }

  private advanceTour(dt: number): void {
    const target = TOUR[this.tourIndex]
    // 往路 22 秒 → 見せ場で 4 秒静止 → 次の目的地へ
    this.tourT += dt / 26
    if (this.tourT >= 1) {
      this.tourT = 0
      this.tourIndex = (this.tourIndex + 1) % TOUR.length
      this.tourFrom = { re: this.centerRe, im: this.centerIm, span: this.span }
      return
    }

    const zoomT = Math.min(1, this.tourT / 0.85)
    // 拡大は指数的に、中心の移動は先に済ませる。
    // 中心を最後まで動かし続けると、深部で画面が横滑りして酔う
    const centerT = smoothstep(Math.min(1, this.tourT / 0.35))
    this.centerRe = this.tourFrom.re + (target.re - this.tourFrom.re) * centerT
    this.centerIm = this.tourFrom.im + (target.im - this.tourFrom.im) * centerT
    this.span = this.tourFrom.span * Math.pow(target.span / this.tourFrom.span, smoothstep(zoomT))
  }

  resize(width: number, height: number): void {
    this.aspect = width / height
  }

  dispose(): void {
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.ui?.remove()
    this.orbitTexture.dispose()
    this.pass.dispose()
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}
