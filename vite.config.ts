import { defineConfig } from 'vite'

export default defineConfig({
  // 相対パスにしておくと GitHub Pages のサブディレクトリ公開でも
  // ローカルの file:// でもそのまま動く（base パス起因の事故を防ぐ）
  base: './',
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
  },
})
