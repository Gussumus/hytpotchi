// Тест каталога косметики: корректные данные (мод и лаунчер строят по ним модели) и выбор игрока
import assert from 'node:assert/strict'

const { CATALOG, cleanSelection } = await import(new URL('../src/cosmetics.ts', import.meta.url).href)

assert.ok(CATALOG.length >= 20, 'косметики должно быть много')
const ids = new Set()
for (const c of CATALOG) {
  assert.match(c.id, /^[a-z_]{2,32}$/, c.id)
  assert.ok(!ids.has(c.id), `повтор ${c.id}`)
  ids.add(c.id)
  assert.ok(c.name.length > 0 && c.name.length <= 40)
  assert.ok(Number.isInteger(c.price) && c.price >= 0 && c.price <= 10000, `${c.id}: цена`)
  assert.ok(c.parts.length > 0 || c.meshes?.length > 0, `${c.id}: нет модели`)
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

// 3D-модели: файлы на месте и целые — мод и лаунчер отказываются от битых и рисуют кубы
const { readFileSync, existsSync } = await import('node:fs')
const assets = new URL('../assets/', import.meta.url)
for (const c of CATALOG.filter((c) => c.meshes)) {
  assert.ok(c.credit?.author && c.credit.url.startsWith('https://') && c.credit.license, `${c.id}: автор модели`)
  assert.ok(c.meshes.length > 0)
  for (const m of c.meshes) {
    assert.ok(['head', 'body', 'left_arm', 'right_arm'].includes(m.bone), `${c.id}: кость`)
    assert.match(m.mesh, /^cosmetics\/[a-z_]{1,32}\/[a-z0-9_-]{1,32}\.json$/, `${c.id}: путь`)
    const mesh = JSON.parse(readFileSync(new URL(m.mesh, assets), 'utf8'))
    assert.equal(mesh.format, 1)
    const dir = m.mesh.slice(0, m.mesh.lastIndexOf('/') + 1)
    for (const t of mesh.textures) {
      assert.match(t, /^tex\d{1,3}\.png$/)
      const png = readFileSync(new URL(dir + t, assets))
      assert.ok(png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), `${c.id}: ${t} — не PNG`)
    }
    let tris = 0
    for (const g of mesh.groups) {
      assert.ok(g.texture >= -1 && g.texture < mesh.textures.length, `${c.id}: номер текстуры`)
      assert.equal(g.v.length % 11, 0)
      assert.equal(g.i.length % 3, 0)
      const n = g.v.length / 11
      assert.ok(g.i.every((k) => Number.isInteger(k) && k >= 0 && k < n), `${c.id}: индексы`)
      assert.ok(g.v.every(Number.isFinite))
      tris += g.i.length / 3
    }
    assert.ok(tris > 0 && tris <= 20000, `${c.id}: треугольников ${tris}`)
  }
}
assert.ok(existsSync(new URL('_headers', assets)), 'заголовки для файлов косметики')

// Надеть можно бесплатное или купленное
const free = CATALOG.filter((c) => c.price === 0).map((c) => c.id)
const paid = CATALOG.filter((c) => c.price > 0).map((c) => c.id)
assert.ok(free.length >= 2 && paid.length >= 2, 'нужны и бесплатные, и платные предметы')
assert.deepEqual(cleanSelection([free[0], paid[0], free[0], 'nope', 5, null]), [free[0]], 'платное без покупки снимается')
assert.deepEqual(cleanSelection(['cap', 'crown'], ['crown']), ['cap', 'crown'].filter((x) => x === 'crown'), 'шляпа заменяет шляпу')
assert.deepEqual(cleanSelection(['sunglasses', 'mustache'], ['mustache']), ['sunglasses', 'mustache'], 'очки и усы — вместе')
assert.deepEqual(cleanSelection(['cat_tail', 'rain_cloud'], ['cat_tail', 'rain_cloud']), ['cat_tail', 'rain_cloud'], 'тучка и хвост — вместе')
assert.deepEqual(cleanSelection(['rain_cloud', 'cat_tail', 'halo'], ['cat_tail', 'rain_cloud', 'halo']), ['cat_tail', 'halo'], 'нимб заменяет тучку')
assert.deepEqual(cleanSelection(['angel_wings', 'backpack'], ['angel_wings', 'backpack']), ['backpack'], 'на спине — одно')
assert.deepEqual(cleanSelection(free[0]), [])
// Один предмет на каждое место — сколько мест, столько максимум (и не больше 10)
const spots = new Set(CATALOG.map((c) => c.spot ?? c.id))
assert.equal(cleanSelection([...ids, ...ids], [...ids]).length, Math.min(10, spots.size))
for (const c of CATALOG) if (['back', 'tail', 'float'].includes(c.slot)) assert.ok(c.spot, `${c.id}: у слота ${c.slot} должно быть место`)

console.log('cosmetics: все проверки пройдены')
