/**
 * Ещё косметика из кубов: шляпы, очки, вещи за спиной, хвосты. Формат — как в cosmetics.ts
 * (координаты модели Minecraft: пиксели, ось Y вниз, лицо смотрит в −Z; голова — x −4…4, y −8…0,
 * z −4…4, слой шапки скина до ±4,5; тело — y 0…12, спина на z = 2, слой куртки до 2,25).
 */
import type { CosmeticDef, CosmeticPart } from './cosmetics.ts'

type Cube = [number, number, number, number, number, number]
type V3 = [number, number, number]

const round = (v: number) => Math.round(v * 1000) / 1000 || 0
const flipCube = ([x, y, z, w, h, d]: Cube): Cube => [round(-(x + w)), y, z, w, h, d]
/** Кубы и их отражение на другую сторону (x → −x) */
const both = (cubes: Cube[]): Cube[] => [...cubes, ...cubes.map(flipCube)]

/** Деталь и её отражение: точка опоры, поворот и взмах тоже отражаются */
function pair(p: CosmeticPart): CosmeticPart[] {
  const m: CosmeticPart = { ...p, cubes: p.cubes.map(flipCube) }
  if (p.pivot) m.pivot = [round(-p.pivot[0]), p.pivot[1], p.pivot[2]]
  if (p.rot) m.rot = [p.rot[0], round(-p.rot[1]), round(-p.rot[2])]
  if (p.anim === 'flap_left') m.anim = 'flap_right'
  if (p.anim === 'flap_right') m.anim = 'flap_left'
  return [p, m]
}

/** Квадратное кольцо вокруг оси Y: внешняя полуширина r, толщина стенки t, высота h от y */
function ring(r: number, y: number, h: number, t: number): Cube[] {
  return [
    [-r, y, -r, 2 * r, h, t],
    [-r, y, r - t, 2 * r, h, t],
    [-r, y, -r + t, t, h, 2 * r - 2 * t],
    [r - t, y, -r + t, t, h, 2 * r - 2 * t],
  ]
}

/** Точка на квадратичной кривой Безье */
function bezier(p0: V3, p1: V3, p2: V3, t: number): V3 {
  const a = (1 - t) ** 2
  const b = 2 * (1 - t) * t
  const c = t * t
  return [0, 1, 2].map((k) => a * p0[k] + b * p1[k] + c * p2[k]) as V3
}

/** «Трубка» из кубов вдоль кривой: толщина r0 у начала, r1 у конца. Для хвостов, рогов, дуг */
function tube(p0: V3, p1: V3, p2: V3, r0: number, r1: number, n = 14): Cube[] {
  const out: Cube[] = []
  for (let k = 0; k <= n; k++) {
    const t = k / n
    const [x, y, z] = bezier(p0, p1, p2, t)
    const r = r0 + (r1 - r0) * t
    out.push([round(x - r), round(y - r), round(z - r), round(2 * r), round(2 * r), round(2 * r)])
  }
  return out
}

/** Ступенчатый конус вверх: слои от size до 0, каждый на step уже и на h выше */
function cone(size: number, step: number, h: number, layers: number, lean: [number, number] = [0, 0]): Cube[] {
  const out: Cube[] = []
  for (let k = 0; k < layers; k++) {
    const s = round(size - step * k)
    if (s <= 0) break
    // К верхушке конус чуть заваливается (lean — сдвиг x и z на слой, растёт к вершине)
    const dx = round(lean[0] * k * k * 0.15)
    const dz = round(lean[1] * k * k * 0.15)
    out.push([round(-s / 2 + dx), round(-(k + 1) * h), round(-s / 2 + dz), s, h, s])
  }
  return out
}

// ── Голова ──────────────────────────────────────────────────────────────────────

const cowboyHat: CosmeticDef = {
  id: 'cowboy_hat',
  name: 'Ковбойская шляпа',
  slot: 'head',
  price: 79,
  // Широкие поля с загнутыми краями, тулья с вмятиной сверху и тёмная лента
  parts: [
    {
      bone: 'head',
      color: '#8b5a2b',
      cubes: [
        [-6.5, -9, -6.5, 13, 0.8, 13],
        [-7.3, -10.2, -6.5, 1, 1.4, 13],
        [6.3, -10.2, -6.5, 1, 1.4, 13],
      ],
    },
    {
      bone: 'head',
      color: '#7a4e25',
      cubes: [
        [-4, -12.6, -4, 8, 3.6, 8],
        [-4, -13.4, -4, 3.4, 0.8, 8],
        [0.6, -13.4, -4, 3.4, 0.8, 8],
      ],
    },
    { bone: 'head', color: '#3e2614', cubes: [[-4.2, -10.4, -4.2, 8.4, 1.3, 8.4]] },
    { bone: 'head', color: '#c9a227', cubes: [[-0.7, -10.6, -4.45, 1.4, 1.7, 0.3]] }, // пряжка
  ],
}

const beanie: CosmeticDef = {
  id: 'beanie',
  name: 'Шапка-бини',
  slot: 'head',
  price: 0,
  // Вязаная шапка с отворотом в рубчик и помпоном
  parts: [
    { bone: 'head', color: '#2e7d32', cubes: [[-4.6, -10.6, -4.6, 9.2, 2.7, 9.2], [-3.8, -11.4, -3.8, 7.6, 0.8, 7.6]] },
    { bone: 'head', color: '#1b5e20', cubes: [[-4.85, -8, -4.85, 9.7, 1.8, 9.7]] }, // отворот
    {
      bone: 'head',
      color: '#123f16',
      // Рубчик на отвороте: полоски спереди и сзади, чуть выступают
      cubes: [-3.9, -2.3, -0.7, 0.9, 2.5].flatMap((x): Cube[] => [
        [x, -7.9, -4.95, 0.5, 1.6, 0.15],
        [x, -7.9, 4.8, 0.5, 1.6, 0.15],
      ]),
    },
    { bone: 'head', color: '#f5f5f5', cubes: [[-1.2, -13.2, -1.2, 2.4, 1.9, 2.4]] }, // помпон
  ],
}

const cap: CosmeticDef = {
  id: 'cap',
  name: 'Кепка',
  slot: 'head',
  price: 0,
  parts: [
    { bone: 'head', color: '#1565c0', cubes: [[-4.6, -10, -4.6, 9.2, 2.1, 9.2], [-4, -10.6, -4, 8, 0.6, 8]] },
    { bone: 'head', color: '#0d47a1', cubes: [[-4.3, -8.3, -8.8, 8.6, 0.6, 4.3]] }, // козырёк
    {
      bone: 'head',
      color: '#ffffff',
      cubes: [
        [-1, -9.6, -4.75, 2, 1.2, 0.2], // значок спереди
        [-0.5, -11, -0.5, 1, 0.4, 1], // пуговка на макушке
      ],
    },
  ],
}

/** Звезда на грани k-го слоя конуса колпака: на передней грани (сдвиг по x) или боковой (по z) */
function wizardStar(k: number, along: number, face: 'front' | 'left' | 'right', size = 0.8): Cube {
  const half = (8 - 1.15 * k) / 2
  const y = round(-(k + 1) * 1.6 + 0.4)
  if (face === 'front') return [round(along - size / 2), y, round(-half - 0.15), size, size, 0.3]
  const x = face === 'left' ? round(-half - 0.15) : round(half - 0.15)
  return [x, y, round(along - size / 2), 0.3, size, size]
}

const wizardHat: CosmeticDef = {
  id: 'wizard_hat',
  name: 'Колпак волшебника',
  slot: 'head',
  price: 99,
  // Высокий конус со звёздами, чуть наклонён назад и вбок
  parts: [
    { bone: 'head', color: '#1a237e', cubes: [[-6, -9, -6, 12, 0.7, 12]] },
    { bone: 'head', color: '#283593', pivot: [0, -9, 0], rot: [-0.1, 0, 0.08], cubes: cone(8, 1.15, 1.6, 7) },
    {
      bone: 'head',
      color: '#ffd54f',
      pivot: [0, -9, 0],
      rot: [-0.1, 0, 0.08],
      cubes: [
        [-4.2, -1.7, -4.2, 8.4, 0.9, 8.4], // лента
        wizardStar(1, 1.6, 'front', 0.9),
        wizardStar(3, -1, 'front'),
        wizardStar(5, 0.3, 'front', 0.6),
        wizardStar(2, 0.8, 'right'),
        wizardStar(2, -1.2, 'left', 0.9),
        wizardStar(4, 0.2, 'left', 0.6),
      ],
    },
  ],
}

const vikingHelmet: CosmeticDef = {
  id: 'viking_helmet',
  name: 'Шлем викинга',
  slot: 'head',
  price: 129,
  // Железный купол с ободом и наносником, по бокам — изогнутые рога
  parts: [
    { bone: 'head', color: '#9ea3a8', cubes: [[-4.7, -10, -4.7, 9.4, 3, 9.4], [-3.8, -11, -3.8, 7.6, 1, 7.6]] },
    {
      bone: 'head',
      color: '#5f6368',
      cubes: [
        [-4.95, -7.6, -4.95, 9.9, 1, 9.9], // обод
        [-0.5, -7, -5.15, 1, 3.2, 0.5], // наносник
        [-0.4, -11.2, -3.95, 0.8, 4.2, 0.3], // гребень спереди
        [-0.4, -11.2, 3.65, 0.8, 4.2, 0.3],
      ],
    },
    { bone: 'head', color: '#3c4043', cubes: both([[-3.4, -9, -4.85, 0.6, 0.6, 0.2], [-2, -8.2, -5.1, 0.6, 0.6, 0.2]]) }, // заклёпки
    ...pair({ bone: 'head', color: '#efe6d2', pivot: [-4.6, -8.6, 0], cubes: tube([0, 0, 0], [-4, -0.5, 0], [-4.6, -5.4, 0], 1.25, 0.45, 12).slice(0, 10) }),
    ...pair({ bone: 'head', color: '#bcae8f', pivot: [-4.6, -8.6, 0], cubes: tube([0, 0, 0], [-4, -0.5, 0], [-4.6, -5.4, 0], 1.25, 0.45, 12).slice(10) }),
  ],
}

const santaHat: CosmeticDef = {
  id: 'santa_hat',
  name: 'Новогодняя шапка',
  slot: 'head',
  price: 49,
  // Красный колпак свисает назад, белая опушка и помпон
  parts: [
    {
      bone: 'head',
      color: '#c62828',
      cubes: [
        [-4.5, -10.8, -4.5, 9, 2.4, 9],
        [-3.8, -12, -3.6, 7.6, 1.3, 7.2],
        ...tube([0, -12.4, 0], [0, -15.2, 3], [0, -11.4, 6.6], 2.6, 0.9, 12),
      ],
    },
    { bone: 'head', color: '#f5f5f5', cubes: [[-4.9, -8.6, -4.9, 9.8, 1.8, 9.8], [-1.2, -11.8, 5.6, 2.4, 2.4, 2.4]] },
  ],
}

const headphones: CosmeticDef = {
  id: 'headphones',
  name: 'Наушники',
  slot: 'head',
  price: 0,
  // Дуга через макушку и чашки на ушах
  parts: [
    // Дуга из двух половинок, огибает голову снаружи: от чашки вверх и к середине макушки
    { bone: 'head', color: '#263238', cubes: both(tube([-5.3, -4.5, 0], [-5.4, -10.6, 0], [0, -10, 0], 0.6, 0.6, 12)) },
    { bone: 'head', color: '#37474f', cubes: both([[-6.2, -5.8, -2.1, 1.7, 4.2, 4.2]]) },
    { bone: 'head', color: '#ff5252', cubes: both([[-6.4, -4.7, -1.1, 0.3, 2, 2.2]]) },
  ],
}

/** Цветок венка: лепестки и серединка, выступающая наружу (n — куда смотрит: x или z, ±1) */
function flower(cx: number, cz: number, axis: 'x' | 'z', n: number): { petal: Cube; center: Cube } {
  const y = -9.6
  if (axis === 'z') {
    return {
      petal: [cx - 0.75, y, cz - 0.5, 1.5, 1.5, 1],
      center: [cx - 0.3, y + 0.45, n < 0 ? cz - 0.65 : cz + 0.35, 0.6, 0.6, 0.3],
    }
  }
  return {
    petal: [cx - 0.5, y, cz - 0.75, 1, 1.5, 1.5],
    center: [n < 0 ? cx - 0.65 : cx + 0.35, y + 0.45, cz - 0.3, 0.3, 0.6, 0.6],
  }
}

const flowers = [
  { f: flower(-3, -5, 'z', -1), c: '#f06292' },
  { f: flower(-0.6, -5, 'z', -1), c: '#ffffff' },
  { f: flower(1.8, -5, 'z', -1), c: '#ba68c8' },
  { f: flower(4, -5, 'z', -1), c: '#f06292' },
  { f: flower(-5, -2, 'x', -1), c: '#ba68c8' },
  { f: flower(-5, 1.2, 'x', -1), c: '#f06292' },
  { f: flower(5, -2, 'x', 1), c: '#ffffff' },
  { f: flower(5, 1.2, 'x', 1), c: '#ba68c8' },
  { f: flower(-2, 5, 'z', 1), c: '#ffffff' },
  { f: flower(2, 5, 'z', 1), c: '#f06292' },
]

const flowerCrown: CosmeticDef = {
  id: 'flower_crown',
  name: 'Цветочный венок',
  slot: 'head',
  price: 59,
  parts: [
    { bone: 'head', color: '#43a047', cubes: ring(4.8, -9, 1, 0.5) },
    ...['#f06292', '#ffffff', '#ba68c8'].map(
      (color): CosmeticPart => ({ bone: 'head', color, cubes: flowers.filter((x) => x.c === color).map((x) => x.f.petal) }),
    ),
    { bone: 'head', color: '#ffeb3b', cubes: flowers.map((x) => x.f.center) },
  ],
}

// ── Лицо (глаза — на высоте y −4…−3, рот — около −2…−1) ─────────────────────────

const sunglasses: CosmeticDef = {
  id: 'sunglasses',
  name: 'Солнечные очки',
  slot: 'face',
  price: 0,
  parts: [
    {
      bone: 'head',
      color: '#111111',
      cubes: [
        [-4.3, -5, -4.85, 8.6, 0.5, 0.3], // верх оправы
        ...both([[-4.7, -4.9, -4.6, 0.3, 0.5, 4.6]]), // дужки
      ],
    },
    { bone: 'head', color: '#1e2a36', cubes: both([[-3.8, -4.6, -4.8, 3.2, 2, 0.3]]) },
    { bone: 'head', color: '#ffffff', cubes: both([[-3.4, -4.3, -4.85, 0.6, 0.6, 0.1]]) }, // блик
  ],
}

const pixelGlasses: CosmeticDef = {
  id: 'pixel_glasses',
  name: 'Пиксельные очки',
  slot: 'face',
  price: 49,
  // Те самые «крутые» очки: чёрные ступеньки и белые пиксели-блики
  parts: [
    {
      bone: 'head',
      color: '#000000',
      cubes: [
        [-4.6, -4.7, -4.85, 9.2, 0.7, 0.3],
        ...both([
          [-4.1, -4, -4.85, 3.7, 1, 0.3],
          [-3.5, -3, -4.85, 2.5, 0.7, 0.3],
          [-4.9, -4.7, -4.6, 0.3, 0.7, 4.6],
        ]),
      ],
    },
    { bone: 'head', color: '#ffffff', cubes: both([[-3.6, -3.9, -4.95, 0.6, 0.5, 0.1], [-2.9, -3.3, -4.95, 0.6, 0.5, 0.1]]) },
  ],
}

const mustache: CosmeticDef = {
  id: 'mustache',
  name: 'Усы',
  slot: 'face',
  price: 29,
  parts: [
    {
      bone: 'head',
      color: '#4e342e',
      cubes: [[-2.4, -2.7, -4.8, 4.8, 0.9, 0.35], ...both([[-3.4, -2.4, -4.8, 1.1, 0.8, 0.35], [-4, -3, -4.8, 0.7, 0.8, 0.35]])],
    },
  ],
}

// ── Спина ───────────────────────────────────────────────────────────────────────

/**
 * Пиксельный спрайт, выдавленный в объём — как предметы в руке в Minecraft. Строки — пиксели
 * сверху вниз, символ — цвет из палитры, «.» — пусто. Соседние пиксели одного цвета в строке
 * сливаются в один куб. Центр спрайта — в точке опоры детали.
 */
function sprite(
  rows: string[],
  palette: Record<string, string>,
  at: Pick<CosmeticPart, 'bone' | 'pivot' | 'rot' | 'anim'>,
  px: number,
  depth: number,
): CosmeticPart[] {
  const w = Math.max(...rows.map((r) => r.length))
  const h = rows.length
  const byColor = new Map<string, Cube[]>()
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const ch = row[x]
      let end = x + 1
      while (end < row.length && row[end] === ch) end++
      if (ch !== '.') {
        const color = palette[ch]
        if (!color) throw new Error(`нет цвета для «${ch}»`)
        const list = byColor.get(color) ?? []
        list.push([round((x - w / 2) * px), round((y - h / 2) * px), 0, round((end - x) * px), px, depth])
        byColor.set(color, list)
      }
      x = end
    }
  })
  return [...byColor].map(([color, cubes]) => ({ ...at, color, cubes }))
}

const backSword: CosmeticDef = {
  id: 'back_sword',
  name: 'Алмазный меч',
  slot: 'back',
  price: 99,
  // Пиксельный алмазный меч наискосок за спиной: клинок над плечом, рукоять у бока
  parts: sprite(
    [
      '...........ooo',
      '..........oLCo',
      '.........oLCDo',
      '........oLCDo.',
      '.......oLCDo..',
      '......oLCDo...',
      '.....oLCDo....',
      '.oo.oLCDo.....',
      '.oDoCCDo......',
      '..oDCDo.......',
      '..okDDDo......',
      '.okhoooDo.....',
      'okho...oo.....',
      'ooo...........',
    ],
    {
      o: '#123631', // контур
      L: '#b4fbf1', // блик на клинке
      C: '#4fe3cf',
      D: '#1fa391', // тень клинка и гарда
      h: '#7a5230', // рукоять
      k: '#3d2814',
    },
    { bone: 'body', pivot: [0, 5.6, 2.45] },
    0.9,
    0.9,
  ),
}

// Наклон наружу: оперение выглядывает из-за плеча, а не уходит в голову
const quiverAt = { bone: 'body', pivot: [2.4, 5.6, 2.5], rot: [0, 0, 0.62] } as const

const quiver: CosmeticDef = {
  id: 'quiver',
  name: 'Колчан со стрелами',
  slot: 'back',
  price: 59,
  // Кожаный колчан в полоску наискосок, оперением вверх; ремень идёт через грудь
  parts: [
    { ...quiverAt, color: '#8a5a32', cubes: [[-1.6, -4, 0, 3.2, 8, 2.4]] },
    {
      ...quiverAt,
      color: '#5a3a1e',
      cubes: [
        [-1.75, -3.1, -0.15, 3.5, 0.9, 2.7], // полосы
        [-1.75, 1.4, -0.15, 3.5, 0.9, 2.7],
        [-1.75, 3.6, -0.15, 3.5, 0.7, 2.7], // дно
      ],
    },
    { ...quiverAt, color: '#b07a45', cubes: [[-1.85, -4.7, -0.25, 3.7, 0.9, 2.9]] }, // горловина
    {
      ...quiverAt,
      color: '#6b4a2b',
      cubes: [
        [-1.05, -7, 0.65, 0.4, 2.6, 0.4], // древки
        [-0.15, -7.7, 1.1, 0.4, 3.3, 0.4],
        [0.75, -6.7, 0.55, 0.4, 2.3, 0.4],
      ],
    },
    {
      ...quiverAt,
      color: '#f2f2f2',
      cubes: [
        [-1.4, -8.3, 0.5, 1.1, 1.4, 0.7], // оперение
        [-0.5, -9, 0.95, 1.1, 1.4, 0.7],
        [0.4, -8, 0.4, 1.1, 1.4, 0.7],
      ],
    },
    {
      ...quiverAt,
      color: '#9e9e9e',
      cubes: [
        [-1.05, -8.7, 0.65, 0.4, 0.4, 0.4], // хвостовики стрел
        [-0.15, -9.4, 1.1, 0.4, 0.4, 0.4],
        [0.75, -8.4, 0.55, 0.4, 0.4, 0.4],
      ],
    },
    // Ремень через грудь, наискосок спереди
    { bone: 'body', color: '#5a3a1e', pivot: [0, 6, -2.3], rot: [0, 0, -0.59], cubes: [[-0.5, -6.6, -0.3, 1, 13.2, 0.3]] },
  ],
}

const guitar: CosmeticDef = {
  id: 'guitar',
  name: 'Гитара',
  slot: 'back',
  price: 79,
  // Акустическая гитара наискосок, грифом вверх; дека смотрит наружу (+z)
  parts: [
    { bone: 'body', color: '#c77a3a', pivot: [0, 6, 2.4], rot: [0, 0, -0.6], cubes: [[-2.6, 1, 0, 5.2, 4.4, 1.4], [-2.1, -2, 0, 4.2, 3.2, 1.4]] },
    { bone: 'body', color: '#3e2723', pivot: [0, 6, 2.4], rot: [0, 0, -0.6], cubes: [[-0.8, 0.2, 1.35, 1.6, 1.6, 0.15], [-1, 3.6, 1.35, 2, 0.5, 0.2]] }, // розетка и подставка
    { bone: 'body', color: '#5d4037', pivot: [0, 6, 2.4], rot: [0, 0, -0.6], cubes: [[-0.5, -9, 0.3, 1, 7.2, 0.8], [-0.8, -10.4, 0.2, 1.6, 1.4, 1]] }, // гриф и голова
    { bone: 'body', color: '#eeeeee', pivot: [0, 6, 2.4], rot: [0, 0, -0.6], cubes: [[-0.3, -9.4, 1.1, 0.6, 13, 0.08]] }, // струны
  ],
}

const butterflyWings: CosmeticDef = {
  id: 'butterfly_wings',
  name: 'Крылья бабочки',
  slot: 'back',
  price: 149,
  // Синие крылья с чёрной каймой и белыми пятнышками, машут
  parts: [
    // Верхнее крыло больше и шире кверху, нижнее — меньше; чёрная кайма видна по краю
    ...pair({
      bone: 'body',
      color: '#1a1a1a',
      pivot: [1, 3.5, 2.5],
      rot: [0.1, -0.25, 0],
      anim: 'flap_left',
      cubes: [
        [0, -7, 0, 6.4, 7.4, 0.25],
        [3, -8.4, 0, 5.4, 4.4, 0.25],
        [0, 0.2, 0, 5, 5.4, 0.25],
      ],
    }),
    ...pair({
      bone: 'body',
      color: '#1e88e5',
      pivot: [1, 3.5, 2.5],
      rot: [0.1, -0.25, 0],
      anim: 'flap_left',
      cubes: [
        [0.3, -6.7, -0.05, 5.8, 6.8, 0.35],
        [3.3, -8.1, -0.05, 4.8, 3.8, 0.35],
        [0.3, 0.5, -0.05, 4.4, 4.8, 0.35],
      ],
    }),
    ...pair({ bone: 'body', color: '#64b5f6', pivot: [1, 3.5, 2.5], rot: [0.1, -0.25, 0], anim: 'flap_left', cubes: [[0.3, -2.8, -0.08, 3, 2.6, 0.41], [0.3, 0.5, -0.08, 2.2, 2, 0.41]] }),
    ...pair({
      bone: 'body',
      color: '#ffffff',
      pivot: [1, 3.5, 2.5],
      rot: [0.1, -0.25, 0],
      anim: 'flap_left',
      cubes: [
        [6.6, -7.6, -0.1, 0.8, 0.8, 0.45],
        [5.2, -6.6, -0.1, 0.6, 0.6, 0.45],
        [7.2, -5.8, -0.1, 0.6, 0.6, 0.45],
        [3.4, 3.4, -0.1, 0.7, 0.7, 0.45],
      ],
    }),
  ],
}

// ── Хвосты (от поясницы: точка опоры у тела сзади) ──────────────────────────────

const catTail: CosmeticDef = {
  id: 'cat_tail',
  name: 'Кошачий хвост',
  slot: 'tail',
  price: 59,
  // Тонкий, уходит назад и загибается вверх
  parts: [
    { bone: 'body', color: '#212121', pivot: [0, 10.5, 2.3], anim: 'sway', cubes: tube([0, 0, 0], [0, 2.5, 6], [0, -6.5, 7.5], 0.75, 0.6, 16).slice(0, 13) },
    { bone: 'body', color: '#424242', pivot: [0, 10.5, 2.3], anim: 'sway', cubes: tube([0, 0, 0], [0, 2.5, 6], [0, -6.5, 7.5], 0.75, 0.6, 16).slice(13) },
  ],
}

const dragonPath: [V3, V3, V3] = [
  [0, 0, 0],
  [0, 3.5, 6],
  [0, 9.5, 10],
]
/** Шипы вдоль хвоста дракона: по верху трубки через равные промежутки */
const dragonSpikes: Cube[] = [0.12, 0.3, 0.48, 0.66, 0.84].map((t) => {
  const [x, y, z] = bezier(...dragonPath, t)
  const r = 1.9 - 1.5 * t
  const s = round(0.9 - 0.5 * t)
  return [round(x - s / 2), round(y - r - s * 1.2), round(z - s / 2), s, round(s * 1.4), s]
})

const dragonTail: CosmeticDef = {
  id: 'dragon_tail',
  name: 'Хвост дракона',
  slot: 'tail',
  price: 129,
  // Толстый у тела, тянется назад и вниз, по спине — шипы
  parts: [
    { bone: 'body', color: '#2e7d32', pivot: [0, 10, 2.3], anim: 'sway', cubes: tube(...dragonPath, 1.9, 0.4, 14) },
    { bone: 'body', color: '#c0ca33', pivot: [0, 10, 2.3], anim: 'sway', cubes: dragonSpikes },
  ],
}

// ── Над головой ─────────────────────────────────────────────────────────────────

const rainCloud: CosmeticDef = {
  id: 'rain_cloud',
  name: 'Дождевая тучка',
  slot: 'float',
  price: 79,
  // Пушистая тучка над головой, из неё капает
  parts: [
    {
      bone: 'head',
      color: '#eceff1',
      pivot: [0, -14, 0],
      cubes: [
        [-3, -1.6, -2, 6, 2.6, 4],
        [-4.4, -0.8, -1.6, 2, 1.8, 3.2],
        [2.4, -0.8, -1.6, 2.2, 1.8, 3.2],
        [-1.6, -2.8, -1.6, 3.4, 1.4, 3.2],
      ],
    },
    { bone: 'head', color: '#b0bec5', pivot: [0, -14, 0], cubes: [[-4.2, 0.95, -1.5, 8.6, 0.5, 3]] }, // тень снизу
    {
      bone: 'head',
      color: '#4fc3f7',
      pivot: [0, -14, 0],
      cubes: [
        [-2.6, 2, -0.6, 0.35, 0.9, 0.35],
        [-0.6, 2.6, 0.5, 0.35, 0.9, 0.35],
        [1.4, 1.9, -0.3, 0.35, 0.9, 0.35],
        [3, 2.8, 0.8, 0.35, 0.9, 0.35],
      ],
    },
  ],
}

export const EXTRA_ITEMS: CosmeticDef[] = [
  cowboyHat,
  beanie,
  cap,
  wizardHat,
  vikingHelmet,
  santaHat,
  headphones,
  flowerCrown,
  sunglasses,
  pixelGlasses,
  mustache,
  backSword,
  quiver,
  guitar,
  butterflyWings,
  catTail,
  dragonTail,
  rainCloud,
]
