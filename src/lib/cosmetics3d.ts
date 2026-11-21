/**
 * Косметика в 3D-предпросмотре (skinview3d) — по тем же данным каталога, что и мод в игре.
 *
 * Каталог описан в координатах модели Minecraft (ось Y вниз, лицо смотрит в −Z). В skinview3d
 * ось Y вверх и лицо смотрит в +Z, поэтому точка (x, y, z) переходит в (x, −y, −z): это поворот
 * на 180° вокруг X, повороты деталей переходят в (rx, −ry, −rz). Кости skinview3d стоят там же,
 * где у Minecraft, кроме тела: у него точка опоры в центре, а у Minecraft — на уровне шеи (+6).
 */
import { BoxGeometry, Euler, Group, Mesh, MeshStandardMaterial, type Object3D } from 'three'
import type { SkinViewer } from 'skinview3d'
import type { CosmeticDef, CosmeticPart } from './types'

interface Animated {
  pivot: Group
  part: CosmeticPart
}

/** Тот же расчёт, что CosmeticModel.setupAnim в моде (t — тики игры, 20 в секунду) */
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

/** Надеть предметы на модель в просмотрщике. Возвращает функцию, которая всё снимает. */
export function attachCosmetics(viewer: SkinViewer, items: CosmeticDef[]): () => void {
  const skin = viewer.playerObject.skin
  const bones: Record<CosmeticPart['bone'], { node: Object3D; dy: number }> = {
    head: { node: skin.head, dy: 0 },
    body: { node: skin.body, dy: 6 },
    left_arm: { node: skin.leftArm, dy: 0 },
    right_arm: { node: skin.rightArm, dy: 0 },
  }
  const added: { parent: Object3D; group: Group }[] = []
  const animated: Animated[] = []
  const materials = new Map<string, MeshStandardMaterial>()

  for (const item of items) {
    for (const part of item.parts) {
      const bone = bones[part.bone]
      if (!bone) continue
      let mat = materials.get(part.color)
      if (!mat) {
        mat = new MeshStandardMaterial({ color: part.color, roughness: 0.9, metalness: 0 })
        materials.set(part.color, mat)
      }
      const [px, py, pz] = part.pivot ?? [0, 0, 0]
      const [rx, ry, rz] = part.rot ?? [0, 0, 0]
      const pivot = new Group()
      pivot.position.set(px, -py + bone.dy, -pz)
      pivot.rotation.copy(new Euler(rx, -ry, -rz, 'ZYX'))
      for (const [x, y, z, w, h, d] of part.cubes) {
        const mesh = new Mesh(new BoxGeometry(w, h, d), mat)
        mesh.position.set(x + w / 2, -(y + h / 2), -(z + d / 2))
        pivot.add(mesh)
      }
      bone.node.add(pivot)
      added.push({ parent: bone.node, group: pivot })
      if (part.anim) animated.push({ pivot, part })
    }
  }

  let raf = 0
  if (animated.length > 0) {
    const tick = () => {
      const t = performance.now() / 50
      for (const a of animated) animate(a, t)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  }

  return () => {
    cancelAnimationFrame(raf)
    for (const { parent, group } of added) {
      parent.remove(group)
      group.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose()
      })
    }
    for (const m of materials.values()) m.dispose()
  }
}
