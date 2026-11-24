package ru.hytpotchi.cosmetics.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Каталог косметики и что надето у каждого игрока — с сервера Hytpotchi. Общий для всех версий игры:
 * от версии нужна только {@link Platform} (текстуры и главный поток), а отрисовку делает её слой рендера.
 *
 * @param <T> идентификатор текстуры в этой версии игры (ResourceLocation / Identifier)
 */
public final class Cosmetics<T> {
	/** Что нужно от версии игры */
	public interface Platform<T> {
		/** Белая текстура мода (для кубов) */
		T white();

		/** Зарегистрировать PNG как текстуру. Зовётся в главном потоке игры */
		T registerTexture(String path, byte[] png) throws Exception;

		/** Выполнить в главном потоке игры */
		void onMain(Runnable task);
	}

	/** Деталь, готовая к рисованию: на кости игрока, с точкой опоры, поворотом и анимацией */
	public static final class Part<T> {
		/** head | body | left_arm | right_arm */
		public final String bone;
		/** Точка опоры в пикселях модели от кости */
		public final float[] pivot;
		private final float[] rot;
		private final String anim;
		public final List<Geometry.Group> groups;
		private final List<T> textures;
		private final T white;

		Part(String bone, float[] pivot, float[] rot, String anim, List<Geometry.Group> groups, List<T> textures, T white) {
			this.bone = bone;
			this.pivot = pivot;
			this.rot = rot;
			this.anim = anim;
			this.groups = groups;
			this.textures = textures;
			this.white = white;
		}

		public T texture(Geometry.Group group) {
			return group.texture >= 0 && group.texture < this.textures.size() ? this.textures.get(group.texture) : this.white;
		}

		/** Поворот детали (x, y, z в радианах, порядок ZYX — как у частей модели игрока) с анимацией */
		public float[] angles(float ageInTicks) {
			float t = ageInTicks;
			float x = this.rot[0];
			float y = this.rot[1];
			switch (this.anim) {
				case "flap_left":
					y = this.rot[1] - 0.35F * (1 + (float) Math.sin(t * 0.18F)) / 2;
					break;
				case "flap_right":
					y = this.rot[1] + 0.35F * (1 + (float) Math.sin(t * 0.18F)) / 2;
					break;
				case "sway":
					y = this.rot[1] + 0.25F * (float) Math.sin(t * 0.1F);
					x = this.rot[0] + 0.05F * (float) Math.sin(t * 0.07F);
					break;
				case "spin":
					y = t * 0.05F;
					break;
				default:
					break;
			}
			return new float[] {x, y, this.rot[2]};
		}
	}

	/** Предмет: детали из кубов, а когда скачается 3D-модель — она */
	private static final class Item<T> {
		final List<Part<T>> cubes;
		volatile List<Part<T>> meshes;

		Item(List<Part<T>> cubes) {
			this.cubes = cubes;
		}

		List<Part<T>> parts() {
			List<Part<T>> m = this.meshes;
			return m != null ? m : this.cubes;
		}
	}

	private static final class Selection {
		final List<String> items;
		final long at;
		final boolean loading;
		/** Сколько запросов подряд не удалось (0 — последний удался) */
		final int failures;

		Selection(List<String> items, long at, boolean loading, int failures) {
			this.items = items;
			this.at = at;
			this.loading = loading;
			this.failures = failures;
		}

		/** Когда спрашивать снова */
		long refreshAfter() {
			if (this.failures > 0) {
				return Math.min(RETRY_MAX_MS, RETRY_FAILED_MS << Math.min(this.failures - 1, 5));
			}
			return this.items.isEmpty() ? REFRESH_EMPTY_MS : REFRESH_MS;
		}
	}

	private static final Set<String> BONES = new HashSet<>(Arrays.asList("head", "body", "left_arm", "right_arm"));
	/** Как часто перепроверять, что надето у игрока в косметике: смену другие увидят за минуту */
	private static final long REFRESH_MS = 60_000L;
	/**
	 * У кого ничего не надето (на чужих серверах — почти все), перепроверяем реже: иначе мод на
	 * сервере с толпой игроков слал бы сотни запросов в минуту и съедал лимит сервера Hytpotchi
	 */
	private static final long REFRESH_EMPTY_MS = 3 * 60_000L;
	/** Не удалось узнать, что надето: повтор через 15 с, дальше пауза растёт вдвое — до 5 минут */
	private static final long RETRY_FAILED_MS = 15_000L;
	private static final long RETRY_MAX_MS = 5 * 60_000L;
	/** Каталог: повтор после ошибки и перечитывание, если встретился незнакомый предмет */
	private static final long CATALOG_RETRY_MS = 30_000L;
	/** Самая большая текстура 3D-модели, которую примем */
	private static final int MAX_TEXTURE = 4 * 1024 * 1024;

	private final Platform<T> platform;
	private final String server;
	/** Каталог и 3D-модели (запросы покрупнее) */
	private final ExecutorService pool = daemonPool("Hytpotchi Cosmetics");
	/**
	 * Что надето у игроков — отдельно: иначе при медленной сети эти короткие запросы ждали бы в
	 * очереди за скачиванием 3D-моделей, и косметики других игроков не было бы видно минутами.
	 */
	private final ExecutorService lookups = daemonPool("Hytpotchi Cosmetics lookup");
	private volatile Map<String, Item<T>> catalog = Collections.emptyMap();
	private volatile long catalogAt = 0;
	private volatile boolean catalogLoading = false;
	private final Map<String, Selection> selections = new ConcurrentHashMap<>();

	private Cosmetics(Platform<T> platform, String server) {
		this.platform = platform;
		this.server = server;
	}

	/** Косметика с сервера из -Dhytpotchi.server, или null, если сервер не задан */
	public static <T> Cosmetics<T> start(Platform<T> platform) {
		String raw = System.getProperty("hytpotchi.server");
		if (raw == null || raw.trim().isEmpty()) {
			log("Сервер Hytpotchi не задан (-Dhytpotchi.server) — косметика выключена");
			return null;
		}
		Cosmetics<T> c = new Cosmetics<>(platform, raw.trim().replaceAll("/+$", ""));
		c.loadCatalog();
		return c;
	}

	private static ExecutorService daemonPool(String name) {
		return Executors.newFixedThreadPool(2, r -> {
			Thread t = new Thread(r, name);
			t.setDaemon(true);
			return t;
		});
	}

	public static void log(String message) {
		// Игра перенаправляет System.out в свой лог во всех версиях
		System.out.println("[Hytpotchi Cosmetics] " + message);
	}

	private void loadCatalog() {
		if (this.catalogLoading) {
			return;
		}
		this.catalogLoading = true;
		this.catalogAt = System.currentTimeMillis();
		this.pool.execute(() -> {
			try {
				JsonObject root = parse(Net.text(this.server + "/api/cosmetics/catalog")).getAsJsonObject();
				Map<String, Item<T>> old = this.catalog;
				Map<String, Item<T>> built = new ConcurrentHashMap<>();
				for (JsonElement el : root.getAsJsonArray("items")) {
					JsonObject json = el.getAsJsonObject();
					String id = json.get("id").getAsString();
					// Перечитали каталог из-за нового предмета — уже скачанные модели не трогаем
					Item<T> known = old.get(id);
					if (known != null) {
						built.put(id, known);
						continue;
					}
					try {
						Item<T> item = new Item<>(cubeParts(json.getAsJsonArray("parts")));
						built.put(id, item);
						if (json.has("meshes") && json.getAsJsonArray("meshes").size() > 0) {
							JsonArray meshes = json.getAsJsonArray("meshes");
							this.pool.execute(() -> this.loadMeshes(id, item, meshes));
						}
					} catch (RuntimeException e) {
						log("Предмет " + id + " пропущен: " + e);
					}
				}
				this.catalog = built;
				log("Каталог косметики загружен: " + built.size() + " предметов");
			} catch (Exception e) {
				log("Каталог косметики не загружен: " + e + " — повторю через " + CATALOG_RETRY_MS / 1000 + " с");
			} finally {
				this.catalogLoading = false;
			}
		});
	}

	@SuppressWarnings("deprecation") // new JsonParser().parse — единственный способ, что есть и в старом Gson (1.16.5)
	private static JsonElement parse(String text) {
		return new JsonParser().parse(text);
	}

	private List<Part<T>> cubeParts(JsonArray parts) {
		List<Part<T>> out = new ArrayList<>();
		for (JsonElement el : parts) {
			JsonObject p = el.getAsJsonObject();
			String bone = p.get("bone").getAsString();
			if (!BONES.contains(bone)) {
				throw new IllegalArgumentException("кость " + bone);
			}
			int color = Integer.parseInt(p.get("color").getAsString().substring(1), 16) & 0xFFFFFF;
			String anim = p.has("anim") ? p.get("anim").getAsString() : "";
			Geometry.Group group = Geometry.cubes(p.getAsJsonArray("cubes"), color);
			out.add(new Part<>(bone, Geometry.vec(p, "pivot"), Geometry.vec(p, "rot"), anim,
				Collections.singletonList(group), Collections.<T>emptyList(), this.platform.white()));
		}
		return out;
	}

	/**
	 * Скачать 3D-модель предмета и её текстуры. Текстуры регистрируются в главном потоке игры,
	 * после этого предмет рисуется моделью вместо кубов. Не вышло — так и остаются кубы.
	 */
	private void loadMeshes(String id, Item<T> item, JsonArray meshes) {
		try {
			List<JsonObject> jsons = new ArrayList<>();
			List<Geometry.Mesh> datas = new ArrayList<>();
			List<String> dirs = new ArrayList<>();
			Map<String, byte[]> pngs = new HashMap<>();
			for (JsonElement el : meshes) {
				JsonObject json = el.getAsJsonObject();
				String path = json.get("mesh").getAsString();
				if (!Geometry.PATH.matcher(path).matches()) {
					throw new IllegalArgumentException("путь к модели " + path);
				}
				String bone = json.get("bone").getAsString();
				if (!BONES.contains(bone)) {
					throw new IllegalArgumentException("кость " + bone);
				}
				String dir = path.substring(0, path.lastIndexOf('/'));
				Geometry.Mesh data = Geometry.parseMesh(parse(Net.text(this.server + "/" + path)).getAsJsonObject());
				for (String name : data.textures) {
					String key = dir + "/" + name;
					if (!pngs.containsKey(key)) {
						pngs.put(key, Net.get(this.server + "/" + key, MAX_TEXTURE));
					}
				}
				jsons.add(json);
				datas.add(data);
				dirs.add(dir);
			}
			this.platform.onMain(() -> {
				try {
					Map<String, T> ids = new HashMap<>();
					for (Map.Entry<String, byte[]> e : pngs.entrySet()) {
						// cosmetics/<id>/tex0.png → hytpotchi_cosmetics:mesh/<id>/tex0
						String key = e.getKey();
						String texPath = "mesh/" + key.substring("cosmetics/".length(), key.length() - ".png".length());
						ids.put(key, this.platform.registerTexture(texPath, e.getValue()));
					}
					List<Part<T>> parts = new ArrayList<>();
					for (int k = 0; k < jsons.size(); k++) {
						JsonObject j = jsons.get(k);
						List<T> textures = new ArrayList<>();
						for (String name : datas.get(k).textures) {
							textures.add(ids.get(dirs.get(k) + "/" + name));
						}
						parts.add(new Part<>(j.get("bone").getAsString(), Geometry.vec(j, "pivot"), Geometry.vec(j, "rot"),
							j.has("anim") ? j.get("anim").getAsString() : "", datas.get(k).groups, textures, this.platform.white()));
					}
					item.meshes = parts;
					log("3D-модель " + id + " загружена");
				} catch (Exception e) {
					log("3D-модель " + id + " не загружена, рисую кубами: " + e);
				}
			});
		} catch (Exception e) {
			log("3D-модель " + id + " не загружена, рисую кубами: " + e);
		}
	}

	/** Детали всего, что надето у игрока (пусто, пока не загрузилось). Зовётся из рендера */
	public List<Part<T>> forPlayer(String name) {
		long now = System.currentTimeMillis();
		Map<String, Item<T>> catalog = this.catalog;
		if (catalog.isEmpty() && now - this.catalogAt > CATALOG_RETRY_MS) {
			this.loadCatalog();
		}
		String key = name.toLowerCase(java.util.Locale.ROOT);
		Selection sel = this.selections.get(key);
		if (sel == null || (!sel.loading && now - sel.at > sel.refreshAfter())) {
			Selection old = sel;
			List<String> items = old == null ? Collections.<String>emptyList() : old.items;
			this.selections.put(key, new Selection(items, now, true, old == null ? 0 : old.failures));
			this.lookups.execute(() -> this.fetch(key, name, old));
		}
		if (sel == null || sel.items.isEmpty()) {
			return Collections.emptyList();
		}
		List<Part<T>> out = new ArrayList<>();
		boolean unknown = false;
		for (String id : sel.items) {
			Item<T> item = catalog.get(id);
			if (item != null) {
				out.addAll(item.parts());
			} else {
				unknown = true;
			}
		}
		// Игрок надел предмет, который появился в магазине уже после нашего входа в игру
		if (unknown && !catalog.isEmpty() && now - this.catalogAt > CATALOG_RETRY_MS) {
			this.loadCatalog();
		}
		return out;
	}

	private void fetch(String key, String name, Selection old) {
		int failures = old == null ? 0 : old.failures;
		try {
			JsonArray arr = parse(Net.quickText(this.server + "/api/cosmetics/" + URLEncoder.encode(name, "UTF-8")))
				.getAsJsonObject()
				.getAsJsonArray("items");
			List<String> items = new ArrayList<>();
			for (JsonElement e : arr) {
				items.add(e.getAsString());
			}
			this.selections.put(key, new Selection(Collections.unmodifiableList(items), System.currentTimeMillis(), false, 0));
			if (failures > 0) {
				log("Косметика " + name + " снова доступна");
			}
		} catch (Exception e) {
			// Сервер недоступен — оставляем, что было, и скоро пробуем снова. В лог — один раз за серию ошибок
			if (failures == 0) {
				log("Не удалось узнать, что надето у " + name + ": " + e + " — попробую снова");
			}
			this.selections.put(key, new Selection(old == null ? Collections.<String>emptyList() : old.items,
				System.currentTimeMillis(), false, failures + 1));
		}
	}
}
