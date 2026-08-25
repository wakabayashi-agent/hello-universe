import * as THREE from 'three'
import type { Work, WorkMeta } from './Work'
import { Quality } from './Quality'
import { pointer } from './pointer'

/**
 * WebGL コンテキストと RAF ループの持ち主。
 *
 * サイト全体でコンテキストは 1 つだけ。作品の切り替えは
 * dispose → mount で行い、GPU リソースを持ち越さない。
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer
  readonly quality = new Quality()

  private current: Work | null = null
  private workOverlay: HTMLElement
  private raf = 0
  private lastTime = 0
  private elapsed = 0
  private running = false
  private mountToken = 0

  constructor(canvas: HTMLCanvasElement, workOverlay: HTMLElement) {
    this.workOverlay = workOverlay
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // 加算合成の粒子中心なので MSAA より解像度に予算を回す
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    })
    this.renderer.setClearColor(0x05060d, 1)
    this.renderer.autoClear = true
    this.applySize()

    window.addEventListener('resize', this.onResize)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.quality.onChange(this.applySize)
  }

  // ウィンドウが 0 サイズになる状況（最小化・非表示のiframe など）がある。
  // そのまま setSize すると viewport が 0x0 になり、以後何も描かれなくなる
  private get cssWidth(): number {
    return Math.max(1, window.innerWidth)
  }
  private get cssHeight(): number {
    return Math.max(1, window.innerHeight)
  }

  private applySize = (): void => {
    this.renderer.setPixelRatio(this.quality.pixelRatio)
    this.renderer.setSize(this.cssWidth, this.cssHeight, false)
    this.current?.resize(this.cssWidth, this.cssHeight)
  }

  private onResize = (): void => {
    this.applySize()
  }

  private onVisibility = (): void => {
    // 裏に回ったら描画を止める。戻ったときの巨大な dt も防ぐ
    if (document.hidden) this.stop()
    else this.start()
  }

  /** 作品を差し替える。前の作品は必ず dispose してから次を載せる。 */
  async mount(meta: WorkMeta, options: Record<string, unknown> = {}): Promise<void> {
    const token = ++this.mountToken
    this.disposeCurrent()

    const mod = await meta.load()
    // 読み込み中に別の作品へ遷移していたら破棄する
    if (token !== this.mountToken) return

    const work = mod.create(options)
    await work.mount({
      renderer: this.renderer,
      quality: this.quality,
      overlay: this.workOverlay,
      width: this.cssWidth,
      height: this.cssHeight,
    })
    if (token !== this.mountToken) {
      work.dispose()
      return
    }

    this.current = work
    if (import.meta.env.DEV) {
      ;(window as unknown as { __work: Work }).__work = work
    }
    this.current.resize(this.cssWidth, this.cssHeight)
    this.elapsed = 0
    this.start()
  }

  private disposeCurrent(): void {
    if (!this.current) return
    this.current.dispose()
    this.current = null
    // 作品が確保したテクスチャ・バッファを GPU から確実に手放す
    this.renderer.setRenderTarget(null)
    this.renderer.clear()
  }

  start(): void {
    // 何度呼ばれても「RAF が1本だけ予約されている」状態に揃える。
    // running フラグだけで弾くと、タブが裏に回って RAF が発火しないまま
    // 表に戻ったときにループが死んだままになる
    cancelAnimationFrame(this.raf)
    this.running = true
    this.lastTime = performance.now()
    this.raf = requestAnimationFrame(this.loop)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  private loop = (now: number): void => {
    if (!this.running) return
    this.raf = requestAnimationFrame(this.loop)

    const frameMs = now - this.lastTime
    this.lastTime = now
    // タブ復帰直後などの巨大な dt でシミュレーションが破綻しないよう上限を切る
    const dt = Math.min(frameMs, 50) / 1000
    this.elapsed += dt

    pointer.beginFrame()
    this.current?.update(dt, this.elapsed)
    this.quality.report(frameMs)
  }

  dispose(): void {
    this.stop()
    this.disposeCurrent()
    window.removeEventListener('resize', this.onResize)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.renderer.dispose()
  }
}
