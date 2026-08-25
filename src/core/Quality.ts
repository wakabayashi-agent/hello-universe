export type Tier = 'high' | 'mid' | 'low'

const TIER_ORDER: Tier[] = ['high', 'mid', 'low']

/**
 * 描画品質の決定と、実行中の自動引き下げ。
 *
 * 生徒の PC は性能がバラバラなので「重くて動かない」を最優先で避ける。
 * - tier … 粒子数やシミュレーション解像度。mount 時に確定し、途中で変えない
 *          （バッファを作り直すとカクつくため）。次の mount から反映される。
 * - scale … 描画解像度の倍率。フレーム落ちしたら実行中でも即座に下げる。
 */
export class Quality {
  tier: Tier
  /** 描画解像度スケール（1.0 が等倍） */
  scale = 1
  readonly maxPixelRatio: number

  private samples: number[] = []
  private cooldown = 0
  private listeners = new Set<() => void>()

  constructor() {
    this.tier = detectTier()
    // 高 DPI 環境でネイティブ解像度まで描くと一気に重くなる。上限を切る
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5)
  }

  get pixelRatio(): number {
    return this.maxPixelRatio * this.scale
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 毎フレームのフレーム時間(ms)を渡す。必要なら品質を落とす。 */
  report(frameMs: number): void {
    if (this.cooldown > 0) {
      this.cooldown--
      return
    }
    // 極端な値（タブ復帰直後など）は無視
    if (frameMs > 500) {
      this.samples.length = 0
      return
    }
    this.samples.push(frameMs)
    if (this.samples.length < 90) return

    const sorted = [...this.samples].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    this.samples.length = 0

    // 45fps (22.2ms) を下回る状態が続くなら引き下げる。
    // 一度下げたら戻さない（上げ下げを繰り返すハンチングを防ぐ）
    if (median > 22.2) {
      if (this.scale > 0.6) {
        this.scale = Math.max(0.6, this.scale - 0.15)
        this.cooldown = 120
        this.emit()
      } else {
        const i = TIER_ORDER.indexOf(this.tier)
        if (i < TIER_ORDER.length - 1) {
          this.tier = TIER_ORDER[i + 1]
          this.cooldown = 240
        }
      }
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  /** tier ごとの値を引く小さなヘルパー */
  pick<T>(high: T, mid: T, low: T): T {
    return this.tier === 'high' ? high : this.tier === 'mid' ? mid : low
  }
}

function detectTier(): Tier {
  const ua = navigator.userAgent
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua)
  if (isMobile) return 'low'

  const cores = navigator.hardwareConcurrency ?? 4
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8

  if (cores <= 2 || mem <= 2) return 'low'
  if (cores <= 4 || mem <= 4) return 'mid'
  return 'high'
}

export interface GLSupport {
  ok: boolean
  reason?: string
}

/** WebGL2 と浮動小数点レンダーターゲットが使えるか調べる。 */
export function checkSupport(): GLSupport {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2')
  if (!gl) {
    return {
      ok: false,
      reason:
        'このブラウザは WebGL2 に対応していません。Chrome / Edge / Firefox / Safari の最新版でお試しください。',
    }
  }
  const float = gl.getExtension('EXT_color_buffer_float')
  const half = gl.getExtension('EXT_color_buffer_half_float')
  // 後始末（GL コンテキスト数には上限があるため明示的に解放する）
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  if (!float && !half) {
    return {
      ok: false,
      reason:
        'このブラウザ／GPU では浮動小数点テクスチャへの描画がサポートされていません。別の端末でお試しください。',
    }
  }
  return { ok: true }
}
