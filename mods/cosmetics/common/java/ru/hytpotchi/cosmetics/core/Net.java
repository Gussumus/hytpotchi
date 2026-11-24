package ru.hytpotchi.cosmetics.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.zip.GZIPInputStream;

/**
 * HTTP к серверу Hytpotchi. Общий код для всех версий игры, поэтому только Java 8:
 * на 1.16.5 игра идёт на Java 8, где нет java.net.http.
 * Каждый запрос — новое соединение: у части провайдеров долгие соединения к Cloudflare «замерзают».
 * Ответ — обязательно сжатый: у части российских провайдеров без VPN соединение с Cloudflare
 * обрывается после ~16 КБ, а каталог и 3D-модели без сжатия больше (каталог 31 КБ, со сжатием 7 КБ).
 */
final class Net {
	private Net() {}

	static byte[] get(String url, int maxBytes) throws IOException {
		HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
		try {
			c.setConnectTimeout(10_000);
			c.setReadTimeout(30_000);
			c.setUseCaches(false);
			c.setInstanceFollowRedirects(true);
			c.setRequestProperty("User-Agent", "HytpotchiCosmetics/3");
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

	static String text(String url) throws IOException {
		return new String(get(url, 8 * 1024 * 1024), StandardCharsets.UTF_8);
	}
}
