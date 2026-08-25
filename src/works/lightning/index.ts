import * as THREE from 'three'

import type { Work, WorkContext } from '../../core/Work'
import { Pass, createRenderTarget, fullscreenCamera } from '../../core/gpu'
import { pointer } from '../../core/pointer'
import {
  BLUR_FRAG,
  BOLT_FRAG,
  BRIGHT_FRAG,
  COMPOSITE_FRAG,
  RAIN_FRAG,
  RAIN_VERT,
  buildBoltVert,
  buildCloudShader,
} from './shaders'

/** 雲底の目安（等方座標。画面の高さ = 1、y は下が 0） */
const CLOUD_BASE = 0.74
/** 本落雷の寿命（リーダー + 再放電2回ぶん） */
const STRIKE_LIFE = 0.78
/** カーソル追従のミニアークの寿命 */
const MINI_LIFE = 0.2
/** 雲の照明に効かせる直近フラッシュの数（シェーダの MAX_FLASH と揃える） */
const MAX_FLASH = 4
/** ミニアーク1本のセグメント枠 */
const MINI_SEGS = 48

/** ボルトの明滅状態。slot ごとに1つ */
interface BoltState {
  birth: number
  kind: 'strike' | 'mini'
  power: number
}

interface Flash {
  x: number
  y: number
  strength: number
  birth: number
}

export function create(): Work {
  return new LightningWork()
}

class LightningWork implements Work {
  readonly id = 'lightning'

  private renderer!: THREE.WebGLRenderer
  private canvas!: HTMLCanvasElement
  private aspect = 1
  private now = 0

  // パス構成：雲 → (稲妻 + 雨 を加算) → ブルーム → 合成
  private cloudPass!: Pass
  private brightPass!: Pass
  private blurPass!: Pass
  private compositePass!: Pass
  private sceneRT!: THREE.WebGLRenderTarget
  private bloomA!: THREE.WebGLRenderTarget
  private bloomB!: THREE.WebGLRenderTarget
  private bloomTexel = new THREE.Vector2()
  private internalScale = 1

  private stormScene = new THREE.Scene()
  private boltMesh!: THREE.Mesh
  private boltMaterial!: THREE.ShaderMaterial
  private aSeg!: THREE.BufferAttribute
  private aMeta!: THREE.BufferAttribute
  private rain!: THREE.LineSegments
  private rainMaterial!: THREE.ShaderMaterial

  // スロット割り：本落雷用とミニアーク用を1つのプールに同居させる
  private strikeSlots = 8
  private miniSlots = 6
  private segsPerStrike = 640
  private nextStrike = 0
  private nextMini = 0
  private bolts: (BoltState | null)[] = []
  private intensity!: Float32Array

  // 雲を照らすフラッシュとシート発光・全画面リフト
  private flashes: (Flash | null)[] = Array.from({ length: MAX_FLASH }, () => null)
  private nextFlash = 0
  private sheetBirth = -10
  private sheetPower = 0
  private lift = 0

  // 入力とスケジューリング
  private pressing = false
  private holdTime = 0
  private holdTimer = 0
  private crackleTimer = 0
  private ambientTimer = 0.9 // mount 直後 ~1秒で最初の自動落雷

  mount(ctx: WorkContext): void {
    const { renderer, quality } = ctx
    this.renderer = renderer
    this.canvas = renderer.domElement
    this.aspect = ctx.width / ctx.height

    // ティアは mount 時に確定してバッファとシェーダへ焼き込む
    this.strikeSlots = quality.pick(8, 6, 5)
    this.miniSlots = quality.pick(6, 5, 4)
    this.segsPerStrike = quality.pick(640, 460, 320)
    const rainCount = quality.pick(20000, 12000, 7000)
    const octaves = quality.pick(5, 4, 3)
    this.internalScale = quality.pick(1, 0.85, 0.7)

    const slots = this.strikeSlots + this.miniSlots
    this.bolts = new Array(slots).fill(null)
    this.intensity = new Float32Array(slots)

    const half: { type: THREE.TextureDataType; filter: THREE.MagnificationTextureFilter } = {
      // HDR で描いてから合成パスでトーンマップする。
      // 縮小レンダリングを拡大して出すので LinearFilter が必須
      type: THREE.HalfFloatType,
      filter: THREE.LinearFilter,
    }
    this.sceneRT = createRenderTarget(1, 1, half)
    this.bloomA = createRenderTarget(1, 1, half)
    this.bloomB = createRenderTarget(1, 1, half)

    this.cloudPass = new Pass(buildCloudShader(octaves), {
      uTime: { value: 0 },
      uAspect: { value: this.aspect },
      uFlashes: { value: Array.from({ length: MAX_FLASH }, () => new THREE.Vector3()) },
      uSheet: { value: 0 },
    })
    this.brightPass = new Pass(BRIGHT_FRAG, { uScene: { value: null } })
    this.blurPass = new Pass(BLUR_FRAG, {
      uSource: { value: null },
      uDir: { value: new THREE.Vector2() },
    })
    this.compositePass = new Pass(COMPOSITE_FRAG, {
      uScene: { value: null },
      uBloom: { value: null },
      uBloomStrength: { value: quality.pick(0.85, 0.7, 0.55) },
      uLift: { value: 0 },
    })

    this.buildBoltPool(slots)
    this.buildRain(rainCount)

    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)

    this.resize(ctx.width, ctx.height)
  }

  /** 全ボルト共有のクアッドプール。未使用領域は幅・輝度ゼロで面積ごと潰れる */
  private buildBoltPool(slots: number): void {
    const totalSegs = this.strikeSlots * this.segsPerStrike + this.miniSlots * MINI_SEGS
    const verts = totalSegs * 4

    const corner = new Float32Array(verts * 2)
    const index = new Uint32Array(totalSegs * 6)
    for (let i = 0; i < totalSegs; i++) {
      const v = i * 4
      // 4頂点 = (沿い0,横-1)(沿い0,横+1)(沿い1,横-1)(沿い1,横+1)
      corner.set([0, -1, 0, 1, 1, -1, 1, 1], v * 2)
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6)
    }

    const geometry = new THREE.BufferGeometry()
    this.aSeg = new THREE.BufferAttribute(new Float32Array(verts * 4), 4)
    this.aMeta = new THREE.BufferAttribute(new Float32Array(verts * 3), 3)
    geometry.setAttribute('aSeg', this.aSeg)
    geometry.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2))
    geometry.setAttribute('aMeta', this.aMeta)
    geometry.setIndex(new THREE.BufferAttribute(index, 1))
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

    this.boltMaterial = new THREE.ShaderMaterial({
      vertexShader: buildBoltVert(slots),
      fragmentShader: BOLT_FRAG,
      uniforms: {
        uAspect: { value: this.aspect },
        uIntensity: { value: this.intensity },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // クアッドの巻き方向は線分の向きで反転するので、カリングを切らないと
      // 半分（この頂点順では全部）が消える
      side: THREE.DoubleSide,
    })
    this.boltMesh = new THREE.Mesh(geometry, this.boltMaterial)
    this.boltMesh.frustumCulled = false
    this.stormScene.add(this.boltMesh)
  }

  /** 雨。頂点シェーダだけで落ち続けるので CPU コストはゼロ */
  private buildRain(count: number): void {
    const seeds = new Float32Array(count * 2 * 3)
    const tips = new Float32Array(count * 2)
    for (let i = 0; i < count; i++) {
      const sx = Math.random()
      const sy = Math.random()
      const depth = Math.random()
      for (let v = 0; v < 2; v++) {
        const o = (i * 2 + v) * 3
        seeds[o] = sx
        seeds[o + 1] = sy
        seeds[o + 2] = depth
        tips[i * 2 + v] = v
      }
    }

    const geometry = new THREE.BufferGeometry()
    // three.js は position 属性が無い非インデックスジオメトリを
    // 頂点数 0 とみなして描画しない。中身は使わないのでゼロ埋めでよい
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3),
    )
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3))
    geometry.setAttribute('aTip', new THREE.BufferAttribute(tips, 1))
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

    this.rainMaterial = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAspect: { value: this.aspect },
        uWind: { value: 0.25 },
        uGlint: { value: 0 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.rain = new THREE.LineSegments(geometry, this.rainMaterial)
    this.rain.frustumCulled = false
    this.stormScene.add(this.rain)
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    this.pressing = true
    this.holdTime = 0
    this.holdTimer = 0.2
    const tx = (event.clientX / Math.max(1, window.innerWidth)) * this.aspect
    this.spawnStrike(tx, 1)
  }

  private onPointerUp = (): void => {
    this.pressing = false
  }

  /** カーソル位置（等方座標） */
  private cursor(): { x: number; y: number } {
    return { x: pointer.ux * this.aspect, y: 1 - pointer.uy }
  }

  /** 本落雷。雲底の少し横から、カーソル直下の地面へ向けて枝分かれしながら降りる */
  private spawnStrike(tx: number, power: number): void {
    const slot = this.nextStrike
    this.nextStrike = (this.nextStrike + 1) % this.strikeSlots

    // 着弾は常に稜線の上。空中で途切れた稲妻は「不発」に見える
    const x = clamp(tx, 0.02, this.aspect - 0.02)
    const y = ridgeBase(x) + 0.004
    const sx = clamp(x + (Math.random() - 0.5) * 0.34, 0.04, this.aspect - 0.04)
    const sy = CLOUD_BASE - 0.05 + Math.random() * 0.14

    const segs: number[] = []
    const budget = { left: this.segsPerStrike }
    const width = 0.0042 * (0.85 + 0.4 * Math.random())
    this.subdivide(sx, sy, x, y, 7, width, 1, 0, segs, budget)
    this.writeSlot(slot, slot * this.segsPerStrike, this.segsPerStrike, segs)

    this.bolts[slot] = { birth: this.now, kind: 'strike', power }
    // 雲の照明はチャネル上端（雲へ入る点）へ、着弾の照り返しは地面へ置く
    this.pushFlash(sx, sy, 1.1 * power)
    this.pushFlash(x, y, 0.9 * power)
    this.lift = Math.min(1.6, this.lift + 0.55 * power + 0.25 * Math.random())
  }

  private pushFlash(x: number, y: number, strength: number): void {
    this.flashes[this.nextFlash] = { x, y, strength, birth: this.now }
    this.nextFlash = (this.nextFlash + 1) % MAX_FLASH
  }

  /** カーソルにまとわりつく小さな放電 */
  private spawnMini(cx: number, cy: number): void {
    const slot = this.strikeSlots + this.nextMini
    this.nextMini = (this.nextMini + 1) % this.miniSlots

    const ang = Math.random() * Math.PI * 2
    const len = 0.05 + Math.random() * 0.05
    const segs: number[] = []
    const budget = { left: MINI_SEGS }
    // branchDepth を上限にして枝分かれを禁止し、短い一筋だけにする
    this.subdivide(
      cx,
      cy,
      cx + Math.cos(ang) * len,
      cy + Math.sin(ang) * len,
      4,
      0.0018,
      0.6,
      2,
      segs,
      budget,
    )
    const offset = this.strikeSlots * this.segsPerStrike + this.nextMiniOffset(slot)
    this.writeSlot(slot, offset, MINI_SEGS, segs)
    this.bolts[slot] = { birth: this.now, kind: 'mini', power: 1 }
  }

  private nextMiniOffset(slot: number): number {
    return (slot - this.strikeSlots) * MINI_SEGS
  }

  /** シートフラッシュ：稲妻は見えず、雲だけが内側から光る */
  private sheetFlash(): void {
    this.sheetBirth = this.now
    this.sheetPower = 0.5 + Math.random() * 0.4
    this.lift = Math.min(1.6, this.lift + 0.25)
  }

  /**
   * 中点変位法。線分の中点を法線方向へずらして再帰し、level 0 で確定する。
   * 中間スケールの節からは確率で枝を分ける（枝の枝まで、2段で打ち切り）。
   */
  private subdivide(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    level: number,
    width: number,
    bright: number,
    branchDepth: number,
    out: number[],
    budget: { left: number },
  ): void {
    if (budget.left <= 0) return
    if (level <= 0) {
      out.push(ax, ay, bx, by, width, bright)
      budget.left--
      return
    }

    const dx = bx - ax
    const dy = by - ay
    const len = Math.max(Math.hypot(dx, dy), 1e-6)
    // 三角分布（一様乱数2つの和）。ガウスの安価な代用
    const g = Math.random() + Math.random() - 1
    const px = (ax + bx) / 2 + (-dy / len) * g * len * 0.3
    const py = (ay + by) / 2 + (dx / len) * g * len * 0.3

    if (level >= 3 && level <= 5 && branchDepth < 2 && budget.left > 8 && Math.random() < 0.3) {
      const ang =
        Math.atan2(by - py, bx - px) + (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.55)
      const blen = len * (0.5 + Math.random() * 0.5)
      this.subdivide(
        px,
        py,
        px + Math.cos(ang) * blen,
        py + Math.sin(ang) * blen,
        level - 2,
        width * 0.55,
        bright * 0.45,
        branchDepth + 1,
        out,
        budget,
      )
    }

    this.subdivide(ax, ay, px, py, level - 1, width, bright, branchDepth, out, budget)
    this.subdivide(px, py, bx, by, level - 1, width, bright, branchDepth, out, budget)
  }

  /** スロットの担当領域へセグメントを書き込む。余りはゼロ埋めして消す */
  private writeSlot(slot: number, offset: number, size: number, segs: number[]): void {
    const segArr = this.aSeg.array as Float32Array
    const metaArr = this.aMeta.array as Float32Array
    const n = Math.min(segs.length / 6, size)

    for (let i = 0; i < size; i++) {
      const live = i < n
      for (let v = 0; v < 4; v++) {
        const vi = (offset + i) * 4 + v
        if (live) {
          segArr[vi * 4] = segs[i * 6]
          segArr[vi * 4 + 1] = segs[i * 6 + 1]
          segArr[vi * 4 + 2] = segs[i * 6 + 2]
          segArr[vi * 4 + 3] = segs[i * 6 + 3]
          metaArr[vi * 3] = segs[i * 6 + 4]
          metaArr[vi * 3 + 1] = segs[i * 6 + 5]
          metaArr[vi * 3 + 2] = slot
        } else {
          segArr[vi * 4] = 0
          segArr[vi * 4 + 1] = 0
          segArr[vi * 4 + 2] = 0
          segArr[vi * 4 + 3] = 0
          metaArr[vi * 3] = 0
          metaArr[vi * 3 + 1] = 0
        }
      }
    }
    this.aSeg.needsUpdate = true
    this.aMeta.needsUpdate = true
  }

  /** リーダーの一閃 → 減衰 → 再放電2回、のフリッカー包絡線 */
  private strikeEnvelope(t: number): number {
    if (t < 0 || t > STRIKE_LIFE) return 0
    let k = Math.exp(-t * 10)
    if (t > 0.11) k = Math.max(k, 0.8 * Math.exp(-(t - 0.11) * 12))
    if (t > 0.24) k = Math.max(k, 0.55 * Math.exp(-(t - 0.24) * 12))
    return k * (0.8 + 0.4 * Math.random())
  }

  update(dt: number, elapsed: number): void {
    const step = Math.min(dt, 1 / 30)
    this.now = elapsed

    // --- スケジューリング ---

    // 押しっぱなしで連続落雷。長く押すほど着弾が散らばって嵐が育つ
    if (this.pressing) {
      this.holdTime += step
      this.holdTimer -= step
      if (this.holdTimer <= 0) {
        const c = this.cursor()
        const scatter = Math.min(0.09, 0.02 + this.holdTime * 0.02)
        this.spawnStrike(
          c.x + (Math.random() - 0.5) * 2 * scatter,
          0.85 + Math.random() * 0.3,
        )
        this.holdTimer = 0.16 + Math.random() * 0.12
      }
    }

    // マウスが動いている間はカーソルの先で小さくパチパチと放電する
    this.crackleTimer -= step
    const moving = pointer.active && performance.now() - pointer.lastMove < 220
    if (moving && !this.pressing && this.crackleTimer <= 0) {
      const c = this.cursor()
      this.spawnMini(c.x, c.y)
      this.crackleTimer = 0.07 + Math.random() * 0.06
    }

    // 放置中の自動ストーム。稜線の上へランダムに落ち、ときどきシートフラッシュ
    this.ambientTimer -= step
    if (this.ambientTimer <= 0) {
      if (!pointer.active || pointer.idleFor(3000)) {
        if (Math.random() < 0.72) {
          const x = 0.06 + Math.random() * Math.max(0.1, this.aspect - 0.12)
          this.spawnStrike(x, 0.8 + Math.random() * 0.4)
        } else {
          this.sheetFlash()
        }
        this.ambientTimer = 0.8 + Math.random() * 1.8
      } else {
        this.ambientTimer = 0.5 // 操作中は控えて、少し先でまた様子を見る
      }
    }

    // --- 明滅の更新 ---

    for (let i = 0; i < this.bolts.length; i++) {
      const b = this.bolts[i]
      if (!b) {
        this.intensity[i] = 0
        continue
      }
      const t = elapsed - b.birth
      if (b.kind === 'strike') {
        this.intensity[i] = this.strikeEnvelope(t) * b.power
      } else {
        this.intensity[i] =
          t >= 0 && t < MINI_LIFE ? Math.exp(-t * 14) * (0.7 + 0.5 * Math.random()) : 0
      }
      if (this.intensity[i] <= 0) this.bolts[i] = null
    }

    const flashVecs = this.cloudPass.uniforms.uFlashes.value as THREE.Vector3[]
    for (let i = 0; i < MAX_FLASH; i++) {
      const f = this.flashes[i]
      if (!f || elapsed - f.birth > 1.2) {
        flashVecs[i].set(0, 0, 0)
        continue
      }
      const t = elapsed - f.birth
      flashVecs[i].set(f.x, f.y, f.strength * Math.exp(-t * 7) * (0.7 + 0.6 * Math.random()))
    }

    const sheetT = elapsed - this.sheetBirth
    const sheet =
      sheetT >= 0 && sheetT < 1.5
        ? this.sheetPower * Math.exp(-sheetT * 5) * (0.7 + 0.6 * Math.random())
        : 0
    this.lift *= Math.exp(-7 * step)

    // --- 描画 ---

    const wind = 0.45 + 0.2 * Math.sin(elapsed * 0.07)

    this.cloudPass.set('uTime', elapsed)
    this.cloudPass.set('uAspect', this.aspect)
    this.cloudPass.set('uSheet', sheet)
    this.cloudPass.render(this.renderer, this.sceneRT)

    this.boltMaterial.uniforms.uAspect.value = this.aspect
    this.rainMaterial.uniforms.uTime.value = elapsed
    this.rainMaterial.uniforms.uAspect.value = this.aspect
    this.rainMaterial.uniforms.uWind.value = wind
    this.rainMaterial.uniforms.uGlint.value = Math.min(1.5, this.lift * 0.8 + sheet * 0.4)

    // 雲の上に稲妻と雨を加算で重ねる
    this.renderer.autoClear = false
    this.renderer.setRenderTarget(this.sceneRT)
    this.renderer.render(this.stormScene, fullscreenCamera)
    this.renderer.setRenderTarget(null)
    this.renderer.autoClear = true

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
    this.compositePass.set('uLift', this.lift)
    this.compositePass.render(this.renderer, null)
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
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    this.stormScene.remove(this.boltMesh)
    this.stormScene.remove(this.rain)
    this.boltMesh.geometry.dispose()
    this.boltMaterial.dispose()
    this.rain.geometry.dispose()
    this.rainMaterial.dispose()
    this.sceneRT.dispose()
    this.bloomA.dispose()
    this.bloomB.dispose()
    for (const pass of [this.cloudPass, this.brightPass, this.blurPass, this.compositePass]) {
      pass.dispose()
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 地面の稜線の高さ。shaders.ts の ridgeBase() と同じ式にしておくこと */
function ridgeBase(x: number): number {
  return (
    0.10 +
    0.035 * Math.sin(x * 3.1 + 1.7) +
    0.018 * Math.sin(x * 7.3 + 0.4) +
    0.010 * Math.sin(x * 13.7 + 2.6)
  )
}
