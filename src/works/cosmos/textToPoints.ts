const FONT_STACK = '"Zen Kaku Gothic New", "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif'
/** 文字を取れなかったときに使う、球状に散らした場合のおおよその占有率 */
const FALLBACK_COVERAGE = 0.12

export interface SampleOptions {
  text: string
  /** 生成する点の数 */
  count: number
  /** サンプリング用キャンバスの幅（大きいほど字形が細かく出る） */
  canvasWidth: number
  /** ワールド座標での横幅 */
  worldWidth: number
}

/**
 * Web フォントの読み込みを待つ。
 *
 * 待たずに描くと漢字がフォールバックのゴシックになったり、
 * 最悪 tofu（□）になってしまう。ただしネットが遅い会場もあるので
 * タイムアウトを切ってシステムフォントで続行する。
 */
async function waitForFont(text: string, timeoutMs = 2500): Promise<void> {
  if (!('fonts' in document)) return
  const spec = `900 200px "Zen Kaku Gothic New"`
  const load = Promise.all([
    document.fonts.load(spec, text),
    document.fonts.load(`700 200px "Zen Kaku Gothic New"`, text),
  ])
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  await Promise.race([load.then(() => undefined), timeout])
}

export interface SampleResult {
  /** count 個 * vec4。xyz が目標座標、w は粒子ごとの乱数シード */
  points: Float32Array
  /** キャンバス全体のうち文字が占めた割合。明るさの調整に使う */
  coverage: number
}

/**
 * 文字をキャンバスに描き、塗られたピクセルを点群としてサンプリングする。
 */
export async function sampleText(opts: SampleOptions): Promise<SampleResult> {
  const { text, count, canvasWidth, worldWidth } = opts
  const canvasHeight = Math.round(canvasWidth * 0.5)

  await waitForFont(text)

  const canvas = document.createElement('canvas')
  canvas.width = canvasWidth
  canvas.height = canvasHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return { points: fallbackSphere(count, worldWidth * 0.25), coverage: FALLBACK_COVERAGE }

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvasWidth, canvasHeight)

  const lines = text.split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) {
    return { points: fallbackSphere(count, worldWidth * 0.25), coverage: FALLBACK_COVERAGE }
  }

  // 一度大きめのサイズで測ってから、収まる倍率を逆算する
  const probe = 400
  const spacing = /^[\x20-\x7e]*$/.test(text) ? probe * 0.03 : 0
  applyFont(ctx, probe, spacing)
  const widest = Math.max(...lines.map((line) => ctx.measureText(line).width))
  const probeLineHeight = probe * 1.04
  const fitByWidth = (canvasWidth * 0.9) / widest
  const fitByHeight = (canvasHeight * 0.76) / (probeLineHeight * lines.length)
  const fontSize = probe * Math.min(fitByWidth, fitByHeight)

  applyFont(ctx, fontSize, (spacing / probe) * fontSize)
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  const lineHeight = fontSize * 1.04
  const top = canvasHeight / 2 - (lineHeight * lines.length) / 2
  lines.forEach((line, i) => {
    ctx.fillText(line, canvasWidth / 2, top + lineHeight * (i + 0.5))
  })

  const pixels = ctx.getImageData(0, 0, canvasWidth, canvasHeight).data

  // 塗られたピクセルを集める
  const lit: number[] = []
  for (let i = 0; i < canvasWidth * canvasHeight; i++) {
    if (pixels[i * 4] > 100) lit.push(i)
  }
  if (lit.length === 0) {
    return { points: fallbackSphere(count, worldWidth * 0.25), coverage: FALLBACK_COVERAGE }
  }

  shuffle(lit)

  // ピクセル座標 → ワールド座標
  const scale = worldWidth / canvasWidth
  const out = new Float32Array(count * 4)
  const jitter = scale * 0.9

  for (let i = 0; i < count; i++) {
    const index = lit[i % lit.length]
    const px = index % canvasWidth
    const py = Math.floor(index / canvasWidth)
    // 点の数がピクセル数を超えるぶんは微小なゆらぎで埋めて密度を稼ぐ
    const jx = (Math.random() - 0.5) * jitter
    const jy = (Math.random() - 0.5) * jitter

    out[i * 4] = (px - canvasWidth / 2) * scale + jx
    out[i * 4 + 1] = -(py - canvasHeight / 2) * scale + jy
    // わずかに厚みを持たせると、回したときに立体に見える
    out[i * 4 + 2] = gaussian() * worldWidth * 0.012
    out[i * 4 + 3] = Math.random()
  }
  return { points: out, coverage: lit.length / (canvasWidth * canvasHeight) }
}

function applyFont(ctx: CanvasRenderingContext2D, size: number, letterSpacing: number): void {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string }
  if ('letterSpacing' in c) c.letterSpacing = `${letterSpacing}px`
  ctx.font = `900 ${size}px ${FONT_STACK}`
}

/**
 * 渦巻銀河の点群。爆散したあとの受け皿になる。
 *
 * 腕だけだと図形的になりすぎるので、3つの成分を混ぜる。
 *  - 腕（62%）  … 渦の骨格
 *  - 円盤（26%）… 腕の間を埋める拡散成分。これが無いと銀河に見えない
 *  - バルジ（12%）… 中心の球状のふくらみ。ここが光ると一気に銀河らしくなる
 */
export function generateGalaxy(count: number, radius: number): Float32Array {
  const out = new Float32Array(count * 4)
  const arms = 2
  const twist = 3.1

  for (let i = 0; i < count; i++) {
    const roll = Math.random()
    let x: number
    let y: number
    let z: number

    if (roll < 0.12) {
      // バルジ：中心に密集した球
      const r = Math.pow(Math.random(), 1.9) * radius * 0.3
      const u = Math.random() * 2 - 1
      const theta = Math.random() * Math.PI * 2
      const s = Math.sqrt(1 - u * u)
      x = Math.cos(theta) * s * r
      y = Math.sin(theta) * s * r
      z = u * r * 0.7
    } else {
      // 中心ほど密になるよう分布を寄せる
      const r = Math.pow(Math.random(), 0.62) * radius
      let angle: number
      if (roll < 0.38) {
        // 円盤：角度をばらけさせて腕の隙間を埋める
        angle = Math.random() * Math.PI * 2
      } else {
        const arm = Math.floor(Math.random() * arms)
        // 腕の太さ。内側は細く、外側ほどほどけて見えるように広げる
        const spread = 0.1 + (r / radius) * 0.3
        angle = (arm / arms) * Math.PI * 2 + (r / radius) * twist * Math.PI + gaussian() * spread
      }
      const thickness = 0.035 + Math.exp(-r / (radius * 0.22)) * 0.1
      x = Math.cos(angle) * r
      y = Math.sin(angle) * r * 0.94
      z = gaussian() * radius * thickness
    }

    out[i * 4] = x
    out[i * 4 + 1] = y
    out[i * 4 + 2] = z
    out[i * 4 + 3] = Math.random()
  }
  return out
}

/** 文字が取れなかったときの保険。球状に散らす。 */
function fallbackSphere(count: number, radius: number): Float32Array {
  const out = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1
    const theta = Math.random() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const r = radius * Math.cbrt(Math.random())
    out[i * 4] = Math.cos(theta) * s * r
    out[i * 4 + 1] = Math.sin(theta) * s * r
    out[i * 4 + 2] = u * r
    out[i * 4 + 3] = Math.random()
  }
  return out
}

/** 初期位置。外側の殻から文字へ吸い込まれてくる見せ方にする。 */
export function generateShell(count: number, radius: number): Float32Array {
  const out = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1
    const theta = Math.random() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const r = radius * (0.85 + Math.random() * 0.3)
    out[i * 4] = Math.cos(theta) * s * r
    out[i * 4 + 1] = Math.sin(theta) * s * r
    out[i * 4 + 2] = u * r * 0.5
    out[i * 4 + 3] = Math.random()
  }
  return out
}

function gaussian(): number {
  // Box-Muller。ほどよく中央に寄った散らばりが欲しいだけなので 1 本で足りる
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function shuffle(arr: number[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
}
