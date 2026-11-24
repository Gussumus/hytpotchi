package ru.hytpotchi.cosmetics.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.zip.GZIPInputStream;

/**
 * HTTP к серверу Hytpotchi. Общий код для всех версий игры, поэтому только Java 8:
 * на 1.16.5 игра идёт на Java 8, где нет java.net.http.
 *
 * <ul>
 * <li>Каждый запрос — новое соединение: у части провайдеров долгие соединения к Cloudflare «замерзают».
 * <li>Ответ — обязательно сжатый: у части российских провайдеров без VPN соединение с Cloudflare
 * обрывается после ~16 КБ, а каталог и 3D-модели без сжатия больше (каталог 31 КБ, со сжатием 7 КБ).
 * <li>Прокси: Java не видит системный прокси Windows (его ставят VPN-программы), поэтому лаунчер
 * передаёт его сам: -Dhytpotchi.proxy=http://host:port или socks5://host:port. Сначала идём через
 * него, не вышло — напрямую.
 * </ul>
 */
final class Net {
	private static final Proxy PROXY = parseProxy(System.getProperty("hytpotchi.proxy"));

	private Net() {}

	/** "http://127.0.0.1:10809" / "socks5://127.0.0.1:10808" → прокси Java, иначе null */
	static Proxy parseProxy(String raw) {
		if (raw == null || raw.trim().isEmpty()) {
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

	static byte[] get(String url, int maxBytes, int readTimeoutMs) throws IOException {
		if (PROXY != null) {
			try {
				return fetch(url, maxBytes, readTimeoutMs, PROXY);
			} catch (IOException e) {
				// Прокси выключен или не отвечает — пробуем напрямую
			}
		}
		return fetch(url, maxBytes, readTimeoutMs, Proxy.NO_PROXY);
	}

	private static byte[] fetch(String url, int maxBytes, int readTimeoutMs, Proxy proxy) throws IOException {
		HttpURLConnection c = (HttpURLConnection) URI.create(url).toURL().openConnection(proxy);
		try {
			c.setConnectTimeout(10_000);
			c.setReadTimeout(readTimeoutMs);
			c.setUseCaches(false);
			c.setInstanceFollowRedirects(true);
			c.setRequestProperty("User-Agent", "HytpotchiCosmetics/4");
			c.setRequestProperty("Accept-Encoding", "gzip");
			c.setRequestProperty("Connection", "close");
			int code = c.getResponseCode();
			if (code != 200) {
				throw new IOException("HTTP " + code);
			}
			try (InputStream raw = c.getInputStream();
				InputStream in = "gzip".equalsIgnoreCase(c.getContentEncoding()) ? new GZIPInputStream(raw) : raw) {
				ByteArrayOutputStream out = new ByteArrayOutputStream();
				byte[] buf = new byte[16 * 1024];
				int n;
				while ((n = in.read(buf)) > 0) {
					out.write(buf, 0, n);
					if (out.size() > maxBytes) {
						throw new IOException("ответ больше " + maxBytes + " байт");
					}
				}
				return out.toByteArray();
			}
		} finally {
			c.disconnect();
		}
	}

	static byte[] get(String url, int maxBytes) throws IOException {
		return get(url, maxBytes, 30_000);
	}

	static String text(String url) throws IOException {
		return new String(get(url, 8 * 1024 * 1024), StandardCharsets.UTF_8);
	}

	/** Короткий запрос (что надето у игрока): ждём меньше, чтобы быстрее повторить */
	static String quickText(String url) throws IOException {
		return new String(get(url, 64 * 1024, 15_000), StandardCharsets.UTF_8);
	}
}
