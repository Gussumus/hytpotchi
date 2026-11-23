package ru.hytpotchi.cosmetics;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.platform.NativeImage;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.resources.Identifier;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Каталог косметики и что надето у каждого игрока — с сервера Hytpotchi.
 * Каждый запрос — новое соединение: у части провайдеров долгие соединения к Cloudflare «замерзают».
 */
public final class Cosmetics {
	static final Logger LOG = LoggerFactory.getLogger("Hytpotchi Cosmetics");
	/** Как часто перепроверять, что надето у игрока */
	private static final long REFRESH_MS = 3 * 60_000L;
	private static final long RETRY_MS = 30_000L;
	/** Самая большая текстура 3D-модели, которую примем */
	private static final int MAX_TEXTURE = 4 * 1024 * 1024;

	private static final ExecutorService POOL = Executors.newFixedThreadPool(2, r -> {
		Thread t = new Thread(r, "Hytpotchi Cosmetics");
		t.setDaemon(true);
		return t;
	});

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
	private static final Map<String, Selection> SELECTIONS = new ConcurrentHashMap<>();

	private record Selection(List<String> items, long at, boolean loading) {}

	private Cosmetics() {}

	static void init(@Nullable String serverUrl) {
		server = serverUrl == null || serverUrl.isBlank() ? null : serverUrl.replaceAll("/+$", "");
		if (server == null) {
			LOG.info("Сервер Hytpotchi не задан (-Dhytpotchi.server) — косметика выключена");
			return;
		}
		loadCatalog();
	}

	private static <T> T get(String path, HttpResponse.BodyHandler<T> body) throws Exception {
		// Свой клиент на каждый запрос — без переиспользования соединений
		try (HttpClient client = HttpClient.newBuilder()
			.version(HttpClient.Version.HTTP_1_1)
			.connectTimeout(Duration.ofSeconds(10))
			.build()) {
			HttpRequest req = HttpRequest.newBuilder(URI.create(server + path))
				.timeout(Duration.ofSeconds(30))
				.header("User-Agent", "HytpotchiCosmetics/2")
				.GET()
				.build();
			HttpResponse<T> resp = client.send(req, body);
			if (resp.statusCode() != 200) {
				throw new IllegalStateException("HTTP " + resp.statusCode());
			}
			return resp.body();
		}
	}

	private static String getText(String path) throws Exception {
		return get(path, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
	}

	private static void loadCatalog() {
		catalogAt = System.currentTimeMillis();
		POOL.execute(() -> {
			try {
				JsonObject root = JsonParser.parseString(getText("/api/cosmetics/catalog")).getAsJsonObject();
				Map<String, Item> built = new ConcurrentHashMap<>();
				for (JsonElement el : root.getAsJsonArray("items")) {
					JsonObject json = el.getAsJsonObject();
					String id = json.get("id").getAsString();
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
				LOG.warn("Каталог косметики не загружен: {}", e.toString());
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
						byte[] png = get("/" + key, HttpResponse.BodyHandlers.ofByteArray());
						if (png.length > MAX_TEXTURE) {
							throw new IllegalArgumentException("текстура больше 4 МБ");
						}
						images.put(key, NativeImage.read(png));
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

	/** Что надето у игрока (пусто, пока не загрузилось) */
	static List<Item> forPlayer(String name) {
		if (server == null) {
			return List.of();
		}
		long now = System.currentTimeMillis();
		if (catalog.isEmpty() && now - catalogAt > RETRY_MS) {
			loadCatalog();
		}
		String key = name.toLowerCase();
		Selection sel = SELECTIONS.get(key);
		if (sel == null || (!sel.loading() && now - sel.at() > (sel.items().isEmpty() ? RETRY_MS * 4 : REFRESH_MS))) {
			Selection old = sel;
			SELECTIONS.put(key, new Selection(old == null ? List.of() : old.items(), now, true));
			POOL.execute(() -> fetch(key, name, old));
		}
		if (sel == null || sel.items().isEmpty()) {
			return List.of();
		}
		List<Item> out = new ArrayList<>();
		for (String id : sel.items()) {
			Item item = catalog.get(id);
			if (item != null) {
				out.add(item);
			}
		}
		return out;
	}

	private static void fetch(String key, String name, @Nullable Selection old) {
		try {
			JsonArray arr = JsonParser.parseString(getText("/api/cosmetics/" + URLEncoder.encode(name, StandardCharsets.UTF_8)))
				.getAsJsonObject()
				.getAsJsonArray("items");
			List<String> items = new ArrayList<>();
			arr.forEach(e -> items.add(e.getAsString()));
			SELECTIONS.put(key, new Selection(List.copyOf(items), System.currentTimeMillis(), false));
		} catch (Exception e) {
			// Сервер недоступен — оставляем, что было, и попробуем позже
			SELECTIONS.put(key, new Selection(old == null ? List.of() : old.items(), System.currentTimeMillis(), false));
		}
	}
}
