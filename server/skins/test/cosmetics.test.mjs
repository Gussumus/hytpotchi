// Тест каталога косметики: корректные данные (мод и лаунчер строят по ним модели) и выбор игрока
import assert from 'node:assert/strict'

const { CATALOG, cleanSelection } = await import(new URL('../src/cosmetics.ts', import.meta.url).href)

assert.equal(CATALOG.length, 10)
const ids = new Set()
for (const c of CATALOG) {
  assert.match(c.id, /^[a-z_]{2,32}$/, c.id)
  assert.ok(!ids.has(c.id), `повтор ${c.id}`)
  ids.add(c.id)
  assert.ok(c.name.length > 0 && c.name.length <= 40)
  assert.equal(c.price, 0, 'пока все бесплатные')
  assert.ok(c.parts.length > 0)
  for (const p of c.parts) {
    assert.ok(['head', 'body', 'left_arm', 'right_arm'].includes(p.bone), `${c.id}: кость ${p.bone}`)
    assert.match(p.color, /^#[0-9a-f]{6}$/i, `${c.id}: цвет`)
    assert.ok(!p.anim || ['flap_left', 'flap_right', 'sway', 'spin'].includes(p.anim))
    for (const v of [p.pivot, p.rot].filter(Boolean)) assert.equal(v.length, 3)
    assert.ok(p.cubes.length > 0)
    for (const cube of p.cubes) {
      assert.equal(cube.length, 6, `${c.id}: куб`)
      assert.ok(cube.every(Number.isFinite))
      assert.ok(cube[3] > 0 && cube[4] > 0 && cube[5] > 0, `${c.id}: размер куба`)
      assert.ok(cube.slice(3).every((x) => x <= 16), `${c.id}: слишком большой куб`)
    }
  }
}

assert.deepEqual(cleanSelection(['crown', 'halo', 'crown', 'nope', 5, null]), ['crown', 'halo'])
assert.deepEqual(cleanSelection('crown'), [])
assert.equal(cleanSelection([...ids, ...ids]).length, 10)

console.log('cosmetics: все проверки пройдены')
