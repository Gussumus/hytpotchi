/**
 * Косметика в 3D-предпросмотре (skinview3d) — по тем же данным каталога, что и мод в игре.
 *
 * Каталог описан в координатах модели Minecraft (ось Y вниз, лицо смотрит в −Z). В skinview3d
 * ось Y вверх и лицо смотрит в +Z, поэтому точка (x, y, z) переходит в (x, −y, −z): это поворот
 * на 180° вокруг X, повороты деталей переходят в (rx, −ry, −rz). Кости skinview3d стоят там же,
 * где у Minecraft, кроме тела: у него точка опоры в центре, а у Minecraft — на уровне шеи (+6).
 *
 * Предмет с 3D-моделью (meshes) сначала показывается кубами из parts, а когда модель скачается —
 * ею: так же делает мод в игре.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Euler,
  Group,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  type Object3D,
  type Texture,
} from 'three'
import type { SkinViewer } from 'skinview3d'
import { api } from './ipc'
import type { CosmeticDef, CosmeticMesh, CosmeticMeshPart, CosmeticPart } from './types'

type Placed = Pick<CosmeticPart, 'bone' | 'pivot' | 'rot' | 'anim'>

interface Animated {
  pivot: Group
  part: Placed
}

/** Тот же расчёт, что в моде (t — тики игры, 20 в секунду) */
function animate(a: Animated, t: number) {
  const baseX = a.part.rot?.[0] ?? 0
  const baseY = a.part.rot?.[1] ?? 0
  let yRot = baseY
  let xRot = baseX
  switch (a.part.anim) {
    case 'flap_left':
      yRot = baseY - (0.35 * (1 + Math.sin(t * 0.18))) / 2
      break
    case 'flap_right':
      yRot = baseY + (0.35 * (1 + Math.sin(t * 0.18))) / 2
      break
    case 'sway':
      yRot = baseY + 0.25 * Math.sin(t * 0.1)
      xRot = baseX + 0.05 * Math.sin(t * 0.07)
      break
    case 'spin':
      yRot = t * 0.05
      break
    default:
      return
  }
  a.pivot.rotation.set(xRot, -yRot, -(a.part.rot?.[2] ?? 0), 'ZYX')
}

/** Скачанные модели: одна загрузка на путь за сеанс */
const meshCache = new Map<string, Promise<{ mesh: CosmeticMesh; textures: string[] }>>()

function loadMesh(path: string) {
  let p = meshCache.get(path)
  if (!p) {
    p = api.cosmeticsMesh(path)
    p.catch(() => meshCache.delete(path))
    meshCache.set(path, p)
  }
  return p
}

/** Надеть предметы на модель в просмотрщике. Возвращает функцию, которая всё снимает. */
export function attachCosmetics(viewer: SkinViewer, items: CosmeticDef[]): () => void {
  const skin = viewer.playerObject.skin
  const bones: Record<CosmeticPart['bone'], { node: Object3D; dy: number }> = {
    head: { node: skin.head, dy: 0 },
    body: { node: skin.body, dy: 6 },
    left_arm: { node: skin.leftArm, dy: 0 },
    right_arm: { node: skin.rightArm, dy: 0 },
  }
  let disposed = false
  const added: { parent: Object3D; group: Group }[] = []
  let animated: Animated[] = []
  const materials = new Map<string, MeshStandardMaterial>()
  const owned: { dispose(): void }[] = []

  /** Точка опоры детали на кости, с её поворотом */
  function placePivot(part: Placed): Group | null {
    const bone = bones[part.bone]
    if (!bone) return null
    const [px, py, pz] = part.pivot ?? [0, 0, 0]
    const [rx, ry, rz] = part.rot ?? [0, 0, 0]
    const pivot = new Group()
    pivot.position.set(px, -py + bone.dy, -pz)
    pivot.rotation.copy(new Euler(rx, -ry, -rz, 'ZYX'))
    bone.node.add(pivot)
    added.push({ parent: bone.node, group: pivot })
    if (part.anim) animated.push({ pivot, part })
    return pivot
  }

  function remove(groups: Group[]) {
    for (const g of groups) {
      g.parent?.remove(g)
      const i = added.findIndex((a) => a.group === g)
      if (i >= 0) added.splice(i, 1)
    }
    animated = animated.filter((a) => !groups.includes(a.pivot))
  }

  function addCubes(item: CosmeticDef): Group[] {
    const groups: Group[] = []
    for (const part of item.parts) {
      let mat = materials.get(part.color)
      if (!mat) {
        mat = new MeshStandardMaterial({ color: part.color, roughness: 0.9, metalness: 0 })
        materials.set(part.color, mat)
        owned.push(mat)
      }
      const pivot = placePivot(part)
      if (!pivot) continue
      for (const [x, y, z, w, h, d] of part.cubes) {
        const geo = new BoxGeometry(w, h, d)
        owned.push(geo)
        const mesh = new Mesh(geo, mat)
        mesh.position.set(x + w / 2, -(y + h / 2), -(z + d / 2))
        pivot.add(mesh)
      }
      groups.push(pivot)
    }
    return groups
  }

  function addMesh(part: CosmeticMeshPart, data: { mesh: CosmeticMesh; textures: string[] }) {
    const pivot = placePivot(part)
    if (!pivot) return
    const loader = new TextureLoader()
    const textures: Texture[] = data.textures.map((url) => {
      const t = loader.load(url)
      t.flipY = false
      t.colorSpace = SRGBColorSpace
      t.wrapS = t.wrapT = RepeatWrapping
      t.magFilter = NearestFilter
      t.minFilter = LinearMipmapLinearFilter
      owned.push(t)
      return t
    })
    for (const g of data.mesh.groups) {
      const n = g.v.length / 11
      const pos = new Float32Array(n * 3)
      const nor = new Float32Array(n * 3)
      const uv = new Float32Array(n * 2)
      const col = new Float32Array(n * 3)
      for (let k = 0; k < n; k++) {
        const o = k * 11
        // Minecraft → three.js: (x, y, z) → (x, −y, −z)
        pos.set([g.v[o], -g.v[o + 1], -g.v[o + 2]], k * 3)
        uv.set([g.v[o + 3], g.v[o + 4]], k * 2)
        nor.set([g.v[o + 5], -g.v[o + 6], -g.v[o + 7]], k * 3)
        col.set([g.v[o + 8], g.v[o + 9], g.v[o + 10]], k * 3)
      }
      const geo = new BufferGeometry()
      geo.setAttribute('position', new BufferAttribute(pos, 3))
      geo.setAttribute('normal', new BufferAttribute(nor, 3))
      geo.setAttribute('uv', new BufferAttribute(uv, 2))
      geo.setAttribute('color', new BufferAttribute(col, 3))
      geo.setIndex(g.i)
      const mat = new MeshStandardMaterial({
        map: g.texture >= 0 ? textures[g.texture] : null,
        vertexColors: true,
        side: DoubleSide,
        alphaTest: 0.1,
        roughness: 0.85,
        metalness: 0,
      })
      owned.push(geo, mat)
      pivot.add(new Mesh(geo, mat))
    }
  }

  for (const item of items) {
    const cubes = addCubes(item)
    if (!item.meshes?.length) continue
    const meshes = item.meshes
    Promise.all(meshes.map((m) => loadMesh(m.mesh)))
      .then((data) => {
        if (disposed) return
        remove(cubes)
        meshes.forEach((m, i) => addMesh(m, data[i]))
      })
      .catch((e) => console.warn(`Модель ${item.id} не загрузилась — показываю кубы`, e))
  }

  let raf = 0
  const tick = () => {
    if (animated.length > 0) {
      const t = performance.now() / 50
      for (const a of animated) animate(a, t)
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return () => {
    disposed = true
    cancelAnimationFrame(raf)
    for (const { parent, group } of added) parent.remove(group)
    for (const o of owned) o.dispose()
  }
}
