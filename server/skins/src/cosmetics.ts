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
 */

export interface CosmeticPart {
  bone: 'head' | 'body' | 'left_arm' | 'right_arm'
  color: string
  pivot?: [number, number, number]
  rot?: [number, number, number]
  anim?: 'flap_left' | 'flap_right' | 'sway' | 'spin'
  cubes: [number, number, number, number, number, number][]
}

export interface CosmeticDef {
  id: string
  name: string
  /** head | face | back | tail | float — подсказка для интерфейса */
  slot: string
  /** Цена в рублях; 0 — бесплатно (сейчас все бесплатные — тестовые) */
  price: number
  parts: CosmeticPart[]
}

export const CATALOG_VERSION = 1

export const CATALOG: CosmeticDef[] = [
  {
    id: 'top_hat',
    name: 'Цилиндр',
    slot: 'head',
    price: 0,
    parts: [
      { bone: 'head', color: '#1b1b1f', cubes: [[-5.5, -9, -5.5, 11, 1, 11], [-3.5, -16, -3.5, 7, 7, 7]] },
      { bone: 'head', color: '#b3261e', cubes: [[-3.6, -10.5, -3.6, 7.2, 1.5, 7.2]] },
    ],
  },
  {
    id: 'crown',
    name: 'Корона',
    slot: 'head',
    price: 0,
    parts: [
      {
        bone: 'head',
        color: '#f2c12e',
        cubes: [
          [-4.5, -10, -4.5, 9, 2, 1],
          [-4.5, -10, 3.5, 9, 2, 1],
          [-4.5, -10, -3.5, 1, 2, 7],
          [3.5, -10, -3.5, 1, 2, 7],
          [-4.5, -12, -4.5, 1, 2, 1],
          [-0.5, -12, -4.5, 1, 2, 1],
          [3.5, -12, -4.5, 1, 2, 1],
          [-4.5, -12, 3.5, 1, 2, 1],
          [3.5, -12, 3.5, 1, 2, 1],
          [-0.5, -12, 3.5, 1, 2, 1],
        ],
      },
      { bone: 'head', color: '#d81b60', cubes: [[-0.5, -9.5, -5, 1, 1, 0.5]] },
    ],
  },
  {
    id: 'halo',
    name: 'Нимб',
    slot: 'float',
    price: 0,
    parts: [
      {
        bone: 'head',
        color: '#fff59d',
        pivot: [0, -12, 0],
        anim: 'spin',
        cubes: [
          [-4, 0, -4, 8, 1, 1],
          [-4, 0, 3, 8, 1, 1],
          [-4, 0, -3, 1, 1, 6],
          [3, 0, -3, 1, 1, 6],
        ],
      },
    ],
  },
  {
    id: 'cat_ears',
    name: 'Кошачьи ушки',
    slot: 'head',
    price: 0,
    parts: [
      { bone: 'head', color: '#3e2c23', cubes: [[-4, -10, -1, 3, 2, 1], [1, -10, -1, 3, 2, 1], [-4, -11, -1, 2, 1, 1], [2, -11, -1, 2, 1, 1]] },
      { bone: 'head', color: '#f48fb1', cubes: [[-3.5, -9.5, -1.3, 1.5, 1.5, 0.4], [2, -9.5, -1.3, 1.5, 1.5, 0.4]] },
    ],
  },
  {
    id: 'horns',
    name: 'Рожки',
    slot: 'head',
    price: 0,
    parts: [
      { bone: 'head', color: '#5d1f1a', pivot: [-3, -8, -1], rot: [0, 0, -0.35], cubes: [[-1, -3, -1, 2, 3, 2]] },
      { bone: 'head', color: '#5d1f1a', pivot: [3, -8, -1], rot: [0, 0, 0.35], cubes: [[-1, -3, -1, 2, 3, 2]] },
      { bone: 'head', color: '#2a0f0c', pivot: [-3, -8, -1], rot: [0, 0, -0.35], cubes: [[-2, -5, -0.5, 1.5, 2, 1]] },
      { bone: 'head', color: '#2a0f0c', pivot: [3, -8, -1], rot: [0, 0, 0.35], cubes: [[0.5, -5, -0.5, 1.5, 2, 1]] },
    ],
  },
  {
    id: 'angel_wings',
    name: 'Крылья ангела',
    slot: 'back',
    price: 0,
    parts: [
      { bone: 'body', color: '#f5f5f5', pivot: [1, 2, 2], rot: [0.15, -0.95, 0], anim: 'flap_left', cubes: [[0, -2, 0, 1, 12, 10], [0, -4, 4, 1, 2, 6]] },
      { bone: 'body', color: '#f5f5f5', pivot: [-1, 2, 2], rot: [0.15, 0.95, 0], anim: 'flap_right', cubes: [[-1, -2, 0, 1, 12, 10], [-1, -4, 4, 1, 2, 6]] },
    ],
  },
  {
    id: 'demon_wings',
    name: 'Крылья демона',
    slot: 'back',
    price: 0,
    parts: [
      { bone: 'body', color: '#4a148c', pivot: [1, 2, 2], rot: [0.15, -1.0, 0], anim: 'flap_left', cubes: [[0, -3, 0, 1, 10, 9], [0, 7, 3, 1, 3, 6], [0, -5, 7, 1, 2, 3]] },
      { bone: 'body', color: '#4a148c', pivot: [-1, 2, 2], rot: [0.15, 1.0, 0], anim: 'flap_right', cubes: [[-1, -3, 0, 1, 10, 9], [-1, 7, 3, 1, 3, 6], [-1, -5, 7, 1, 2, 3]] },
      { bone: 'body', color: '#1a1a1a', pivot: [1, 2, 2], rot: [0.15, -1.0, 0], anim: 'flap_left', cubes: [[-0.2, -4, -0.5, 1.4, 1, 10]] },
      { bone: 'body', color: '#1a1a1a', pivot: [-1, 2, 2], rot: [0.15, 1.0, 0], anim: 'flap_right', cubes: [[-1.2, -4, -0.5, 1.4, 1, 10]] },
    ],
  },
  {
    id: 'backpack',
    name: 'Рюкзак',
    slot: 'back',
    price: 0,
    parts: [
      { bone: 'body', color: '#795548', cubes: [[-3.5, 1, 2, 7, 8, 3]] },
      { bone: 'body', color: '#4e342e', cubes: [[-3, 5, 5, 6, 3, 1], [-3, 0.5, 2.2, 1, 9, 0.6], [2, 0.5, 2.2, 1, 9, 0.6]] },
      { bone: 'body', color: '#ffb300', cubes: [[-0.5, 2, 5, 1, 1, 0.5]] },
    ],
  },
  {
    id: 'fox_tail',
    name: 'Лисий хвост',
    slot: 'tail',
    price: 0,
    parts: [
      { bone: 'body', color: '#ef6c00', pivot: [0, 10, 2], rot: [0.45, 0, 0], anim: 'sway', cubes: [[-1.5, 0, 0, 3, 3, 7]] },
      { bone: 'body', color: '#fafafa', pivot: [0, 10, 2], rot: [0.45, 0, 0], anim: 'sway', cubes: [[-1.5, 0, 7, 3, 3, 3]] },
    ],
  },
  {
    id: 'party_hat',
    name: 'Праздничный колпак',
    slot: 'head',
    price: 0,
    parts: [
      { bone: 'head', color: '#1e88e5', cubes: [[-3, -10, -3, 6, 2, 6]] },
      { bone: 'head', color: '#fdd835', cubes: [[-2, -12, -2, 4, 2, 4]] },
      { bone: 'head', color: '#e53935', cubes: [[-1, -14, -1, 2, 2, 2]] },
      { bone: 'head', color: '#ffffff', cubes: [[-0.75, -15.5, -0.75, 1.5, 1.5, 1.5]] },
    ],
  },
]

const IDS = new Set(CATALOG.map((c) => c.id))
const MAX_ITEMS = 10

/** Оставить только существующие предметы, без повторов */
export function cleanSelection(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const id of raw) {
    if (typeof id === 'string' && IDS.has(id) && !out.includes(id)) out.push(id)
    if (out.length >= MAX_ITEMS) break
  }
  return out
}
