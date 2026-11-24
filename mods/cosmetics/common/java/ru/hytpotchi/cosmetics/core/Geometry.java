package ru.hytpotchi.cosmetics.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Геометрия косметики без классов Minecraft: треугольники в пикселях модели от точки опоры детали.
 * На вершину — 11 чисел: x y z, u v, nx ny nz, r g b (0…1).
 * Кубы из каталога тоже превращаются в треугольники — так одна и та же отрисовка подходит
 * всем версиям игры, а модели Minecraft (их API менялся почти каждый год) не нужны.
 */
public final class Geometry {
	/** cosmetics/<id>/<файл>.json — ничего, кроме файлов косметики */
	static final Pattern PATH = Pattern.compile("cosmetics/[a-z_]{1,32}/[a-z0-9_-]{1,32}\\.json");
	static final Pattern TEXTURE = Pattern.compile("tex[0-9]{1,3}\\.png");
	/** Больше треугольников в одной детали не рисуем: это косметика, а не карта мира */
	private static final int MAX_TRIANGLES = 20_000;

	private Geometry() {}

	/** Треугольники с одной текстурой: texture — индекс в списке текстур детали, −1 — белая (кубы) */
	public static final class Group {
		public final int texture;
		/** По 11 чисел на вершину, см. описание класса */
		public final float[] v;
		/** Цвет вершины ARGB */
		public final int[] colors;
		/** По 3 индекса вершин на треугольник */
		public final int[] i;

		Group(int texture, float[] v, int[] colors, int[] i) {
			this.texture = texture;
			this.v = v;
			this.colors = colors;
			this.i = i;
		}
	}

	/** Разобранный mesh.json */
	static final class Mesh {
		final List<String> textures;
		final List<Group> groups;

		Mesh(List<String> textures, List<Group> groups) {
			this.textures = textures;
			this.groups = groups;
		}
	}

	static Mesh parseMesh(JsonObject json) {
		if (json.get("format").getAsInt() != 1) {
			throw new IllegalArgumentException("формат модели " + json.get("format"));
		}
		List<String> textures = new ArrayList<>();
		for (JsonElement t : json.getAsJsonArray("textures")) {
			String name = t.getAsString();
			if (!TEXTURE.matcher(name).matches()) {
				throw new IllegalArgumentException("текстура " + name);
			}
			textures.add(name);
		}
		List<Group> groups = new ArrayList<>();
		int triangles = 0;
		for (JsonElement el : json.getAsJsonArray("groups")) {
			JsonObject g = el.getAsJsonObject();
			int texture = g.get("texture").getAsInt();
			if (texture < -1 || texture >= textures.size()) {
				throw new IllegalArgumentException("номер текстуры " + texture);
			}
			JsonArray va = g.getAsJsonArray("v");
			JsonArray ia = g.getAsJsonArray("i");
			if (va.size() % 11 != 0 || ia.size() % 3 != 0) {
				throw new IllegalArgumentException("размер группы");
			}
			triangles += ia.size() / 3;
			if (triangles > MAX_TRIANGLES) {
				throw new IllegalArgumentException("слишком много треугольников");
			}
			float[] v = new float[va.size()];
			for (int k = 0; k < v.length; k++) {
				v[k] = va.get(k).getAsFloat();
			}
			int vertices = v.length / 11;
			int[] i = new int[ia.size()];
			for (int k = 0; k < i.length; k++) {
				i[k] = ia.get(k).getAsInt();
				if (i[k] < 0 || i[k] >= vertices) {
					throw new IllegalArgumentException("индекс вершины");
				}
			}
			int[] colors = new int[vertices];
			for (int k = 0; k < vertices; k++) {
				int o = k * 11;
				colors[k] = 0xFF000000 | channel(v[o + 8]) << 16 | channel(v[o + 9]) << 8 | channel(v[o + 10]);
			}
			groups.add(new Group(texture, v, colors, i));
		}
		return new Mesh(textures, groups);
	}

	/** Кубы детали ([x, y, z, w, h, d] в пикселях от точки опоры) — треугольниками одного цвета */
	static Group cubes(JsonArray cubes, int color) {
		int boxes = cubes.size();
		float[] v = new float[boxes * 24 * 11];
		int[] colors = new int[boxes * 24];
		int[] idx = new int[boxes * 36];
		float r = (color >> 16 & 0xFF) / 255F;
		float g = (color >> 8 & 0xFF) / 255F;
		float b = (color & 0xFF) / 255F;
		int vert = 0;
		int tri = 0;
		for (JsonElement c : cubes) {
			JsonArray a = c.getAsJsonArray();
			float x0 = a.get(0).getAsFloat();
			float y0 = a.get(1).getAsFloat();
			float z0 = a.get(2).getAsFloat();
			float x1 = x0 + a.get(3).getAsFloat();
			float y1 = y0 + a.get(4).getAsFloat();
			float z1 = z0 + a.get(5).getAsFloat();
			// Грани: 4 угла и наружная нормаль
			float[][] faces = {
				{x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0},
				{x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0},
				{x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0, 0, 0, -1},
				{x1, y0, z1, x1, y1, z1, x0, y1, z1, x0, y0, z1, 0, 0, 1},
				{x0, y0, z1, x0, y1, z1, x0, y1, z0, x0, y0, z0, -1, 0, 0},
				{x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1, 1, 0, 0},
			};
			float[][] uv = {{0, 0}, {0, 1}, {1, 1}, {1, 0}};
			for (float[] f : faces) {
				int first = vert;
				for (int k = 0; k < 4; k++) {
					int o = vert * 11;
					v[o] = f[k * 3];
					v[o + 1] = f[k * 3 + 1];
					v[o + 2] = f[k * 3 + 2];
					v[o + 3] = uv[k][0];
					v[o + 4] = uv[k][1];
					v[o + 5] = f[12];
					v[o + 6] = f[13];
					v[o + 7] = f[14];
					v[o + 8] = r;
					v[o + 9] = g;
					v[o + 10] = b;
					colors[vert] = 0xFF000000 | color;
					vert++;
				}
				int[] t = {first, first + 1, first + 2, first, first + 2, first + 3};
				System.arraycopy(t, 0, idx, tri, 6);
				tri += 6;
			}
		}
		return new Group(-1, v, colors, idx);
	}

	private static int channel(float c) {
		return Math.round(Math.max(0F, Math.min(1F, c)) * 255F);
	}

	static float[] vec(JsonObject o, String key) {
		float[] v = new float[3];
		if (o.has(key)) {
			JsonArray a = o.getAsJsonArray(key);
			for (int k = 0; k < 3; k++) {
				v[k] = a.get(k).getAsFloat();
			}
		}
		return v;
	}
}
