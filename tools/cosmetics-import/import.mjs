/**
 * Импорт 3D-моделей в меш-косметику Hytpotchi.
 *
 *   node import.mjs              — пересобрать все предметы из items/*.json
 *   node import.mjs jester_hat   — только этот предмет (каталог пересобирается целиком)
 *
 * На каждый предмет — конфиг items/<id>.json (см. README.md). Модель (.glb/.gltf, например со
 * Sketchfab) упрощается до maxTriangles, переводится в координаты модели Minecraft (пиксели,
 * ось Y вниз, лицо смотрит в −Z), масштабируется и садится на кость персонажа. Результат:
 *
 *   server/skins/assets/cosmetics/<id>/mesh*.json + tex*.png   — раздаёт сервер Hytpotchi
 *   server/skins/src/cosmetics-meshes.ts                       — меш-детали для каталога
 *
 * Формат mesh.json (его читают мод и лаунчер):
 *   { format: 1, textures: ["tex0.png"], groups: [{ texture: 0 | -1, v: [...], i: [...] }] }
 *   v — по 11 чисел на вершину: x y z (пиксели от точки опоры), u v, nx ny nz, r g b (0…1);
 *   i — треугольники (индексы вершин). texture −1 — без текстуры, только цвет вершин.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const ITEMS_DIR = join(HERE, 'items')
const ASSETS = join(REPO, 'server/skins/assets/cosmetics')
const OUT_TS = join(REPO, 'server/skins/src/cosmetics-meshes.ts')

const BONES = ['head', 'body', 'left_arm', 'right_arm']
const ANIMS = ['flap_left', 'flap_right', 'sway', 'spin']

// ── Конфиги ─────────────────────────────────────────────────────────────────────

function loadConfigs() {
  if (!existsSync(ITEMS_DIR)) return []
  return readdirSync(ITEMS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const c = JSON.parse(readFileSync(join(ITEMS_DIR, f), 'utf8'))
      const err = (m) => {
        throw new Error(`items/${f}: ${m}`)
      }
      if (!/^[a-z_]{2,32}$/.test(c.id ?? '')) err('id — латиница и _, 2…32 символа')
      if (`${c.id}.json` !== f) err('имя файла должно совпадать с id')
      if (!BONES.includes(c.bone)) err(`bone — одно из ${BONES.join(', ')}`)
      if (!c.source) err('нет source — путь к .glb')
      if (!c.credit?.author || !c.credit?.url || !c.credit?.license) err('credit: нужны author, url, license')
      if (c.anim && !ANIMS.includes(c.anim)) err(`anim — одно из ${ANIMS.join(', ')}`)
      if (c.split && c.split !== 'x') err('split — только "x" (левая и правая половины)')
      if (!c.fit || !['x', 'y', 'z', 'max', 'scale'].includes(c.fit.axis) || !(c.fit.size > 0)) err('fit: {axis: x|y|z|max|scale, size}')
      return {
        rotate: [0, 0, 0],
        anchor: [0.5, 1, 0.5],
        at: [0, 0, 0],
        maxTriangles: 2500,
        textureSize: 256,
        ...c,
      }
    })
}

// ── Математика ──────────────────────────────────────────────────────────────────

/** Матрица поворота 3×3 (строки) по углам в градусах, порядок X, потом Y, потом Z */
function rotation([ax, ay, az]) {
  const [x, y, z] = [ax, ay, az].map((d) => (d * Math.PI) / 180)
  const rx = [1, 0, 0, 0, Math.cos(x), -Math.sin(x), 0, Math.sin(x), Math.cos(x)]
  const ry = [Math.cos(y), 0, Math.sin(y), 0, 1, 0, -Math.sin(y), 0, Math.cos(y)]
  const rz = [Math.cos(z), -Math.sin(z), 0, Math.sin(z), Math.cos(z), 0, 0, 0, 1]
  return mul3(rz, mul3(ry, rx))
}

function mul3(a, b) {
  const r = new Array(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]
  return r
}

const apply3 = (m, [x, y, z]) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z]

/** Точка через матрицу glTF 4×4 (по столбцам) */
const applyMat4 = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
]

/** Матрица нормалей (обратная транспонированная к 3×3 части), строками */
function normalMatrix(m) {
  const a = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a
  const c0 = a4 * a8 - a5 * a7
  const c1 = a5 * a6 - a3 * a8
  const c2 = a3 * a7 - a4 * a6
  const det = a0 * c0 + a1 * c1 + a2 * c2 || 1
  // inverse-transpose = cofactor / det
  return [
    c0 / det, c1 / det, c2 / det,
    (a2 * a7 - a1 * a8) / det, (a0 * a8 - a2 * a6) / det, (a1 * a6 - a0 * a7) / det,
    (a1 * a5 - a2 * a4) / det, (a2 * a3 - a0 * a5) / det, (a0 * a4 - a1 * a3) / det,
  ]
}

const norm = ([x, y, z]) => {
  const l = Math.hypot(x, y, z) || 1
  return [x / l, y / l, z / l]
}

const r = (v, d) => Math.round(v * d) / d || 0

// ── Чтение модели ───────────────────────────────────────────────────────────────

/**
 * Все треугольники сцены в мировых координатах glTF, сгруппированные по материалу.
 * Группа: { key, image, mime, alpha, verts: [{p, n, uv, c}], idx: [] }
 */
async function readModel(file, nodes) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
  const doc = await io.read(file)
  const root = doc.getRoot()
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  if (!scene) throw new Error('в модели нет сцены')
  const groups = new Map()
  let skipped = 0
  // Фильтр по пути узлов в сцене («Корень/Шляпа/Лента») — чтобы взять из модели только сам предмет
  const include = nodes?.include ? new RegExp(nodes.include, 'i') : null
  const exclude = nodes?.exclude ? new RegExp(nodes.exclude, 'i') : null
  const pathOf = (node) => {
    const names = []
    for (let n = node; n; n = n.getParentNode()) names.unshift(n.getName() || '?')
    return names.join('/')
  }

  scene.traverse((node) => {
    const mesh = node.getMesh()
    if (!mesh) return
    const path = pathOf(node)
    if ((include && !include.test(path)) || (exclude && exclude.test(path))) return
    if (listNodes) console.log(`  узел: ${path} (${mesh.listPrimitives().reduce((n, p) => n + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0) / 3, 0)} треуг.)`)
    const world = node.getSkin() ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] : node.getWorldMatrix()
    const nmat = normalMatrix(world)
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) {
        skipped++
        continue
      }
      const pos = prim.getAttribute('POSITION')
      if (!pos) continue
      const mat = prim.getMaterial()
      const sg = mat?.getExtension('KHR_materials_pbrSpecularGlossiness')
      const texInfo = sg ? sg.getDiffuseTextureInfo() : mat?.getBaseColorTextureInfo()
      const tex = sg ? sg.getDiffuseTexture() : mat?.getBaseColorTexture()
      const factor = (sg ? sg.getDiffuseFactor() : mat?.getBaseColorFactor()) ?? [1, 1, 1, 1]
      const uvAttr = prim.getAttribute(`TEXCOORD_${texInfo?.getTexCoord() ?? 0}`)
      const nAttr = prim.getAttribute('NORMAL')
      const cAttr = prim.getAttribute('COLOR_0')
      const xf = texInfo?.getExtension('KHR_texture_transform')
      const key = tex && uvAttr ? tex : `color:${mat?.getName() ?? ''}:${factor.join(',')}`
      let g = groups.get(key)
      if (!g) {
        g = { image: tex && uvAttr ? tex.getImage() : null, mime: tex?.getMimeType(), alpha: mat?.getAlphaMode() ?? 'OPAQUE', verts: [], idx: [] }
        groups.set(key, g)
      }
      const base = g.verts.length
      const count = pos.getCount()
      const el = []
      for (let i = 0; i < count; i++) {
        const p = applyMat4(world, pos.getElement(i, el).slice(0, 3))
        const n = nAttr ? norm(apply3(nmat, nAttr.getElement(i, el).slice(0, 3))) : null
        let uv = uvAttr ? uvAttr.getElement(i, el).slice(0, 2) : [0, 0]
        if (xf) uv = textureTransform(uv, xf)
        const c = cAttr ? cAttr.getElement(i, el) : [1, 1, 1]
        g.verts.push({ p, n, uv, c: [c[0] * factor[0], c[1] * factor[1], c[2] * factor[2]] })
      }
      const ind = prim.getIndices()
      if (ind) {
        const arr = ind.getArray()
        for (let i = 0; i < arr.length; i++) g.idx.push(base + arr[i])
      } else {
        for (let i = 0; i < count; i++) g.idx.push(base + i)
      }
    }
  })
  if (skipped) console.log(`  пропущено примитивов не из треугольников: ${skipped}`)
  return [...groups.values()].filter((g) => g.idx.length >= 3)
}

function textureTransform([u, v], xf) {
  const [ox, oy] = xf.getOffset()
  const [sx, sy] = xf.getScale()
  const rot = xf.getRotation()
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const x = u * sx
  const y = v * sy
  return [c * x + s * y + ox, -s * x + c * y + oy]
}

/** Нормали по граням, где в модели их нет */
function fillNormals(g) {
  if (g.verts.every((v) => v.n)) return
  const acc = g.verts.map(() => [0, 0, 0])
  for (let t = 0; t < g.idx.length; t += 3) {
    const [a, b, c] = [g.idx[t], g.idx[t + 1], g.idx[t + 2]].map((i) => g.verts[i].p)
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    for (const i of [g.idx[t], g.idx[t + 1], g.idx[t + 2]]) for (let k = 0; k < 3; k++) acc[i][k] += n[k]
  }
  g.verts.forEach((v, i) => (v.n ??= norm(acc[i])))
}

// ── Упрощение ───────────────────────────────────────────────────────────────────

function simplify(groups, maxTriangles) {
  const total = groups.reduce((n, g) => n + g.idx.length / 3, 0)
  if (total <= maxTriangles) return total
  const ratio = maxTriangles / total
  let after = 0
  for (const g of groups) {
    const positions = new Float32Array(g.verts.flatMap((v) => v.p))
    const indices = new Uint32Array(g.idx)
    const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3)
    let [out] = MeshoptSimplifier.simplify(indices, positions, 3, target, 0.05, [])
    // Швы текстуры не дают схлопнуть сетку — тогда грубее, без сохранения топологии
    if (out.length > target * 1.3) [out] = MeshoptSimplifier.simplifySloppy(indices, positions, 3, null, target, 0.05)
    g.idx = [...out]
    after += g.idx.length / 3
  }
  return after
}

/** Убрать вершины, на которые больше не ссылаются треугольники */
function compact(g) {
  const map = new Map()
  const verts = []
  g.idx = g.idx.map((i) => {
    let j = map.get(i)
    if (j === undefined) {
      j = verts.length
      map.set(i, j)
      verts.push(g.verts[i])
    }
    return j
  })
  g.verts = verts
}

// ── Текстуры ────────────────────────────────────────────────────────────────────

async function writeTexture(g, size, file) {
  let img = sharp(Buffer.from(g.image)).resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
  if (g.alpha === 'OPAQUE') img = img.removeAlpha()
  await img.png({ compressionLevel: 9 }).toFile(file)
  const meta = await sharp(file).metadata()
  return `${meta.width}×${meta.height}`
}

// ── Предмет ─────────────────────────────────────────────────────────────────────

/** Файл модели: сам .glb/.gltf или первый такой в папке (архивы Sketchfab распаковываются как есть) */
function findModel(source) {
  const p = resolve(HERE, source)
  if (!existsSync(p)) return null
  if (/\.(glb|gltf)$/i.test(p)) return p
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name)
      if (e.isFile() && /\.(glb|gltf)$/i.test(e.name)) return f
      if (e.isDirectory()) {
        const r = walk(f)
        if (r) return r
      }
    }
    return null
  }
  return walk(p)
}

async function convert(cfg) {
  const src = findModel(cfg.source)
  if (!src) throw new Error(`${cfg.id}: нет модели (.glb/.gltf) в ${cfg.source}`)
  console.log(`${cfg.id}: ${src.slice(HERE.length + 1)}`)
  const groups = await readModel(src, cfg.nodes)
  if (!groups.length) throw new Error(`${cfg.id}: в модели нет треугольников`)
  const before = groups.reduce((n, g) => n + g.idx.length / 3, 0)
  for (const g of groups) fillNormals(g)
  const after = simplify(groups, cfg.maxTriangles)
  for (const g of groups) compact(g)
  console.log(`  треугольников: ${before} → ${after}, материалов: ${groups.length}`)

  // glTF (Y вверх, лицо +Z) → Minecraft (Y вниз, лицо −Z): поворот на 180° вокруг X
  const rot = rotation(cfg.rotate)
  const toMc = ([x, y, z]) => [x, -y, -z]
  for (const g of groups) for (const v of g.verts) {
    v.p = toMc(apply3(rot, v.p))
    v.n = norm(toMc(apply3(rot, v.n)))
  }

  const bounds = () => {
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (const g of groups) for (const t of g.idx) for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], g.verts[t].p[k])
      hi[k] = Math.max(hi[k], g.verts[t].p[k])
    }
    return [lo, hi]
  }

  // Обрезка: оставить треугольники, чей центр в доле габарита [x0, y0, z0, x1, y1, z1]
  // (уже в осях Minecraft: y = 0 — верх модели). Для моделей, где предмет слит с персонажем
  if (cfg.crop) {
    const [lo, hi] = bounds()
    const inside = (c, k) => {
      const f = (c - lo[k]) / (hi[k] - lo[k] || 1)
      return f >= cfg.crop[k] && f <= cfg.crop[k + 3]
    }
    for (const g of groups) {
      const idx = []
      for (let t = 0; t < g.idx.length; t += 3) {
        const c = [0, 1, 2].map((k) => (g.verts[g.idx[t]].p[k] + g.verts[g.idx[t + 1]].p[k] + g.verts[g.idx[t + 2]].p[k]) / 3)
        if (c.every(inside)) idx.push(g.idx[t], g.idx[t + 1], g.idx[t + 2])
      }
      g.idx = idx
      compact(g)
    }
    console.log(`  после обрезки: ${groups.reduce((n, g) => n + g.idx.length / 3, 0)} треуг.`)
  }

  // Размер и посадка: точка anchor (доли габарита) встаёт в точку at кости
  const [min, max] = bounds()
  const dims = [0, 1, 2].map((k) => max[k] - min[k])
  // scale — просто множитель (модели из Blockbench: 1 единица = блок = 16 пикселей); иначе — размер по оси
  const ref = cfg.fit.axis === 'max' ? Math.max(...dims) : dims['xyz'.indexOf(cfg.fit.axis)]
  const scale = cfg.fit.axis === 'scale' ? cfg.fit.size : cfg.fit.size / (ref || 1)
  const anchor = [0, 1, 2].map((k) => min[k] + dims[k] * cfg.anchor[k])
  for (const g of groups) for (const v of g.verts) v.p = v.p.map((c, k) => (c - anchor[k]) * scale)
  console.log(`  размер в пикселях: ${dims.map((d) => r(d * scale, 10)).join(' × ')}`)

  // Каталог файлов предмета
  const dir = join(ASSETS, cfg.id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const textures = new Map()
  for (const g of groups) {
    if (!g.image) continue
    if (!textures.has(g.image)) {
      const name = `tex${textures.size}.png`
      const size = await writeTexture(g, cfg.textureSize, join(dir, name))
      console.log(`  ${name}: ${size}`)
      textures.set(g.image, textures.size)
    }
  }
  const texNames = [...textures.keys()].map((_, i) => `tex${i}.png`)

  // Одна деталь или левая/правая половины (для взмахов крыльями)
  const halves = cfg.split === 'x' ? [(c) => c >= 0, (c) => c < 0] : [() => true]
  const files = []
  halves.forEach((keep, h) => {
    const out = []
    for (const g of groups) {
      const idx = []
      for (let t = 0; t < g.idx.length; t += 3) {
        const cx = (g.verts[g.idx[t]].p[0] + g.verts[g.idx[t + 1]].p[0] + g.verts[g.idx[t + 2]].p[0]) / 3
        if (keep(cx)) idx.push(g.idx[t], g.idx[t + 1], g.idx[t + 2])
      }
      if (!idx.length) continue
      const part = { ...g, idx }
      compact(part)
      out.push({
        texture: g.image ? textures.get(g.image) : -1,
        v: part.verts.flatMap((v) => [
          r(v.p[0], 1000), r(v.p[1], 1000), r(v.p[2], 1000),
          r(v.uv[0], 10000), r(v.uv[1], 10000),
          r(v.n[0], 100), r(v.n[1], 100), r(v.n[2], 100),
          r(v.c[0], 1000), r(v.c[1], 1000), r(v.c[2], 1000),
        ]),
        i: part.idx,
      })
    }
    const name = halves.length > 1 ? `mesh-${h === 0 ? 'left' : 'right'}.json` : 'mesh.json'
    const tris = out.reduce((n, g) => n + g.i.length / 3, 0)
    writeFileSync(join(dir, name), JSON.stringify({ format: 1, triangles: tris, textures: texNames, groups: out }))
    console.log(`  ${name}: ${tris} треуг.`)
    files.push(name)
  })
  return files
}

/** Меш-детали предмета для каталога (по конфигу и уже собранным файлам) */
function meshParts(cfg) {
  const dir = join(ASSETS, cfg.id)
  const base = { bone: cfg.bone, pivot: cfg.at, ...(cfg.rot && { rot: cfg.rot }) }
  if (cfg.split === 'x') {
    return [
      { ...base, ...(cfg.anim !== null && { anim: 'flap_left' }), mesh: `cosmetics/${cfg.id}/mesh-left.json` },
      { ...base, ...(cfg.anim !== null && { anim: 'flap_right' }), mesh: `cosmetics/${cfg.id}/mesh-right.json` },
    ].filter((p) => existsSync(join(dir, p.mesh.split('/').pop())))
  }
  return [{ ...base, ...(cfg.anim && { anim: cfg.anim }), mesh: `cosmetics/${cfg.id}/mesh.json` }]
}

function writeCatalog(configs) {
  const items = configs
    .filter((c) => existsSync(join(ASSETS, c.id)))
    .map((c) => ({
      id: c.id,
      ...(c.name && { name: c.name }),
      ...(c.slot && { slot: c.slot }),
      credit: c.credit,
      meshes: meshParts(c),
    }))
  const body = `/**
 * Меш-косметика: 3D-модели вместо кубов. СГЕНЕРИРОВАНО tools/cosmetics-import — не править руками,
 * меняйте конфиги в tools/cosmetics-import/items и запускайте импорт заново.
 *
 * Файлы моделей — server/skins/assets/cosmetics/<id>/. Новые мод и лаунчер рисуют meshes,
 * старые их не знают и рисуют кубы из parts.
 */
import type { MeshItem } from './cosmetics.ts'

export const MESH_ITEMS: MeshItem[] = ${JSON.stringify(items, null, 2)}
`
  writeFileSync(OUT_TS, body)
  console.log(`каталог: ${items.length} меш-предметов → ${OUT_TS.slice(REPO.length + 1)}`)
}

// ── Запуск ──────────────────────────────────────────────────────────────────────

await MeshoptDecoder.ready
await MeshoptSimplifier.ready
const configs = loadConfigs()
const listNodes = process.argv.includes('--nodes')
const only = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (only && !configs.some((c) => c.id === only)) throw new Error(`нет items/${only}.json`)
for (const cfg of configs) {
  if (only && cfg.id !== only) continue
  if (!findModel(cfg.source)) {
    console.log(`${cfg.id}: модели ещё нет в ${cfg.source} — пропускаю`)
    continue
  }
  await convert(cfg)
}
writeCatalog(configs)
