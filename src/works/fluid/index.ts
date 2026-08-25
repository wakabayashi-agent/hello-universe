import * as THREE from 'three'

import type { Work, WorkContext } from '../../core/Work'
import { Pass, PingPong, createRenderTarget } from '../../core/gpu'
import { pointer } from '../../core/pointer'
import {
  ADVECTION_FRAG,
  CLEAR_FRAG,
  CURL_FRAG,
  DISPLAY_FRAG,
  DIVERGENCE_FRAG,
  GRADIENT_SUBTRACT_FRAG,
  PRESSURE_FRAG,
  SPLAT_FRAG,
  VORTICITY_FRAG,
} from './shaders'

export function create(): Work {
  return new FluidWork()
}

interface Splat {
  x: number
  y: number
  dx: number
  dy: number
  color: THREE.Color
  radius: number
}

class FluidWork implements Work {
  readonly id = 'fluid'

  private renderer!: THREE.WebGLRenderer
  private simWidth = 256
  private simHeight = 256
  private dyeWidth = 1024
  private dyeHeight = 1024
  private iterations = 24

  private velocity!: PingPong
  private dye!: PingPong
  private pressure!: PingPong
  private divergence!: THREE.WebGLRenderTarget
  private curl!: THREE.WebGLRenderTarget

  private advection!: Pass
  private divergencePass!: Pass
  private curlPass!: Pass
  private vorticityPass!: Pass
  private pressurePass!: Pass
  private clearPass!: Pass
  private gradientPass!: Pass
  private splatPass!: Pass
  private displayPass!: Pass

  private simTexel = new THREE.Vector2()
  private dyeTexel = new THREE.Vector2()
  private aspect = 1
  private hue = Math.random()
  private autoTimer = 0
  private queued: Splat[] = []

  mount(ctx: WorkContext): void {
    const { renderer, quality } = ctx
    this.renderer = renderer
    this.iterations = quality.pick(24, 18, 12)

    const simRes = quality.pick(256, 192, 128)
    const dyeRes = quality.pick(1024, 768, 512)

    const half: { type: THREE.TextureDataType; filter: THREE.MagnificationTextureFilter } = {
      // 移流は必ず補間サンプリングになるので LinearFilter が必須。
      // WebGL2 では half float はそのまま線形補間できる
      type: THREE.HalfFloatType,
      filter: THREE.LinearFilter,
    }

    const sim = fitResolution(simRes, ctx.width, ctx.height)
    const dyeSize = fitResolution(dyeRes, ctx.width, ctx.height)
    this.simWidth = sim.width
    this.simHeight = sim.height
    this.dyeWidth = dyeSize.width
    this.dyeHeight = dyeSize.height

    this.velocity = new PingPong(this.simWidth, this.simHeight, half)
    this.dye = new PingPong(this.dyeWidth, this.dyeHeight, half)
    this.pressure = new PingPong(this.simWidth, this.simHeight, {
      type: THREE.HalfFloatType,
      filter: THREE.NearestFilter,
    })
    this.divergence = createRenderTarget(this.simWidth, this.simHeight, {
      type: THREE.HalfFloatType,
      filter: THREE.NearestFilter,
    })
    this.curl = createRenderTarget(this.simWidth, this.simHeight, {
      type: THREE.HalfFloatType,
      filter: THREE.NearestFilter,
    })

    this.simTexel.set(1 / this.simWidth, 1 / this.simHeight)
    this.dyeTexel.set(1 / this.dyeWidth, 1 / this.dyeHeight)
    this.aspect = ctx.width / ctx.height

    this.advection = new Pass(ADVECTION_FRAG, {
      uVelocity: { value: null },
      uSource: { value: null },
      uTexelSize: { value: this.simTexel },
      uDt: { value: 0 },
      uDissipation: { value: 0 },
    })
    this.divergencePass = new Pass(DIVERGENCE_FRAG, {
      uVelocity: { value: null },
      uTexelSize: { value: this.simTexel },
    })
    this.curlPass = new Pass(CURL_FRAG, {
      uVelocity: { value: null },
      uTexelSize: { value: this.simTexel },
    })
    this.vorticityPass = new Pass(VORTICITY_FRAG, {
      uVelocity: { value: null },
      uCurl: { value: null },
      uTexelSize: { value: this.simTexel },
      uCurlStrength: { value: 30 },
      uDt: { value: 0 },
    })
    this.pressurePass = new Pass(PRESSURE_FRAG, {
      uPressure: { value: null },
      uDivergence: { value: null },
      uTexelSize: { value: this.simTexel },
    })
    this.clearPass = new Pass(CLEAR_FRAG, {
      uTexture: { value: null },
      uValue: { value: 0.8 },
    })
    this.gradientPass = new Pass(GRADIENT_SUBTRACT_FRAG, {
      uPressure: { value: null },
      uVelocity: { value: null },
      uTexelSize: { value: this.simTexel },
    })
    this.splatPass = new Pass(SPLAT_FRAG, {
      uTarget: { value: null },
      uAspectRatio: { value: this.aspect },
      uColor: { value: new THREE.Vector3() },
      uPoint: { value: new THREE.Vector2() },
      uRadius: { value: 0.0002 },
    })
    this.displayPass = new Pass(DISPLAY_FRAG, {
      uTexture: { value: null },
      uTexelSize: { value: this.dyeTexel },
    })

    // 開いた瞬間から色がある状態にしておく
    for (let i = 0; i < 6; i++) this.queued.push(this.randomSplat())
  }

  update(dt: number): void {
    const step = Math.min(dt, 1 / 40)

    this.collectPointerSplat()
    this.autoTimer -= dt
    // しばらく触られていなければ勝手に色を撃つ。放置しても画面が動き続ける
    if (this.autoTimer <= 0 && pointer.idleFor(1400)) {
      this.queued.push(this.randomSplat())
      this.autoTimer = 0.45 + Math.random() * 0.5
    }
    for (const splat of this.queued) this.applySplat(splat)
    this.queued.length = 0

    // 渦度閉じ込め
    this.curlPass.set('uVelocity', this.velocity.read.texture)
    this.curlPass.render(this.renderer, this.curl)

    this.vorticityPass.set('uVelocity', this.velocity.read.texture)
    this.vorticityPass.set('uCurl', this.curl.texture)
    this.vorticityPass.set('uDt', step)
    this.vorticityPass.render(this.renderer, this.velocity.write)
    this.velocity.swap()

    // 圧力を解いて非圧縮にする
    this.divergencePass.set('uVelocity', this.velocity.read.texture)
    this.divergencePass.render(this.renderer, this.divergence)

    // 前フレームの圧力を種にすると収束が速い。ただし必ず減衰させる
    this.clearPass.set('uTexture', this.pressure.read.texture)
    this.clearPass.render(this.renderer, this.pressure.write)
    this.pressure.swap()

    this.pressurePass.set('uDivergence', this.divergence.texture)
    for (let i = 0; i < this.iterations; i++) {
      this.pressurePass.set('uPressure', this.pressure.read.texture)
      this.pressurePass.render(this.renderer, this.pressure.write)
      this.pressure.swap()
    }

    this.gradientPass.set('uPressure', this.pressure.read.texture)
    this.gradientPass.set('uVelocity', this.velocity.read.texture)
    this.gradientPass.render(this.renderer, this.velocity.write)
    this.velocity.swap()

    // 移流：速度そのものと、色を流す
    this.advection.set('uTexelSize', this.simTexel)
    this.advection.set('uDt', step)
    this.advection.set('uVelocity', this.velocity.read.texture)
    this.advection.set('uSource', this.velocity.read.texture)
    this.advection.set('uDissipation', 0.18)
    this.advection.render(this.renderer, this.velocity.write)
    this.velocity.swap()

    this.advection.set('uVelocity', this.velocity.read.texture)
    this.advection.set('uSource', this.dye.read.texture)
    this.advection.set('uDissipation', 0.32)
    this.advection.render(this.renderer, this.dye.write)
    this.dye.swap()

    this.displayPass.set('uTexture', this.dye.read.texture)
    this.displayPass.render(this.renderer, null)
  }

  /** カーソルの動きを、そのまま流体への外力に変える。 */
  private collectPointerSplat(): void {
    if (!pointer.active) return
    const moved = Math.hypot(pointer.dx, pointer.dy)
    if (moved < 0.4 && !pointer.down) return

    this.hue = (this.hue + 0.0035) % 1
    const color = new THREE.Color().setHSL(this.hue, 0.85, pointer.down ? 0.62 : 0.5)
    const boost = pointer.down ? 2.4 : 1
    this.queued.push({
      x: pointer.ux,
      y: 1 - pointer.uy,
      dx: pointer.dx * 4.5 * boost,
      dy: -pointer.dy * 4.5 * boost,
      color,
      radius: pointer.down ? 0.0022 : 0.0011,
    })
  }

  private randomSplat(): Splat {
    this.hue = (this.hue + 0.13) % 1
    const angle = Math.random() * Math.PI * 2
    // 速度の単位は「シミュレーション格子の何マス/秒」。
    // 大きすぎると1フレームで画面を横切ってしまい、模様が均されて消える
    const power = 90 + Math.random() * 170
    return {
      x: 0.15 + Math.random() * 0.7,
      y: 0.15 + Math.random() * 0.7,
      dx: Math.cos(angle) * power,
      dy: Math.sin(angle) * power,
      color: new THREE.Color().setHSL(this.hue, 0.9, 0.55),
      radius: 0.0024,
    }
  }

  private applySplat(splat: Splat): void {
    const point = this.splatPass.uniforms.uPoint.value as THREE.Vector2
    const color = this.splatPass.uniforms.uColor.value as THREE.Vector3
    point.set(splat.x, splat.y)
    this.splatPass.set('uAspectRatio', this.aspect)
    this.splatPass.set('uRadius', splat.radius)

    // 速度場へ：動かした向きに押す
    color.set(splat.dx, splat.dy, 0)
    this.splatPass.set('uTexelSize', this.simTexel)
    this.splatPass.set('uTarget', this.velocity.read.texture)
    this.splatPass.render(this.renderer, this.velocity.write)
    this.velocity.swap()

    // 色の場へ：絵の具を落とす
    // 加算で落とすので、そのままの明度だと薄い。濃いめに入れる
    color.set(splat.color.r * 1.7, splat.color.g * 1.7, splat.color.b * 1.7)
    this.splatPass.set('uTarget', this.dye.read.texture)
    this.splatPass.render(this.renderer, this.dye.write)
    this.dye.swap()
  }

  resize(width: number, height: number): void {
    this.aspect = width / height
    // シミュレーション解像度は画面比に合わせて作り直す。
    // 中身は流されて数秒で馴染むので、そのまま作り直してしまってよい
    const sim = fitResolution(Math.max(this.simWidth, this.simHeight), width, height)
    const dye = fitResolution(Math.max(this.dyeWidth, this.dyeHeight), width, height)
    this.simWidth = sim.width
    this.simHeight = sim.height
    this.dyeWidth = dye.width
    this.dyeHeight = dye.height
    this.simTexel.set(1 / this.simWidth, 1 / this.simHeight)
    this.dyeTexel.set(1 / this.dyeWidth, 1 / this.dyeHeight)

    this.velocity.setSize(this.simWidth, this.simHeight)
    this.pressure.setSize(this.simWidth, this.simHeight)
    this.dye.setSize(this.dyeWidth, this.dyeHeight)
    this.divergence.setSize(this.simWidth, this.simHeight)
    this.curl.setSize(this.simWidth, this.simHeight)
  }

  dispose(): void {
    this.velocity.dispose()
    this.dye.dispose()
    this.pressure.dispose()
    this.divergence.dispose()
    this.curl.dispose()
    for (const pass of [
      this.advection,
      this.divergencePass,
      this.curlPass,
      this.vorticityPass,
      this.pressurePass,
      this.clearPass,
      this.gradientPass,
      this.splatPass,
      this.displayPass,
    ]) {
      pass.dispose()
    }
  }
}

/** 長辺を resolution に合わせつつ、画面のアスペクト比を保つ解像度を返す。 */
function fitResolution(
  resolution: number,
  width: number,
  height: number,
): { width: number; height: number } {
  const aspect = width / height
  if (aspect >= 1) {
    return { width: Math.round(resolution), height: Math.max(1, Math.round(resolution / aspect)) }
  }
  return { width: Math.max(1, Math.round(resolution * aspect)), height: Math.round(resolution) }
}
