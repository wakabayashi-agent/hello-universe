import './styles/main.css'
import { Stage } from './core/Stage'
import { checkSupport } from './core/Quality'
import { pointer } from './core/pointer'
import { findWork, WORKS } from './core/Work'
import { renderGallery } from './gallery/Gallery'
import { renderWorkChrome } from './ui/WorkChrome'
import { clear, el } from './ui/dom'

const canvas = document.getElementById('stage') as HTMLCanvasElement
const overlay = document.getElementById('overlay') as HTMLElement

const support = checkSupport()
if (!support.ok) {
  showFatal(support.reason ?? '対応していない環境です。')
} else {
  boot()
}

function showFatal(message: string): void {
  canvas.remove()
  document.body.append(
    el('div', { class: 'fatal' }, [
      el('strong', {}, ['この環境では表示できません']),
      el('p', {}, [message]),
    ]),
  )
}

function boot(): void {
  pointer.attach()

  const bootScreen = el('div', { class: 'boot' }, [el('div', { class: 'boot__ring' })])
  document.body.append(bootScreen)

  const stage = new Stage(canvas, overlay)
  if (import.meta.env.DEV) {
    // 開発時に品質ティアを切り替えて確認できるようにする
    ;(window as unknown as { __stage: Stage }).__stage = stage
  }

  // 起動時に ?text= が付いていればそれを宇宙の文字にする（当日は学校名を入れる）
  const params = new URLSearchParams(location.search)
  const customText = params.get('text')?.slice(0, 40) || null

  let bootDone = false
  const finishBoot = (): void => {
    if (bootDone) return
    bootDone = true
    // 粒子が集まり始めてから覆いを外す
    setTimeout(() => {
      bootScreen.classList.add('boot--gone')
      setTimeout(() => bootScreen.remove(), 800)
    }, 250)
  }

  const go = (hash: string): void => {
    if (location.hash === hash) route()
    else location.hash = hash
  }

  async function route(): Promise<void> {
    const id = location.hash.replace(/^#\/?/, '').trim()
    clear(overlay)

    const meta = findWork(id)
    if (!meta) {
      // トップページ：背景で cosmos を流しつつ作品カードを並べる
      renderGallery(overlay, (next) => go(`#/${next}`))
      await stage.mount(WORKS[0], {
        hero: true,
        text: customText ?? 'HELLO,\nUNIVERSE',
      })
    } else {
      renderWorkChrome(overlay, meta, () => go('#/'))
      await stage.mount(meta, meta.id === 'cosmos' ? { text: customText ?? undefined } : {})
    }
    finishBoot()
  }

  window.addEventListener('hashchange', () => void route())
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && location.hash !== '' && location.hash !== '#/') go('#/')
  })

  void route()
}
