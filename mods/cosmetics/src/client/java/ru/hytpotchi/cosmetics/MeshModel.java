package ru.hytpotchi.cosmetics;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import net.minecraft.resources.Identifier;

/**
 * 3D-модель предмета (mesh.json, его готовит tools/cosmetics-import): треугольники с текстурой,
 * в пикселях модели Minecraft от точки опоры детали. На вершину — 11 чисел:
 * x y z, u v, nx ny nz, r g b (0…1). Рисуется на кости игрока вместо кубов из parts.
 */
final class MeshModel {
	/** cosmetics/<id>/<файл>.json — ничего, кроме файлов косметики */
	static final Pattern PATH = Pattern.compile("cosmetics/[a-z_]{1,32}/[a-z0-9_-]{1,32}\\.json");
	static final Pattern TEXTURE = Pattern.compile("tex[0-9]{1,3}\\.png");
	/** Больше треугольников в одной детали не рисуем: это косметика, а не карта мира */
	private static final int MAX_TRIANGLES = 20_000;

	/** Группа треугольников с одной текстурой (texture — индекс в списке текстур файла, −1 — без неё) */
	record Group(int texture, float[] v, int[] colors, int[] i) {
		/** Каждый треугольник — четырёхугольник с повторённой вершиной: entity-слои рисуют квадами */
		void emit(PoseStack.Pose pose, VertexConsumer out, int light, int overlay) {
			for (int t = 0; t + 2 < this.i.length; t += 3) {
				vertex(pose, out, this.i[t], light, overlay);
				vertex(pose, out, this.i[t + 1], light, overlay);
				vertex(pose, out, this.i[t + 2], light, overlay);
				vertex(pose, out, this.i[t + 2], light, overlay);
			}
		}

		private void vertex(PoseStack.Pose pose, VertexConsumer out, int k, int light, int overlay) {
			int o = k * 11;
			out.addVertex(pose, this.v[o], this.v[o + 1], this.v[o + 2])
				.setColor(this.colors[k])
				.setUv(this.v[o + 3], this.v[o + 4])
				.setOverlay(overlay)
				.setLight(light)
				.setNormal(pose, this.v[o + 5], this.v[o + 6], this.v[o + 7]);
		}
	}

	/** Разобранный mesh.json: имена текстур и группы */
	record Data(List<String> textures, List<Group> groups) {}

	/** Деталь, готовая к рисованию: текстуры уже зарегистрированы в игре */
	record Part(String bone, float[] pivot, float[] rot, String anim, List<Group> groups, List<Identifier> textures) {
		/** Поворот детали с анимацией — тот же расчёт, что у кубов (CosmeticModel) */
		float[] angles(float t) {
			float x = this.rot[0];
			float y = this.rot[1];
			switch (this.anim) {
				case "flap_left" -> y = this.rot[1] - 0.35F * (1 + (float) Math.sin(t * 0.18F)) / 2;
				case "flap_right" -> y = this.rot[1] + 0.35F * (1 + (float) Math.sin(t * 0.18F)) / 2;
				case "sway" -> {
					y = this.rot[1] + 0.25F * (float) Math.sin(t * 0.1F);
					x = this.rot[0] + 0.05F * (float) Math.sin(t * 0.07F);
				}
				case "spin" -> y = t * 0.05F;
				default -> {
				}
			}
			return new float[] {x, y, this.rot[2]};
		}
	}

	private MeshModel() {}

	static Data parse(JsonObject json) {
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
		return new Data(textures, groups);
	}

	private static int channel(float c) {
		return Math.round(Math.clamp(c, 0F, 1F) * 255F);
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
