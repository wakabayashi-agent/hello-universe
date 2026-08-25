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
import { pointer } from '../../core/pointer'
import {
  AGENT_FRAG,
  DEPOSIT_FRAG,
  DEPOSIT_VERT,
  DIFFUSE_FRAG,
  DISPLAY_FRAG,
  SPLAT_FRAG,
} from './shaders'

/**
 * パラメータはこの組で「太い幹が数秒スケールで溶けて、別ルートに
 * 引き直される」均衡になる。単位はトレイル場ピクセル / 1ステップ(1/60s)。
 */
const SENSOR_ANGLE = 0.45 // 分岐の広がり。大きいと蜂の巣状、小さいと直線的な糸
const SENSOR_DIST = 9 // 網目の間隔＝血管の太さ感
const TURN_ANGLE = 0.45 // 組み変わりの機敏さ。センサー角と同程度が安定
const SPEED = 1.2 // 成長速度
const DEPOSIT = 0.04 // 濃度。上げすぎると白飛びして全面べた塗りになる
const EVAPORATION = 0.94 // 記憶の長さ。0.97 で太く退屈、0.90 で細切れに崩壊
const FOOD_EVAP = 0.985 // 餌はカーソルが去っても2〜3秒残って網を引き続ける
const DIFFUSE_MIX = 0.55 // 血管エッジの柔らかさ
const JITTER = 0.12 // 常時ゆらぎ。0 だと格子縞が出て網が凍る
const AVOID = 0.7 // 種族間の忌避。強すぎると国境線がチラつく
const FOOD_WEIGHT = 2.0 // 餌が自トレイルの2倍魅力的 → カーソルへ確実に伸びる
const FOOD_SPLAT = 1.1

interface Splat {
  x: number
  y: number
  food: number
  radius: number
}

export function create(): Work {
  return new SlimeWork()
}

class SlimeWork implements Work {
  readonly id = 'slime'

  private renderer!: THREE.WebGLRenderer
  private agentSize = 1024
  private trailRes = 1024
  private trailWidth = 1024
  private trailHeight = 1024

  private agents!: PingPong
  private trail!: PingPong
  private agentPass!: Pass
  private diffusePass!: Pass
  private splatPass!: Pass
  private displayPass!: Pass

  private pointsScene = new THREE.Scene()
  private points!: THREE.Points
  private depositMaterial!: THREE.ShaderMaterial

  private trailTexel = new THREE.Vector2()
  private aspect = 1
  private queued: Splat[] = []
  /** クリック散乱の強さ。プツ切れしないよう 0..1 へイーズする */
  private repel = 0
  /** 放置時の仮想フィーダーの効き */
  private feeder = 0

  mount(ctx: WorkContext): void {
    const { renderer, quality } = ctx
    this.renderer = renderer
    this.aspect = ctx.width / ctx.height

    // エージェント数はテクスチャ辺の2乗。high で約105万匹
    this.agentSize = quality.pick(1024, 768, 512)
    this.trailRes = quality.pick(1024, 768, 512)

    this.agents = new PingPong(this.agentSize, this.agentSize)
    const seed = createDataTexture(this.buildInitialAgents(), this.agentSize, this.agentSize)
    seedPingPong(renderer, this.agents, seed)
    seed.dispose()

    const fit = fitResolution(this.trailRes, ctx.width, ctx.height)
    this.trailWidth = fit.width
    this.trailHeight = fit.height
    this.trailTexel.set(1 / this.trailWidth, 1 / this.trailHeight)
    this.trail = new PingPong(this.trailWidth, this.trailHeight, {
      // センシングと拡散は補間サンプリング、画面端はトーラスなので Repeat
      type: THREE.HalfFloatType,
      filter: THREE.LinearFilter,
      wrap: THREE.RepeatWrapping,
    })
    this.clearTrail()

    this.agentPass = new Pass(AGENT_FRAG, {
      uAgents: { value: null },
      uTrail: { value: null },
      uTexel: { value: this.trailTexel },
      uDtScale: { value: 1 },
      uTime: { value: 0 },
      uAspect: { value: this.aspect },
      uSensorAngle: { value: SENSOR_ANGLE },
      uSensorDist: { value: SENSOR_DIST },
      uTurnAngle: { value: TURN_ANGLE },
      uSpeed: { value: SPEED },
      uJitter: { value: JITTER },
      uAvoid: { value: AVOID },
      uFoodWeight: { value: FOOD_WEIGHT },
      uMouse: { value: new THREE.Vector4(0.5, 0.5, 0.12, 0) },
    })
    this.diffusePass = new Pass(DIFFUSE_FRAG, {
      uTrail: { value: null },
      uTexel: { value: this.trailTexel },
      uDecay: { value: new THREE.Vector3(1, 1, 1) },
      uDiffuse: { value: DIFFUSE_MIX },
    })
    this.splatPass = new Pass(SPLAT_FRAG, {
      uTarget: { value: null },
      uAspect: { value: this.aspect },
      uColor: { value: new THREE.Vector3() },
      uPoint: { value: new THREE.Vector2() },
      uRadius: { value: 0.0012 },
    })
    this.displayPass = new Pass(DISPLAY_FRAG, {
      uTrail: { value: null },
      uTexel: { value: this.trailTexel },
      uColorA: { value: new THREE.Vector3(0.35, 1.0, 0.55) }, // 生体発光グリーン
      uColorB: { value: new THREE.Vector3(0.4, 0.55, 1.0) }, // 深海の青紫
    })

    // 堆積用の点群。頂点シェーダがエージェントテクスチャから位置を引く
    const count = this.agentSize * this.agentSize
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    geometry.setAttribute('aRef', createReferenceAttribute(this.agentSize))
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.depositMaterial = new THREE.ShaderMaterial({
      vertexShader: DEPOSIT_VERT,
      fragmentShader: DEPOSIT_FRAG,
      uniforms: {
        uAgents: { value: null },
        uDeposit: { value: DEPOSIT },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.points = new THREE.Points(geometry, this.depositMaterial)
    this.points.frustumCulled = false
    this.pointsScene.add(this.points)
  }

  /**
   * 初期配置：2種族とも画面全体に一様ランダム。
   * 開いた1〜2秒で無数の点が細い血管網へ自己組織化していく過程が
   * そのまま作品の掴みになる。相互忌避で2色の縄張りが勝手に分かれる。
   */
  private buildInitialAgents(): Float32Array {
    const count = this.agentSize * this.agentSize
    const data = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) {
      data[i * 4] = Math.random()
      data[i * 4 + 1] = Math.random()
      data[i * 4 + 2] = Math.random() * Math.PI * 2
      data[i * 4 + 3] = i % 2
    }
    return data
  }

  /** トレイル場をゼロで初期化する。renderer の clearColor は汚さない。 */
  private clearTrail(): void {
    const renderer = this.renderer
    const prevColor = new THREE.Color()
    renderer.getClearColor(prevColor)
    const prevAlpha = renderer.getClearAlpha()
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(this.trail.read)
    renderer.clear()
    renderer.setRenderTarget(this.trail.write)
    renderer.clear()
    renderer.setRenderTarget(null)
    renderer.setClearColor(prevColor, prevAlpha)
  }

  update(dt: number, elapsed: number): void {
    const step = Math.min(dt, 1 / 30)
    const dtScale = clamp(step * 60, 0.5, 2)

    this.collectInput(step, elapsed)
    for (const splat of this.queued) this.applySplat(splat)
    this.queued.length = 0

    // エージェント更新：前フレームの堆積＋今フレームの餌を見て動く
    const a = this.agentPass.uniforms
    a.uAgents.value = this.agents.read.texture
    a.uTrail.value = this.trail.read.texture
    a.uDtScale.value = dtScale
    a.uTime.value = elapsed
    a.uAspect.value = this.aspect
    ;(a.uMouse.value as THREE.Vector4).set(pointer.ux, 1 - pointer.uy, 0.12, this.repel)
    this.agentPass.render(this.renderer, this.agents.write)
    this.agents.swap()

    // 拡散＋蒸発（swap はまだ。堆積を同じ write 面へ重ねる）
    const d = this.diffusePass.uniforms
    d.uTrail.value = this.trail.read.texture
    ;(d.uDecay.value as THREE.Vector3).set(
      Math.pow(EVAPORATION, step * 60),
      Math.pow(EVAPORATION, step * 60),
      Math.pow(FOOD_EVAP, step * 60),
    )
    this.diffusePass.render(this.renderer, this.trail.write)

    // 堆積：エージェント位置に加算で点を打つ
    this.depositMaterial.uniforms.uAgents.value = this.agents.read.texture
    this.renderer.autoClear = false
    this.renderer.setRenderTarget(this.trail.write)
    this.renderer.render(this.pointsScene, fullscreenCamera)
    this.renderer.setRenderTarget(null)
    this.renderer.autoClear = true
    this.trail.swap()

    this.displayPass.set('uTrail', this.trail.read.texture)
    this.displayPass.render(this.renderer, null)
  }

  /** マウスと放置演出をトレイル場へのスプラットに変換する。 */
  private collectInput(step: number, elapsed: number): void {
    // クリック中の散乱はイーズしてプツ切れを防ぐ
    const repelTarget = pointer.down ? 1 : 0
    this.repel += (repelTarget - this.repel) * Math.min(1, step * 8)

    // カーソルの現在位置に餌を落とす → 網が1秒弱の遅れで伸びてくる
    if (pointer.active && !pointer.idleFor(160)) {
      this.queued.push({ x: pointer.ux, y: 1 - pointer.uy, food: FOOD_SPLAT, radius: 0.0012 })
    }
    // 押しっぱなしは負の餌 = 忌避。散乱と合わせて網に穴が開く
    if (pointer.down) {
      this.queued.push({ x: pointer.ux, y: 1 - pointer.uy, food: -2.2, radius: 0.004 })
    }

    // 放置時はリサージュ軌道の仮想フィーダーが餌を撒き続ける。
    // 連続軌道なので「網が光を追いかける」一貫した絵になり、
    // マウス操作のデモを勝手にやってくれる
    const feederTarget = pointer.idleFor(2500) ? 1 : 0
    this.feeder += (feederTarget - this.feeder) * Math.min(1, step * (feederTarget ? 0.5 : 20))
    if (this.feeder > 0.02) {
      const ampX = Math.min(0.42, 0.34 / this.aspect)
      const fx = 0.5 + ampX * Math.sin(elapsed * 0.31)
      const fy = 0.5 + 0.3 * Math.sin(elapsed * 0.47 + 1.3)
      this.queued.push({ x: fx, y: fy, food: FOOD_SPLAT * this.feeder, radius: 0.0016 })
    }
  }

  private applySplat(splat: Splat): void {
    const u = this.splatPass.uniforms
    ;(u.uPoint.value as THREE.Vector2).set(splat.x, splat.y)
    ;(u.uColor.value as THREE.Vector3).set(0, 0, splat.food)
    u.uRadius.value = splat.radius
    u.uAspect.value = this.aspect
    this.splatPass.set('uTarget', this.trail.read.texture)
    this.splatPass.render(this.renderer, this.trail.write)
    this.trail.swap()
  }

  resize(width: number, height: number): void {
    this.aspect = width / height
    const fit = fitResolution(this.trailRes, width, height)
    this.trailWidth = fit.width
    this.trailHeight = fit.height
    this.trailTexel.set(1 / this.trailWidth, 1 / this.trailHeight)
    // 場の中身は消えるが、エージェントは UV 空間で生きているので
    // 網は数秒で自己修復する
    this.trail.setSize(this.trailWidth, this.trailHeight)
    this.clearTrail()
  }

  dispose(): void {
    this.pointsScene.remove(this.points)
    this.points.geometry.dispose()
    this.depositMaterial.dispose()
    this.agents.dispose()
    this.trail.dispose()
    for (const pass of [this.agentPass, this.diffusePass, this.splatPass, this.displayPass]) {
      pass.dispose()
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
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
