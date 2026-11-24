package ru.hytpotchi.cosmetics;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.platform.NativeImage;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.resources.Identifier;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Каталог косметики и что надето у каждого игрока — с сервера Hytpotchi.
 * Каждый запрос — новое соединение: у части провайдеров долгие соединения к Cloudflare «замерзают».
 * Прокси: Java не видит системный прокси Windows (его ставят VPN-программы), поэтому лаунчер
 * передаёт его сам (-Dhytpotchi.proxy=http://host:port | socks5://host:port): сначала через него,
 * не вышло — напрямую.
 */
public final class Cosmetics {
	static final Logger LOG = LoggerFactory.getLogger("Hytpotchi Cosmetics");
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

	/** Каталог и 3D-модели (запросы покрупнее) */
	private static final ExecutorService POOL = daemonPool("Hytpotchi Cosmetics");
	/**
	 * Что надето у игроков — отдельно: иначе при медленной сети эти короткие запросы ждали бы в
	 * очереди за скачиванием 3D-моделей, и косметики других игроков не было бы видно минутами.
	 */
	private static final ExecutorService LOOKUPS = daemonPool("Hytpotchi Cosmetics lookup");
	private static final @Nullable Proxy PROXY = parseProxy(System.getProperty("hytpotchi.proxy"));

	/**
	 * Предмет: модель из кубов, а если в каталоге есть 3D-модель — она, когда скачается.
	 * meshes пишет главный поток игры (после регистрации текстур), читает рендер.
	 */
	static final class Item {
		final List<CosmeticModel.Part> cubes;
		volatile @Nullable List<MeshModel.Part> meshes;

		Item(List<CosmeticModel.Part> cubes) {
			this.cubes = cubes;
		}
	}

	private static @Nullable String server;
	private static volatile Map<String, Item> catalog = Map.of();
	private static volatile long catalogAt = 0;
	private static volatile boolean catalogLoading = false;
	private static final Map<String, Selection> SELECTIONS = new ConcurrentHashMap<>();

	/** failures — сколько запросов подряд не удалось (0 — последний удался) */
	private record Selection(List<String> items, long at, boolean loading, int failures) {
		/** Когда спрашивать снова */
		long refreshAfter() {
			if (this.failures > 0) {
				return Math.min(RETRY_MAX_MS, RETRY_FAILED_MS << Math.min(this.failures - 1, 5));
			}
			return this.items.isEmpty() ? REFRESH_EMPTY_MS : REFRESH_MS;
		}
	}

	private static ExecutorService daemonPool(String name) {
		return Executors.newFixedThreadPool(2, r -> {
			Thread t = new Thread(r, name);
			t.setDaemon(true);
			return t;
		});
	}

	/** "http://127.0.0.1:10809" / "socks5://127.0.0.1:10808" → прокси Java, иначе null */
	static @Nullable Proxy parseProxy(@Nullable String raw) {
		if (raw == null || raw.isBlank()) {
			return null;
		}
		String s = raw.trim();
		Proxy.Type type = s.startsWith("socks") ? Proxy.Type.SOCKS : Proxy.Type.HTTP;
		int scheme = s.indexOf("://");
		String hostPort = scheme >= 0 ? s.substring(scheme + 3) : s;
		int colon = hostPort.lastIndexOf(':');
		if (colon <= 0) {
			return null;
		}
		try {
			int port = Integer.parseInt(hostPort.substring(colon + 1).replace("/", ""));
			return new Proxy(type, new InetSocketAddress(hostPort.substring(0, colon), port));
		} catch (NumberFormatException e) {
			return null;
		}
	}

	private Cosmetics() {}

	static void init(@Nullable String serverUrl) {
		server = serverUrl == null || serverUrl.isBlank() ? null : serverUrl.replaceAll("/+$", "");
		if (server == null) {
			LOG.info("Сервер Hytpotchi не задан (-Dhytpotchi.server) — косметика выключена");
			return;
		}
		loadCatalog();
	}

	/**
	 * GET к серверу Hytpotchi. Ответ — обязательно сжатый: у части российских провайдеров без VPN
	 * соединение с Cloudflare обрывается после ~16 КБ, а каталог и 3D-модели без сжатия больше
	 * (каталог 31 КБ, со сжатием 7 КБ). Без этого у таких игроков косметика не видна совсем.
	 */
	private static byte[] get(String path, int maxBytes, int readTimeoutMs) throws Exception {
		if (PROXY != null) {
			try {
				return fetch(path, maxBytes, readTimeoutMs, PROXY);
			} catch (IOException e) {
				// Прокси выключен или не отвечает — пробуем напрямую
			}
		}
		return fetch(path, maxBytes, readTimeoutMs, Proxy.NO_PROXY);
	}

	private static byte[] get(String path, int maxBytes) throws Exception {
		return get(path, maxBytes, 30_000);
	}

	private static byte[] fetch(String path, int maxBytes, int readTimeoutMs, Proxy proxy) throws IOException {
		HttpURLConnection c = (HttpURLConnection) URI.create(server + path).toURL().openConnection(proxy);
		try {
			c.setConnectTimeout(10_000);
			c.setReadTimeout(readTimeoutMs);
			c.setUseCaches(false);
			c.setRequestProperty("User-Agent", "HytpotchiCosmetics/4");
			c.setRequestProperty("Accept-Encoding", "gzip");
			c.setRequestProperty("Connection", "close");
			int code = c.getResponseCode();
			if (code != 200) {
				throw new IOException("HTTP " + code);
			}
			try (InputStream raw = c.getInputStream();
				InputStream in = "gzip".equalsIgnoreCase(c.getContentEncoding()) ? new GZIPInputStream(raw) : raw) {
				byte[] data = in.readNBytes(maxBytes + 1);
				if (data.length > maxBytes) {
					throw new IOException("ответ больше " + maxBytes + " байт");
				}
				return data;
			}
		} finally {
			c.disconnect();
		}
	}

	private static String getText(String path) throws Exception {
		return new String(get(path, 8 * 1024 * 1024), StandardCharsets.UTF_8);
	}

	private static void loadCatalog() {
		if (catalogLoading) {
			return;
		}
		catalogLoading = true;
		catalogAt = System.currentTimeMillis();
		POOL.execute(() -> {
			try {
				JsonObject root = JsonParser.parseString(getText("/api/cosmetics/catalog")).getAsJsonObject();
				Map<String, Item> old = catalog;
				Map<String, Item> built = new ConcurrentHashMap<>();
				for (JsonElement el : root.getAsJsonArray("items")) {
					JsonObject json = el.getAsJsonObject();
					String id = json.get("id").getAsString();
					// Перечитали каталог из-за нового предмета — уже скачанные модели не трогаем
					Item known = old.get(id);
					if (known != null) {
						built.put(id, known);
						continue;
					}
					try {
						Item item = new Item(CosmeticModel.build(json.getAsJsonArray("parts")));
						built.put(id, item);
						if (json.has("meshes") && !json.getAsJsonArray("meshes").isEmpty()) {
							JsonArray meshes = json.getAsJsonArray("meshes");
							POOL.execute(() -> loadMeshes(id, item, meshes));
						}
					} catch (RuntimeException e) {
						LOG.warn("Предмет {} пропущен: {}", id, e.toString());
					}
				}
				catalog = built;
				LOG.info("Каталог косметики загружен: {} предметов", built.size());
			} catch (Exception e) {
				LOG.warn("Каталог косметики не загружен: {} — повторю через {} с", e.toString(), CATALOG_RETRY_MS / 1000);
			} finally {
				catalogLoading = false;
			}
		});
	}

	/**
	 * Скачать 3D-модель предмета и её текстуры. Текстуры регистрируются в главном потоке игры,
	 * после этого предмет рисуется моделью вместо кубов. Не вышло — так и остаются кубы.
	 */
	private static void loadMeshes(String id, Item item, JsonArray meshes) {
		try {
			record Loaded(JsonObject json, MeshModel.Data data, String dir) {}
			List<Loaded> loaded = new ArrayList<>();
			Map<String, NativeImage> images = new HashMap<>();
			for (JsonElement el : meshes) {
				JsonObject json = el.getAsJsonObject();
				String path = json.get("mesh").getAsString();
				if (!MeshModel.PATH.matcher(path).matches()) {
					throw new IllegalArgumentException("путь к модели " + path);
				}
				String dir = path.substring(0, path.lastIndexOf('/'));
				MeshModel.Data data = MeshModel.parse(JsonParser.parseString(getText("/" + path)).getAsJsonObject());
				for (String name : data.textures()) {
					String key = dir + "/" + name;
					if (!images.containsKey(key)) {
						images.put(key, NativeImage.read(get("/" + key, MAX_TEXTURE)));
					}
				}
				loaded.add(new Loaded(json, data, dir));
			}
			Minecraft.getInstance().execute(() -> {
				Map<String, Identifier> ids = new HashMap<>();
				images.forEach((key, image) -> {
					// cosmetics/<id>/tex0.png → hytpotchi_cosmetics:mesh/<id>/tex0
					String texPath = "mesh/" + key.substring("cosmetics/".length(), key.length() - ".png".length());
					Identifier texId = Identifier.fromNamespaceAndPath("hytpotchi_cosmetics", texPath);
					Minecraft.getInstance().getTextureManager().register(texId, new DynamicTexture(() -> "Hytpotchi cosmetic " + key, image));
					ids.put(key, texId);
				});
				List<MeshModel.Part> parts = new ArrayList<>();
				for (Loaded l : loaded) {
					List<Identifier> textures = new ArrayList<>();
					for (String name : l.data().textures()) {
						textures.add(ids.get(l.dir() + "/" + name));
					}
					JsonObject j = l.json();
					parts.add(new MeshModel.Part(
						j.get("bone").getAsString(),
						MeshModel.vec(j, "pivot"),
						MeshModel.vec(j, "rot"),
						j.has("anim") ? j.get("anim").getAsString() : "",
						l.data().groups(),
						textures));
				}
				item.meshes = parts;
				LOG.info("3D-модель {} загружена", id);
			});
		} catch (Exception e) {
			LOG.warn("3D-модель {} не загружена, рисую кубами: {}", id, e.toString());
		}
	}

	/** Что надето у игрока (пусто, пока не загрузилось). Зовётся из рендера */
	static List<Item> forPlayer(String name) {
		if (server == null) {
			return List.of();
		}
		long now = System.currentTimeMillis();
		Map<String, Item> cat = catalog;
		if (cat.isEmpty() && now - catalogAt > CATALOG_RETRY_MS) {
			loadCatalog();
		}
		String key = name.toLowerCase(Locale.ROOT);
		Selection sel = SELECTIONS.get(key);
		if (sel == null || (!sel.loading() && now - sel.at() > sel.refreshAfter())) {
			Selection old = sel;
			SELECTIONS.put(key, new Selection(old == null ? List.of() : old.items(), now, true, old == null ? 0 : old.failures()));
			LOOKUPS.execute(() -> fetch(key, name, old));
		}
		if (sel == null || sel.items().isEmpty()) {
			return List.of();
		}
		List<Item> out = new ArrayList<>();
		boolean unknown = false;
		for (String id : sel.items()) {
			Item item = cat.get(id);
			if (item != null) {
				out.add(item);
			} else {
				unknown = true;
			}
		}
		// Игрок надел предмет, который появился в магазине уже после нашего входа в игру
		if (unknown && !cat.isEmpty() && now - catalogAt > CATALOG_RETRY_MS) {
			loadCatalog();
		}
		return out;
	}

	private static void fetch(String key, String name, @Nullable Selection old) {
		int failures = old == null ? 0 : old.failures();
		try {
			byte[] body = get("/api/cosmetics/" + URLEncoder.encode(name, StandardCharsets.UTF_8), 64 * 1024, 15_000);
			JsonArray arr = JsonParser.parseString(new String(body, StandardCharsets.UTF_8))
				.getAsJsonObject()
				.getAsJsonArray("items");
			List<String> items = new ArrayList<>();
			arr.forEach(e -> items.add(e.getAsString()));
			SELECTIONS.put(key, new Selection(List.copyOf(items), System.currentTimeMillis(), false, 0));
			if (failures > 0) {
				LOG.info("Косметика {} снова доступна", name);
			}
		} catch (Exception e) {
			// Сервер недоступен — оставляем, что было, и скоро пробуем снова. В лог — один раз за серию ошибок
			if (failures == 0) {
				LOG.warn("Не удалось узнать, что надето у {}: {} — попробую снова", name, e.toString());
			}
			SELECTIONS.put(key, new Selection(old == null ? List.of() : old.items(), System.currentTimeMillis(), false, failures + 1));
		}
	}
}
