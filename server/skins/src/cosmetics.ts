/**
 * Косметика игроков Hytpotchi: шапки, крылья, хвосты… (видна с модом Hytpotchi Cosmetics).
 *
 * Модели описаны данными, а не кодом: мод и лаунчер строят их из этого каталога, поэтому новый
 * предмет добавляется здесь, без обновления мода.
 *
 *   GET /api/cosmetics/catalog      → {version, items: [CosmeticDef]}
 *   GET /api/cosmetics/<ник>        → {items: [id]}           что надето у игрока
 *   PUT /api/cosmetics/<ник> {items} → {items}                 только владелец ника
 *
 * Геометрия — в координатах модели Minecraft (пиксели, ось Y вниз, лицо смотрит в −Z):
 *   bone  — к какой части тела крепится: head | body | left_arm | right_arm
 *   pivot — точка поворота относительно кости, rot — поворот (радианы, X/Y/Z)
 *   cubes — [x, y, z, ширина, высота, глубина] от точки поворота
 *   anim  — flap_left | flap_right (взмахи крыльев), sway (покачивание), spin (вращение)
 *
 * Голова — куб 8×8×8 (x −4…4, y −8…0, z −4…4), слой шапки скина раздут на 0,5; тело — 8×12×4
 * (z −2…2), слой куртки раздут на 0,25. Грани деталей не кладём в те же плоскости, что и слои
 * скина, иначе они мерцают.
 *
 * Меш-косметика (3D-модели, например со Sketchfab): у предмета есть meshes — детали с готовой
 * сеткой треугольников и текстурами (файлы — /cosmetics/<id>/*, их готовит tools/cosmetics-import).
 * Мод и лаунчер, которые умеют меши, рисуют meshes; старые их не знают и рисуют кубы из parts —
 * поэтому parts у таких предметов — упрощённая запасная модель (или пусто).
 */

import { MESH_ITEMS } from './cosmetics-meshes.ts'
import { EXTRA_ITEMS } from './cosmetics-extra.ts'

type Bone = 'head' | 'body' | 'left_arm' | 'right_arm'
type Anim = 'flap_left' | 'flap_right' | 'sway' | 'spin'

export interface CosmeticPart {
  bone: Bone
  color: string
  pivot?: [number, number, number]
  rot?: [number, number, number]
  anim?: Anim
  cubes: Cube[]
}

type Cube = [number, number, number, number, number, number]

/** Деталь-сетка: mesh — путь к mesh.json от корня сервера (формат — в tools/cosmetics-import) */
export interface MeshPart {
  bone: Bone
  pivot?: [number, number, number]
  rot?: [number, number, number]
  anim?: Anim
  mesh: string
}

/** Автор модели — показывается в лаунчере (того требуют лицензии CC BY) */
export interface Credit {
  title?: string
  author: string
  url: string
  license: string
}

export interface CosmeticDef {
  id: string
  name: string
  /** head | face | back | tail | float — подсказка для интерфейса */
  slot: string
  /** Место на теле: два предмета с одним местом не надеть вместе (новый снимает старый). Нет — ни с чем не спорит */
  spot?: string
  /** Цена в рублях; 0 — бесплатно. Купленный предмет — навсегда (см. shop.ts) */
  price: number
  parts: CosmeticPart[]
  meshes?: MeshPart[]
  credit?: Credit
}

/** Меш-предмет из tools/cosmetics-import: name и slot — только у новых предметов */
export interface MeshItem {
  id: string
  name?: string
  slot?: string
  credit: Credit
  meshes: MeshPart[]
}

export const CATALOG_VERSION = 3

// ── Помощники для построения моделей ─────────────────────────────────────────────

const round = (v: number) => Math.round(v * 1000) / 1000 || 0

/** Куб, отражённый на другую сторону тела (x → −x) */
const flipCube = ([x, y, z, w, h, d]: Cube): Cube => [round(-(x + w)), y, z, w, h, d]

/** Кубы и их зеркальная копия — для симметричных деталей без своего поворота */
const both = (cubes: Cube[]): Cube[] => [...cubes, ...cubes.map(flipCube)]

/** Деталь и её отражение на другую сторону: точка опоры, поворот и взмах тоже отражаются */
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

/** Кубы в четырёх углах (±x, ±z) — для симметричных по кругу деталей */
const corners = ([x, y, z, w, h, d]: Cube): Cube[] => [
  [x, y, z, w, h, d],
  [round(-(x + w)), y, z, w, h, d],
  [x, y, round(-(z + d)), w, h, d],
  [round(-(x + w)), y, round(-(z + d)), w, h, d],
]

/** «Пиксельный» круг радиуса 5: прямые стороны и ступеньки по углам */
function pixelCircle(y: number, h: number): Cube[] {
  return [
    [-2.5, y, -5, 5, h, 1],
    [-2.5, y, 4, 5, h, 1],
    [-5, y, -2.5, 1, h, 5],
    [4, y, -2.5, 1, h, 5],
    ...corners([2.5, y, 3.5, 1, h, 1]),
    ...corners([3.5, y, 2.5, 1, h, 1]),
  ]
}

const JESTER_RED = '#c62828'
const JESTER_BLACK = '#1c1c22'

/**
 * Рога шапки шута с бубенцами: рог идёт от макушки наружу, поднимается и свисает кончиком
 * вниз. Один красный, второй — его отражение чёрным.
 */
function horns(): CosmeticPart[] {
  // Рог — «трубка» из кубов вдоль плавной кривой (квадратичная Безье), к кончику тоньше
  const [p0, p1, p2] = [
    [-0.5, 0],
    [-9, -8],
    [-11.5, 0.5],
  ]
  const cubes: Cube[] = []
  const n = 14
  for (let k = 0; k <= n; k++) {
    const t = k / n
    const x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
    const y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
    const r = 1.8 - 1.2 * t
    cubes.push([round(x - r), round(y - r), round(-r), round(2 * r), round(2 * r), round(2 * r)])
  }
  const side: CosmeticPart = { bone: 'head', color: JESTER_RED, pivot: [-3, -9.6, 0], rot: [0, 0, 0.15], cubes }
  // Бубенчик под кончиком: золотой шарик и тёмный ободок снизу
  const [bx, by] = p2
  const bell: CosmeticPart = {
    ...side,
    color: '#f2c12e',
    cubes: [
      [bx - 1.1, by + 0.4, -1.1, 2.2, 2, 2.2],
      [bx - 0.8, by + 0.1, -0.8, 1.6, 2.6, 1.6],
    ],
  }
  const rim: CosmeticPart = { ...side, color: '#b07a12', cubes: [[bx - 1.3, by + 2.2, -1.3, 2.6, 0.5, 2.6]] }
  return [side, { ...pair(side)[1], color: JESTER_BLACK }, ...pair(bell), ...pair(rim)]
}

/** Ободок шапки шута в шахматку: красные и чёрные клетки по кругу. Возвращает [красные, чёрные] */
function jesterBand(): [Cube[], Cube[]] {
  const r = 4.75
  const t = 0.5
  const y = -8.7
  const h = 2
  const cells: Cube[] = []
  // Спереди и сзади — по 5 клеток, по бокам — по 4 (между передней и задней стенкой)
  for (let k = 0; k < 5; k++) {
    const x = round(-r + k * 1.9)
    cells.push([x, y, -r, 1.9, h, t])
  }
  for (let k = 0; k < 4; k++) cells.push([r - t, y, round(-r + t + k * 2.125), t, h, 2.125])
  for (let k = 4; k >= 0; k--) cells.push([round(-r + k * 1.9), y, r - t, 1.9, h, t])
  for (let k = 3; k >= 0; k--) cells.push([-r, y, round(-r + t + k * 2.125), t, h, 2.125])
  return [cells.filter((_, i) => i % 2 === 0), cells.filter((_, i) => i % 2 === 1)]
}

/**
 * Крылья ангела. Левое крыло тянется в +x от лопатки и отведено назад поворотом, правое —
 * отражение. Сверху плечо, под ним ряд кроющих перьев, ниже — отдельные маховые перья
 * со щелями между ними: к краю крыла они короче, выше и отходят назад, кончики темнее и уже.
 */
function angelWings(): CosmeticPart[] {
  const at = { bone: 'body', pivot: [1.5, 2, 2.6], rot: [0.1, -0.3, 0], anim: 'flap_left' } as const
  // Плечо поднимается к «запястью» и дальше опускается к кончику крыла
  const arm: Cube[] = [
    [0, -1.8, 0.2, 3, 2, 1.6],
    [2.5, -3.8, 0.3, 3, 2.2, 1.5],
    [5, -5.8, 0.4, 3, 2.2, 1.4],
    [7.5, -7, 0.5, 2.5, 1.8, 1.3],
    [9.5, -6.6, 0.6, 2.2, 1.4, 1.2],
    [11.2, -5.9, 0.7, 1.6, 1.2, 1.1],
  ]
  const coverts: Cube[] = [
    [0, 0.2, 0.1, 3, 2.6, 1.4],
    [2.5, -1.8, 0.2, 3, 3, 1.3],
    [5, -3.8, 0.3, 3, 3, 1.2],
    [7.5, -5.4, 0.4, 2.8, 2.8, 1.1],
    [10, -5, 0.5, 2.8, 2.4, 1],
    [12.2, -4.8, 0.6, 1.8, 2, 0.9],
  ]
  // Маховые перья: x, верх (прячется под кроющими), низ. Длиннее к краю — кончик крыла снаружи внизу
  const feathers = [
    [0, 2.2, 6.5],
    [1.45, 1.8, 7.5],
    [2.9, 0.6, 8.4],
    [4.35, 0, 9.2],
    [5.8, -1.4, 10],
    [7.25, -2, 10.7],
    [8.7, -3.2, 11.3],
    [10.15, -3.4, 11.6],
    [11.6, -3.2, 11.2],
    [13.05, -3, 9.6],
  ]
  const body: Cube[] = []
  const tips: Cube[] = []
  feathers.forEach(([x, top, bottom], i) => {
    const z = round(0.15 + i * 0.06)
    const w = i === feathers.length - 1 ? 1.1 : 1.35
    body.push([x, top, z, w, round(bottom - 1.2 - top), 0.7])
    tips.push([round(x + (w - 1) / 2), round(bottom - 1.2), z, 1, 1.2, 0.7])
  })
  return [
    ...pair({ ...at, color: '#ffffff', cubes: arm }),
    ...pair({ ...at, color: '#f3f6fb', cubes: coverts }),
    ...pair({ ...at, color: '#e4eaf4', cubes: body }),
    ...pair({ ...at, color: '#b9c7de', cubes: tips }),
  ]
}

/**
 * Крылья демона, как у летучей мыши. От лопатки к запястью — кость плеча с когтем, от запястья
 * расходятся три пальца-«лесенки»: вбок, по диагонали и вниз. Между ними перепонка, к краю крыла
 * темнее; нижний край провисает между кончиками пальцев.
 */
function demonWings(): CosmeticPart[] {
  const at = { bone: 'body', pivot: [1.5, 2, 2.6], rot: [0.1, -0.28, 0], anim: 'flap_left' } as const
  const bones: Cube[] = [
    [0, -1, 0.15, 3, 1.1, 1.1], // плечо
    [2.6, -2.4, 0.15, 3, 1.1, 1.1],
    [5.2, -3.6, 0.15, 2.6, 1.1, 1.1],
    [7.8, -3.4, 0.25, 1.6, 0.6, 0.9], // палец вбок
    [9.3, -3.1, 0.25, 1.6, 0.6, 0.9],
    [10.8, -2.8, 0.25, 1.5, 0.6, 0.9],
    [7.8, -2.6, 0.25, 0.9, 1.1, 0.9], // палец по диагонали
    [8.6, -1.6, 0.25, 0.9, 1.1, 0.9],
    [9.4, -0.6, 0.25, 0.9, 1.1, 0.9],
    [10.2, 0.4, 0.25, 0.9, 1.1, 0.9],
    [11, 1.4, 0.25, 0.9, 1.1, 0.9],
    [7.2, -2.6, 0.25, 0.7, 1.6, 0.9], // палец вниз
    [7.4, -1, 0.25, 0.7, 1.6, 0.9],
    [7.6, 0.6, 0.25, 0.7, 1.6, 0.9],
    [7.8, 2.2, 0.25, 0.7, 1.6, 0.9],
    [8, 3.8, 0.25, 0.7, 1.6, 0.9],
  ]
  const claws: Cube[] = [
    [7.2, -4.8, 0.3, 0.7, 1.2, 0.7], // коготь на запястье
    [12.2, -3, 0.35, 0.6, 0.6, 0.6], // и на кончиках пальцев
    [11.8, 2.4, 0.35, 0.6, 0.6, 0.6],
    [8.05, 5.3, 0.35, 0.6, 0.6, 0.6],
  ]
  const m = (x: number, y: number, w: number, h: number): Cube => [x, y, 0.45, w, h, 0.45]
  return [
    ...pair({ ...at, color: '#24102c', cubes: bones }),
    ...pair({ ...at, color: '#e8dccb', cubes: claws }),
    // Перепонка от тела до нижнего пальца
    ...pair({ ...at, color: '#5b1a9e', cubes: [m(0, 0.1, 2.6, 4.5), m(2.6, -1.3, 2.6, 7.3), m(5.2, -2.5, 2, 7.9)] }),
    // Между нижним и диагональным пальцем
    ...pair({ ...at, color: '#4a148c', cubes: [m(7.9, -1.5, 0.8, 6.3), m(8.6, -0.5, 1.2, 4.7), m(9.8, 0.5, 1.2, 3), m(11, 2.5, 0.6, 0.9)] }),
    // Между диагональным и боковым пальцем
    ...pair({ ...at, color: '#38106e', cubes: [m(8.7, -2.8, 1.2, 1.2), m(9.5, -2.5, 1.2, 1.9), m(10.3, -2.2, 1.2, 2.6), m(11.1, -2.2, 1.1, 3.6)] }),
  ]
}

// ── Каталог ─────────────────────────────────────────────────────────────────────

const CUBE_ITEMS: CosmeticDef[] = [
  {
    id: 'top_hat',
    name: 'Цилиндр',
    slot: 'head',
    price: 79,
    parts: [
      {
        bone: 'head',
        color: '#1c1c21',
        cubes: [
          [-6, -9, -6, 12, 0.8, 12], // поля
          [-6, -9.8, -6, 1, 0.8, 12], // поля загнуты по бокам
          [5, -9.8, -6, 1, 0.8, 12],
          [-4, -16, -4, 8, 7, 8], // тулья
          [-0.5, -11, -4.6, 1, 1, 0.3], // прорезь пряжки
        ],
      },
      { bone: 'head', color: '#2c2c33', cubes: [[-4.3, -16.8, -4.3, 8.6, 1.2, 8.6]] }, // кант сверху
      { bone: 'head', color: '#a3221b', cubes: [[-4.25, -11.4, -4.25, 8.5, 1.8, 8.5]] }, // лента
      { bone: 'head', color: '#e9b949', cubes: [[-1.1, -11.6, -4.5, 2.2, 2.2, 0.4]] }, // пряжка
    ],
  },
  {
    id: 'crown',
    name: 'Корона',
    slot: 'head',
    price: 99,
    parts: [
      {
        bone: 'head',
        color: '#f2c12e',
        cubes: [
          ...ring(4.9, -10.4, 2.2, 1),
          ...corners([3.9, -12.2, 3.9, 1, 1.8, 1]), // зубцы по углам
          [-0.6, -13, -4.9, 1.2, 2.6, 1], // высокие зубцы посередине сторон
          [-0.6, -13, 3.9, 1.2, 2.6, 1],
          [-4.9, -13, -0.6, 1, 2.6, 1.2],
          [3.9, -13, -0.6, 1, 2.6, 1.2],
          [-0.35, -14.2, -0.35, 0.7, 2.6, 0.7], // крест на макушке
          [-1.1, -13.6, -0.35, 2.2, 0.7, 0.7],
        ],
      },
      { bone: 'head', color: '#c58f12', cubes: ring(5.1, -8.9, 0.7, 1) }, // нижний обод
      { bone: 'head', color: '#8e1538', cubes: [[-3.9, -11.3, -3.9, 7.8, 2.9, 7.8], [-2.8, -11.9, -2.8, 5.6, 0.6, 5.6]] }, // бархат
      {
        bone: 'head',
        color: '#f4efe6',
        cubes: [
          ...corners([3.95, -13, 3.95, 0.9, 0.9, 0.9]), // жемчуг на зубцах
          [-0.5, -13.9, -4.9, 1, 1, 1],
          [-0.5, -13.9, 3.9, 1, 1, 1],
          [-4.9, -13.9, -0.5, 1, 1, 1],
          [3.9, -13.9, -0.5, 1, 1, 1],
        ],
      },
      { bone: 'head', color: '#d81b45', cubes: [[-0.7, -10, -5.25, 1.4, 1.4, 0.4], [-0.7, -10, 4.85, 1.4, 1.4, 0.4]] }, // рубины
      { bone: 'head', color: '#19a35a', cubes: [[-5.25, -10, -0.7, 0.4, 1.4, 1.4], [4.85, -10, -0.7, 0.4, 1.4, 1.4]] }, // изумруды
      {
        bone: 'head',
        color: '#1e6fe5',
        cubes: both([
          [-3.3, -9.8, -5.15, 0.9, 0.9, 0.3],
          [-3.3, -9.8, 4.85, 0.9, 0.9, 0.3],
        ]), // сапфиры
      },
    ],
  },
  {
    id: 'halo',
    name: 'Нимб',
    slot: 'float',
    price: 79,
    parts: [
      { bone: 'head', color: '#ffcf40', pivot: [0, -12.5, 0], rot: [0, 0, 0.08], anim: 'spin', cubes: pixelCircle(0, 0.8) },
      { bone: 'head', color: '#fff6b0', pivot: [0, -12.5, 0], rot: [0, 0, 0.08], anim: 'spin', cubes: pixelCircle(-0.25, 0.25) }, // светлый верх
    ],
  },
  {
    id: 'cat_ears',
    name: 'Кошачьи ушки',
    slot: 'head',
    price: 59,
    parts: [
      {
        bone: 'head',
        color: '#3a2a22',
        cubes: both([
          [-4.4, -9.6, -1.2, 3.6, 1.3, 1.4],
          [-4.4, -10.7, -1.2, 2.7, 1.1, 1.4],
          [-4.4, -11.6, -1.2, 1.8, 0.9, 1.4],
        ]),
      },
      { bone: 'head', color: '#5b4337', cubes: both([[-4.4, -12.3, -1.2, 0.9, 0.7, 1.4]]) }, // кисточки
      {
        bone: 'head',
        color: '#f4a6c0',
        cubes: both([
          [-3.9, -9.6, -1.45, 2.4, 1, 0.3],
          [-3.9, -10.6, -1.45, 1.6, 1, 0.3],
          [-3.9, -11.4, -1.45, 0.8, 0.8, 0.3],
        ]),
      },
    ],
  },
  {
    id: 'horns',
    name: 'Рожки',
    slot: 'head',
    price: 79,
    // Сужаются к кончику: сначала чуть наружу, у острия — обратно внутрь; цвет темнеет к концу
    parts: [
      ...pair({ bone: 'head', color: '#7a2418', pivot: [-2.6, -8, -1.6], rot: [-0.2, 0, -0.25], cubes: [[-1.1, -1.3, -1.1, 2.2, 1.3, 2.2], [-1.15, -2.5, -0.9, 1.9, 1.3, 1.9]] }),
      ...pair({ bone: 'head', color: '#4e1610', pivot: [-2.6, -8, -1.6], rot: [-0.2, 0, -0.25], cubes: [[-1.15, -3.6, -0.65, 1.5, 1.2, 1.5], [-1, -4.6, -0.4, 1.1, 1.1, 1.1]] }),
      ...pair({ bone: 'head', color: '#1e0907', pivot: [-2.6, -8, -1.6], rot: [-0.2, 0, -0.25], cubes: [[-0.75, -5.4, -0.2, 0.75, 0.9, 0.75], [-0.45, -6, 0, 0.45, 0.7, 0.45]] }),
    ],
  },
  {
    id: 'angel_wings',
    name: 'Крылья ангела',
    slot: 'back',
    price: 149,
    parts: angelWings(),
  },
  {
    id: 'demon_wings',
    name: 'Крылья демона',
    slot: 'back',
    price: 149,
    parts: demonWings(),
  },
  {
    id: 'backpack',
    name: 'Рюкзак',
    slot: 'back',
    price: 59,
    parts: [
      { bone: 'body', color: '#8d5a3b', cubes: [[-3.5, 1, 2.05, 7, 8.5, 3.2]] }, // мешок
      { bone: 'body', color: '#6d4129', cubes: [[-3.7, 0.6, 2, 7.4, 3.2, 3.5]] }, // клапан
      {
        bone: 'body',
        color: '#7a4a30',
        cubes: [[-2.5, 4.8, 5.25, 5, 3.6, 1], ...both([[-4.4, 5, 2.6, 0.9, 3.5, 2.2]])], // карманы
      },
      {
        bone: 'body',
        color: '#4e2f1d',
        cubes: [
          [-0.6, 2.5, 5.5, 1.2, 3, 0.3], // ремешок клапана
          ...both([[-2.6, -0.8, 2.5, 0.6, 2.4, 2.2]]), // завязки скатки
          ...both([[-3, 0, -2.5, 1.3, 8, 0.3]]), // лямки на груди
        ],
      },
      { bone: 'body', color: '#e9b949', cubes: [[-0.75, 3.1, 5.5, 1.5, 1.1, 0.35]] }, // пряжка
      { bone: 'body', color: '#5c7c3a', cubes: [[-4.5, -0.6, 2.6, 9, 2, 2]] }, // скатка
    ],
  },
  {
    id: 'fox_tail',
    name: 'Лисий хвост',
    slot: 'tail',
    price: 69,
    // Хвост распушается к середине, кончик белый и чуть загнут вверх
    parts: [
      {
        bone: 'body',
        color: '#e2711d',
        pivot: [0, 10.5, 2.2],
        rot: [0.35, 0, 0],
        anim: 'sway',
        cubes: [
          [-1, -1, 0, 2, 2, 2],
          [-1.6, -1.6, 2, 3.2, 3.2, 3],
          [-1.8, -2.2, 8.5, 3.6, 3.6, 1.5],
        ],
      },
      { bone: 'body', color: '#f08a2c', pivot: [0, 10.5, 2.2], rot: [0.35, 0, 0], anim: 'sway', cubes: [[-2.1, -2.3, 5, 4.2, 4.2, 3.5]] },
      {
        bone: 'body',
        color: '#fbf6ee',
        pivot: [0, 10.5, 2.2],
        rot: [0.35, 0, 0],
        anim: 'sway',
        cubes: [[-1.6, -2.3, 10, 3.2, 3.2, 2], [-0.9, -2.1, 12, 1.8, 1.8, 1]],
      },
    ],
  },
  {
    id: 'jester_hat',
    name: 'Шапка шута',
    slot: 'head',
    price: 99,
    // Красно-чёрная: половинки шапки и рога своего цвета, ободок в шахматку, на рогах два бубенчика
    parts: [
      { bone: 'head', color: JESTER_RED, cubes: [[-4.6, -10.4, -4.6, 4.6, 1.9, 9.2], [-3.8, -11.6, -3.8, 3.8, 1.3, 7.6], ...jesterBand()[0]] },
      { bone: 'head', color: JESTER_BLACK, cubes: [[0, -10.4, -4.6, 4.6, 1.9, 9.2], [0, -11.6, -3.8, 3.8, 1.3, 7.6], ...jesterBand()[1]] },
      ...horns(),
    ],
  },
]

/** Предметы из кубов + 3D-модели: у существующего предмета появляются meshes, новые добавляются в конец */
function withMeshes(items: CosmeticDef[], meshItems: MeshItem[]): CosmeticDef[] {
  const out = items.map((c) => ({ ...c }))
  for (const m of meshItems) {
    const old = out.find((c) => c.id === m.id)
    if (old) Object.assign(old, { meshes: m.meshes, credit: m.credit }, m.name && { name: m.name }, m.slot && { slot: m.slot })
    else out.push({ id: m.id, name: m.name ?? m.id, slot: m.slot ?? 'head', price: 0, parts: [], meshes: m.meshes, credit: m.credit })
  }
  return out
}

/**
 * Что с чем не надеть: предметы, которые физически лезут друг в друга. Шляпа со шляпой — нельзя,
 * тучка с хвостом — можно. Новый предмет без записи здесь: спина, хвост и «над головой» спорят
 * со своим слотом, голова и лицо — ни с чем.
 */
const SPOTS: Record<string, string> = {
  top_hat: 'hat', crown: 'hat', jester_hat: 'hat', cowboy_hat: 'hat', beanie: 'hat', cap: 'hat',
  wizard_hat: 'hat', viking_helmet: 'hat', santa_hat: 'hat', flower_crown: 'hat',
  cat_ears: 'ears', horns: 'ears', headphones: 'ears',
  sunglasses: 'eyes', pixel_glasses: 'eyes',
  mustache: 'mouth',
  halo: 'above', rain_cloud: 'above',
  angel_wings: 'back', demon_wings: 'back', butterfly_wings: 'back', backpack: 'back',
  back_sword: 'back', quiver: 'back', guitar: 'back',
  fox_tail: 'tail', cat_tail: 'tail', dragon_tail: 'tail',
}
const SLOT_SPOT: Record<string, string> = { back: 'back', tail: 'tail', float: 'above' }

export const CATALOG: CosmeticDef[] = withMeshes([...CUBE_ITEMS, ...EXTRA_ITEMS], MESH_ITEMS).map((c) => {
  const spot = SPOTS[c.id] ?? SLOT_SPOT[c.slot]
  return spot ? { ...c, spot } : c
})
const SPOT = new Map(CATALOG.map((c) => [c.id, c.spot]))

const IDS = new Set(CATALOG.map((c) => c.id))
const PRICE = new Map(CATALOG.map((c) => [c.id, c.price]))
const MAX_ITEMS = 10

/**
 * Оставить только существующие предметы, без повторов и без двух предметов на одном месте
 * (из спорящих побеждает последний в списке — его надели позже)
 */
export function cleanSelection(raw: unknown, owned: string[] = []): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const spots = new Set<string>()
  for (const id of [...raw].reverse()) {
    // Надеть можно бесплатное или купленное
    const mine = typeof id === 'string' && IDS.has(id) && (PRICE.get(id) === 0 || owned.includes(id))
    if (!mine || out.includes(id)) continue
    const spot = SPOT.get(id)
    if (spot && spots.has(spot)) continue
    if (spot) spots.add(spot)
    out.push(id)
  }
  return out.reverse().slice(-MAX_ITEMS)
}
