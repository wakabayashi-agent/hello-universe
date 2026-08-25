import * as THREE from 'three'

/**
 * 全画面を覆う三角形。クアッド(2三角形)より対角線の継ぎ目が無い分わずかに速い。
 * uv は 0..2 まで伸ばしてあり、画面内(0..1)で正しい値になる。
 */
export const fullscreenGeometry = (() => {
  const g = new THREE.BufferGeometry()
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  )
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2))
  return g
})()

export const fullscreenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/** フラグメントシェーダ1枚を任意のレンダーターゲットへ描くパス。 */
export class Pass {
  readonly material: THREE.ShaderMaterial
  private readonly scene = new THREE.Scene()
  private readonly mesh: THREE.Mesh

  constructor(fragmentShader: string, uniforms: Record<string, THREE.IUniform> = {}) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
    })
    this.mesh = new THREE.Mesh(fullscreenGeometry, this.material)
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.material.uniforms
  }

  set(name: string, value: unknown): void {
    const u = this.material.uniforms[name]
    if (u) u.value = value
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target)
    renderer.render(this.scene, fullscreenCamera)
    renderer.setRenderTarget(null)
  }

  dispose(): void {
    this.material.dispose()
  }
}

export interface RTOptions {
  type?: THREE.TextureDataType
  filter?: THREE.MagnificationTextureFilter
  wrap?: THREE.Wrapping
}

export function createRenderTarget(
  width: number,
  height: number,
  opts: RTOptions = {},
): THREE.WebGLRenderTarget {
  const filter = opts.filter ?? THREE.NearestFilter
  const rt = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    format: THREE.RGBAFormat,
    type: opts.type ?? THREE.FloatType,
    minFilter: filter,
    magFilter: filter,
    wrapS: opts.wrap ?? THREE.ClampToEdgeWrapping,
    wrapT: opts.wrap ?? THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  })
  rt.texture.generateMipmaps = false
  return rt
}

/**
 * GPGPU の要。読み用と書き用の2枚を持ち、1ステップごとに入れ替える。
 * 「前フレームの状態を読みつつ次の状態を書く」を1枚のテクスチャでやると
 * 同じテクスチャの読み書きになって未定義動作になるため、2枚を交互に使う。
 */
export class PingPong {
  private a: THREE.WebGLRenderTarget
  private b: THREE.WebGLRenderTarget

  constructor(width: number, height: number, opts: RTOptions = {}) {
    this.a = createRenderTarget(width, height, opts)
    this.b = createRenderTarget(width, height, opts)
  }

  get read(): THREE.WebGLRenderTarget {
    return this.a
  }
  get write(): THREE.WebGLRenderTarget {
    return this.b
  }
  get texture(): THREE.Texture {
    return this.a.texture
  }

  swap(): void {
    const t = this.a
    this.a = this.b
    this.b = t
  }

  setSize(width: number, height: number): void {
    this.a.setSize(Math.max(1, width), Math.max(1, height))
    this.b.setSize(Math.max(1, width), Math.max(1, height))
  }

  dispose(): void {
    this.a.dispose()
    this.b.dispose()
  }
}

const COPY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uSource;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uSource, vUv); }
`

let copyPass: Pass | null = null

/** DataTexture などを PingPong の両面へ焼き込む（初期状態の投入に使う）。 */
export function seedPingPong(
  renderer: THREE.WebGLRenderer,
  target: PingPong,
  source: THREE.Texture,
): void {
  copyPass ??= new Pass(COPY_FRAG, { uSource: { value: null } })
  copyPass.set('uSource', source)
  copyPass.render(renderer, target.read)
  copyPass.render(renderer, target.write)
}

/** RGBA float の DataTexture を作る。GPGPU の初期状態用。 */
export function createDataTexture(data: Float32Array, width: number, height: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType)
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

/**
 * 粒子インデックス → データテクスチャの uv を対応づける attribute。
 * テクセル中心を指すよう 0.5 ずらす。
 */
export function createReferenceAttribute(size: number): THREE.BufferAttribute {
  const refs = new Float32Array(size * size * 2)
  for (let i = 0; i < size * size; i++) {
    refs[i * 2] = ((i % size) + 0.5) / size
    refs[i * 2 + 1] = (Math.floor(i / size) + 0.5) / size
  }
  return new THREE.BufferAttribute(refs, 2)
}

/** よく使うノイズ関数群。各シェーダから文字列結合で取り込む。 */
export const GLSL_NOISE = /* glsl */ `
vec3 hash33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
}

float snoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dot(hash33(i + vec3(0,0,0)), f - vec3(0,0,0)),
            dot(hash33(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
        mix(dot(hash33(i + vec3(0,1,0)), f - vec3(0,1,0)),
            dot(hash33(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
    mix(mix(dot(hash33(i + vec3(0,0,1)), f - vec3(0,0,1)),
            dot(hash33(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
        mix(dot(hash33(i + vec3(0,1,1)), f - vec3(0,1,1)),
            dot(hash33(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y),
    u.z);
}

/** 発散ゼロのベクトル場。粒子が一箇所に溜まらず、渦を巻きながら流れる */
vec3 curlNoise(vec3 p) {
  const float e = 0.1;
  float n1 = snoise(vec3(p.x, p.y + e, p.z));
  float n2 = snoise(vec3(p.x, p.y - e, p.z));
  float n3 = snoise(vec3(p.x, p.y, p.z + e));
  float n4 = snoise(vec3(p.x, p.y, p.z - e));
  float n5 = snoise(vec3(p.x + e, p.y, p.z));
  float n6 = snoise(vec3(p.x - e, p.y, p.z));
  return normalize(vec3(n1 - n2 - (n3 - n4), n3 - n4 - (n5 - n6), n5 - n6 - (n1 - n2)) + 1e-6);
}
`
