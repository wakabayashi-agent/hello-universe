/**
 * ページ全体で共有するポインタ状態。
 *
 * 各作品が個別に listener を張ると、オーバーレイの UI 上にカーソルがある間だけ
 * 反応しなくなる。window で拾って一箇所に集約しておく。
 */
class PointerState {
  /** CSS ピクセル座標 */
  x = -9999
  y = -9999
  /** 正規化座標 (-1..1, 上が +y)。NDC と同じ向き */
  nx = 0
  ny = 0
  /** 0..1 (上が 0)。テクスチャ座標と同じ向き */
  ux = 0.5
  uy = 0.5
  /** 直前フレームからの移動量（CSS ピクセル） */
  dx = 0
  dy = 0
  down = false
  /** 一度でも画面に入ったか */
  active = false
  /** 最後に動いた時刻（performance.now） */
  lastMove = -Infinity

  private prevX = 0
  private prevY = 0
  private accX = 0
  private accY = 0

  attach(): void {
    window.addEventListener('pointermove', this.onMove, { passive: true })
    window.addEventListener('pointerdown', this.onDown, { passive: true })
    window.addEventListener('pointerup', this.onUp, { passive: true })
    window.addEventListener('pointercancel', this.onUp, { passive: true })
    window.addEventListener('pointerleave', this.onLeave, { passive: true })
  }

  private onMove = (e: PointerEvent): void => {
    if (this.active) {
      this.accX += e.clientX - this.prevX
      this.accY += e.clientY - this.prevY
    }
    this.prevX = e.clientX
    this.prevY = e.clientY
    this.x = e.clientX
    this.y = e.clientY
    this.nx = (e.clientX / window.innerWidth) * 2 - 1
    this.ny = -((e.clientY / window.innerHeight) * 2 - 1)
    this.ux = e.clientX / window.innerWidth
    this.uy = e.clientY / window.innerHeight
    this.active = true
    this.lastMove = performance.now()
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    this.down = true
    this.onMove(e)
  }

  private onUp = (): void => {
    this.down = false
  }

  private onLeave = (): void => {
    this.active = false
    this.down = false
    this.x = -9999
    this.y = -9999
  }

  /** フレーム頭で呼ぶ。この 1 フレームぶんの移動量を確定させる。 */
  beginFrame(): void {
    this.dx = this.accX
    this.dy = this.accY
    this.accX = 0
    this.accY = 0
  }

  /** 直近 ms ミリ秒のあいだ操作が無かったか */
  idleFor(ms: number): boolean {
    return performance.now() - this.lastMove > ms
  }
}

export const pointer = new PointerState()
