package ru.hytpotchi.cosmetics;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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

	private static final ExecutorService POOL = Executors.newFixedThreadPool(2, r -> {
		Thread t = new Thread(r, "Hytpotchi Cosmetics");
		t.setDaemon(true);
		return t;
	});

	private static @Nullable String server;
	private static volatile Map<String, List<CosmeticModel.Part>> catalog = Map.of();
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

	private static String get(String path) throws Exception {
		// Свой клиент на каждый запрос — без переиспользования соединений
		try (HttpClient client = HttpClient.newBuilder()
			.version(HttpClient.Version.HTTP_1_1)
			.connectTimeout(Duration.ofSeconds(10))
			.build()) {
			HttpRequest req = HttpRequest.newBuilder(URI.create(server + path))
				.timeout(Duration.ofSeconds(15))
				.header("User-Agent", "HytpotchiCosmetics/1")
				.GET()
				.build();
			HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
			if (resp.statusCode() != 200) {
				throw new IllegalStateException("HTTP " + resp.statusCode());
			}
			return resp.body();
		}
	}

	private static void loadCatalog() {
		catalogAt = System.currentTimeMillis();
		POOL.execute(() -> {
			try {
				JsonObject root = JsonParser.parseString(get("/api/cosmetics/catalog")).getAsJsonObject();
				Map<String, List<CosmeticModel.Part>> built = new ConcurrentHashMap<>();
				for (JsonElement el : root.getAsJsonArray("items")) {
					JsonObject item = el.getAsJsonObject();
					String id = item.get("id").getAsString();
					try {
						built.put(id, CosmeticModel.build(item.getAsJsonArray("parts")));
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

	/** Модели того, что надето у игрока (пусто, пока не загрузилось) */
	static List<List<CosmeticModel.Part>> forPlayer(String name) {
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
		List<List<CosmeticModel.Part>> out = new ArrayList<>();
		for (String id : sel.items()) {
			List<CosmeticModel.Part> parts = catalog.get(id);
			if (parts != null) {
				out.add(parts);
			}
		}
		return out;
	}

	private static void fetch(String key, String name, @Nullable Selection old) {
		try {
			JsonArray arr = JsonParser.parseString(get("/api/cosmetics/" + URLEncoder.encode(name, StandardCharsets.UTF_8)))
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
