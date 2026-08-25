import type { WorkMeta } from '../core/Work'
import { el } from './dom'

export interface Chrome {
  /** 作品固有のコントロールを差し込む場所 */
  controls: HTMLElement
}

/** 作品ビューの共通枠（戻るボタン・タイトル・操作ヒント）。 */
export function renderWorkChrome(
  container: HTMLElement,
  meta: WorkMeta,
  onBack: () => void,
): Chrome {
  const controls = el('div', { class: 'work__controls' })

  container.append(
    el('div', { class: 'work' }, [
      el('div', { class: 'work__bar' }, [
        el('button', { class: 'chip', type: 'button', onclick: onBack }, ['← 一覧']),
        el('span', { class: 'work__title' }, [meta.title]),
      ]),
      el('div', { class: 'work__foot' }, [
        el('p', { class: 'work__hint' }, [meta.hint]),
        controls,
      ]),
    ]),
  )

  return { controls }
}
