# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このリポジトリについて

高校生に「コードでここまで作れる」を見せるためのデモ用サイト。数式と GPU 計算だけで描く6つの
インタラクティブ作品を、1つの静的サイトに収めている。画像・動画・外部APIは一切使わない。

公開先: https://wakabayashi-agent.github.io/hello-universe/

**設計判断はすべて「5分・説明なしで伝わるか」で決まる。** 開いた瞬間すでに動いていて、
マウスを動かすだけで反応が返ることが必須要件。チュートリアル・ログイン・ロード待ち・
長い説明文が要る機能は、どれだけ良くても入れない。

放置しても画面が動き続ける仕掛け（cosmos の19秒周期、fluid の自動スプラット、
fractal の14秒放置で自動ツアー開始、blackhole の常時自動周回、slime のリサージュ
仮想フィーダー）はこの要件から来ているので、壊さないこと。

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバ |
| `npm run build` | `dist/` に本番ビルド |
| `npm run typecheck` | 型チェック。CI が通す唯一の検査 |

テストは無い。壊れていないことの確認は後述の「動作確認」で行う。

## アーキテクチャ

- **WebGL コンテキストはサイト全体で1つだけ。** `src/core/Stage.ts` が `WebGLRenderer` と
  RAF ループを所有する。作品の切り替えは dispose → mount。作品ごとに renderer を作らない。
- **作品は `Work` インターフェース**（`src/core/Work.ts`）を実装する。`mount` で確保したものは
  `dispose` で必ず解放する。漏れると作品を往復するたびに GPU メモリが増える。
- **作品の追加は `WORKS` 配列にメタ情報を足すだけ。** 動的 import で分割されるので他に影響しない。
- **品質ティア（high/mid/low）は mount 時に確定させ、実行中は変えない。** 粒子数や
  シミュレーション解像度はバッファの大きさそのものなので、途中で変えるとカクつく。
  フレーム落ち時に下げてよいのは描画解像度（`Quality.scale`）だけ。
- **シェーダは `shaders.ts` にテンプレート文字列として置く。** `.glsl` にすると Vite プラグインが要る。
- **GLSL ES 1.0 なのでループ上限は定数でなければならない。** 反復回数やテクスチャサイズを
  可変にしたいシェーダは、`buildFractalShader()` / `buildVelocityShader()` のように
  `#define` を埋め込んで文字列を組み立てる関数にする。
- コメントは日本語で書く（既存コードに合わせる）。

## 動作確認

**この開発環境（Claude Code の Browser ペイン）では `document.hidden` が常に true で、
`requestAnimationFrame` が1フレームも発火しない。** 画面が初期状態のまま止まって見えても、
それは環境の制約であってサイトのバグではない。ここを取り違えると存在しないバグを追うことになる。

見た目を確認するときは、開発ビルド限定で公開している `window.__work` で手動でフレームを進める:

```js
const w = window.__work
w.resize(innerWidth, innerHeight)   // ペインのサイズ変更が伝わっていないことがある
w.time = 0; w.spin = 0              // cosmos はタイムラインを持つ
for (let i = 0; i < 400; i++) w.update(1 / 60, i / 60)
```

`window.__stage` から `quality.tier` を書き換えれば、低スペック環境での見え方も確認できる。
GPU タイマー（`gl.finish()` 前後の計測）はこの環境では当てにならず、fps の実測はできない。

色や明るさの判断は目視だけに頼らず、`gl.readPixels()` で平均輝度と標準偏差を出すと確実。
標準偏差がほぼ 0 なら画面がべた塗りになっている、と数値で判定できる。

## 踏んだ落とし穴

- **誤差補償を使う多倍長演算（double-single）はシェーダでは成立しない。** WebKit/Metal の
  コンパイラが fast-math で `(a+b)-a → b` のように誤差項を畳んでしまう。`* uOne` のような
  目隠しも効かない（実測で確認済み）。フラクタルの深いズームは摂動法で解決している。
- **オーバーレイのレイアウト用コンテナに `pointer-events: auto` を付けない。** `.work` /
  `.gallery` は全画面を覆うため、クリックが canvas に届かなくなる。`#overlay` の中は既定で
  素通しにし、`button` / `input` など実際に操作する要素だけ `auto` に戻す。
- **half float の圧力場は毎フレーム減衰させる。** 積み上がると Inf → NaN になり、
  流体の画面が突然真っ黒になる。
- **粒子の明るさは、描画面積と文字の占有面積に比例させる。** 固定値にすると、短い言葉や
  狭い画面で白飛びする。
- **フラクタルの色は反復回数に「比例」させる。** sqrt や log で圧縮すると深部ほど縞が広がり、
  発散回数の差が数回しかない領域が一面のべた塗りになる。
- **`wheel` の `deltaMode` を正規化する。** Chrome/Safari は px、Firefox は行単位で返すため、
  そのまま使うと Firefox でほとんど拡大できない。
- **three.js の `AdditiveBlending` は src 係数が `SrcAlpha`。** `gl_FragColor` の alpha を 0 に
  すると寄与がまるごと消える（画面には何のエラーも出ない）。加算で値だけ足したいときは
  alpha を 1.0 にするか、alpha を輝度係数として使う（gravity / slime の堆積が前例）。
- **Physarum のセンシングは飽和させ、蓄積場はクランプする。** 飽和が無いと「濃い幹ほど
  無限に有利」になり網全体が数本のメガトレイルへ崩壊する。餌のように毎フレーム
  スプラットされる場は上限を切らないと、操作をやめた後も数十秒引きずる。

## デプロイ

`main` に push すると GitHub Actions が typecheck → build → GitHub Pages 公開まで行う。

- `vite.config.ts` の `base` は `'./'`。絶対パスにするとサブディレクトリ公開で壊れるので変えない。
- 更新直後は、キャッシュに残った古い `index.html` が新しいチャンクを取りに行って 404 になる
  ことがある（最大10分）。作品の読み込みに失敗したときは再読み込みボタンを出すようにしてある。
