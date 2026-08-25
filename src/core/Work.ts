import type * as THREE from 'three'
import type { Quality } from './Quality'

/** 作品の実行環境。Stage が組み立てて mount に渡す。 */
export interface WorkContext {
  renderer: THREE.WebGLRenderer
  quality: Quality
  /** 作品固有の UI を置く場所（オーバーレイ内） */
  overlay: HTMLElement
  /** 現在の描画サイズ（CSS ピクセル） */
  width: number
  height: number
}

/**
 * 全作品が実装する共通インターフェース。
 * Stage が mount → 毎フレーム update → 破棄時 dispose を呼ぶ。
 */
export interface Work {
  readonly id: string
  mount(ctx: WorkContext): Promise<void> | void
  update(dt: number, elapsed: number): void
  resize(width: number, height: number): void
  dispose(): void
}

export interface WorkMeta {
  id: string
  /** 日本語タイトル */
  title: string
  /** カードに出す一行説明 */
  desc: string
  /** 作品ビュー下部に出す操作ヒント */
  hint: string
  accentA: string
  accentB: string
  load: () => Promise<{ create(options?: Record<string, unknown>): Work }>
}

export const WORKS: WorkMeta[] = [
  {
    id: 'cosmos',
    title: '言葉から生まれる宇宙',
    desc: '入力した文字が最大26万個の光の粒になり、崩れて銀河になる。',
    hint: 'マウスを動かすと粒が逃げる ／ 文字を入れ替えると宇宙が作り直される',
    accentA: '#64e6ff',
    accentB: '#b06cff',
    load: () => import('../works/cosmos/index'),
  },
  {
    id: 'fluid',
    title: '指先の流体',
    desc: 'マウスの軌跡が渦を巻いて滲む。本物の流体方程式をGPUで解いている。',
    hint: 'マウスを動かすとかき混ぜられる ／ クリックすると強く弾ける',
    accentA: '#ff5f9e',
    accentB: '#ffd166',
    load: () => import('../works/fluid/index'),
  },
  {
    id: 'fractal',
    title: '無限フラクタル',
    desc: 'たった一つの数式が生む世界を、260億倍まで拡大していける。',
    hint: 'ホイールで拡大縮小 ／ ドラッグで移動',
    accentA: '#ffb347',
    accentB: '#3d6bff',
    load: () => import('../works/fractal/index'),
  },
  {
    id: 'gravity',
    title: '重力の庭',
    desc: 'クリックで星を置くと、引力で軌道を描いて惑星系になる。',
    hint: 'クリックで星を置く ／ ドラッグして離すと初速がつく',
    accentA: '#fff1c9',
    accentB: '#ff7a3d',
    load: () => import('../works/gravity/index'),
  },
  {
    id: 'blackhole',
    title: 'ブラックホール',
    desc: '光の進む道をアインシュタインの式で計算すると、この姿が浮かび上がる。',
    hint: 'ドラッグで回り込む ／ ホイールで近づく',
    accentA: '#ffa64d',
    accentB: '#7fb4ff',
    load: () => import('../works/blackhole/index'),
  },
  {
    id: 'slime',
    title: '百万匹の粘菌',
    desc: '最大100万匹の粘菌が、フェロモンの痕跡だけで生きた血管網を織り上げる。',
    hint: 'マウスを動かすと餌につられて網が伸びる ／ 押しっぱなしで蹴散らす',
    accentA: '#7dffa8',
    accentB: '#5f8cff',
    load: () => import('../works/slime/index'),
  },
]

export function findWork(id: string): WorkMeta | undefined {
  return WORKS.find((w) => w.id === id)
}
