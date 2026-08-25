import { WORKS } from '../core/Work'
import { el } from '../ui/dom'

/** トップページのオーバーレイ。背景は cosmos がそのまま動いている。 */
export function renderGallery(container: HTMLElement, onSelect: (id: string) => void): void {
  const cards = WORKS.map((work, i) =>
    el(
      'button',
      {
        class: 'card',
        type: 'button',
        style: `--a:${work.accentA};--b:${work.accentB}`,
        onclick: () => onSelect(work.id),
      },
      [
        el('span', { class: 'card__index' }, [String(i + 1).padStart(2, '0')]),
        el('span', { class: 'card__title' }, [work.title]),
        el('span', { class: 'card__desc' }, [work.desc]),
      ],
    ),
  )

  container.append(
    el('div', { class: 'gallery' }, [
      el('header', { class: 'gallery__head' }, [
        el('div', { class: 'gallery__mark' }, ['Hello, Universe']),
        el('div', { class: 'gallery__sub' }, ['8つのインタラクティブ作品']),
      ]),
      el('footer', { class: 'gallery__foot' }, [
        el('p', { class: 'gallery__lead' }, [
          'ここにあるものは全部、数式とコードだけでできています。画像も動画も使っていません。触ってみてください。',
        ]),
        el('div', { class: 'cards' }, cards),
      ]),
    ]),
  )
}
