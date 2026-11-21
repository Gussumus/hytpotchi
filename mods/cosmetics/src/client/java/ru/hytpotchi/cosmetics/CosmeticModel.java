package ru.hytpotchi.cosmetics;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import net.minecraft.client.model.geom.ModelPart;
import net.minecraft.client.model.geom.PartPose;
import net.minecraft.client.model.geom.builders.CubeDeformation;
import net.minecraft.client.model.geom.builders.CubeListBuilder;
import net.minecraft.client.model.geom.builders.LayerDefinition;
import net.minecraft.client.model.geom.builders.MeshDefinition;
import net.minecraft.client.model.geom.builders.PartDefinition;
import net.minecraft.client.model.player.PlayerModel;
import net.minecraft.client.renderer.entity.state.AvatarRenderState;

/**
 * Деталь косметики из каталога: кубы одного цвета, прикреплённые к части тела игрока.
 * Модель повторяет скелет игрока (как уши deadmau5 в самой игре), поэтому деталь двигается
 * вместе с головой, телом или рукой; поверх — своя анимация (взмахи крыльев и т. п.).
 */
public final class CosmeticModel extends PlayerModel {
	private static final Set<String> BONES = Set.of("head", "body", "left_arm", "right_arm");
	private static final String PART = "hytpotchi_cosmetic";

	public record Part(CosmeticModel model, int color) {}

	private final ModelPart piece;
	private final String anim;
	private final float baseX;
	private final float baseY;

	private CosmeticModel(ModelPart root, String bone, String anim, float baseX, float baseY) {
		super(root, false);
		this.piece = root.getChild(bone).getChild(PART);
		this.anim = anim;
		this.baseX = baseX;
		this.baseY = baseY;
	}

	private static float[] vec(JsonObject o, String key) {
		float[] v = new float[3];
		if (o.has(key)) {
			JsonArray a = o.getAsJsonArray(key);
			for (int i = 0; i < 3; i++) {
				v[i] = a.get(i).getAsFloat();
			}
		}
		return v;
	}

	/** Модели деталей предмета из его описания в каталоге */
	static List<Part> build(JsonArray parts) {
		List<Part> out = new ArrayList<>();
		for (JsonElement el : parts) {
			JsonObject p = el.getAsJsonObject();
			String bone = p.get("bone").getAsString();
			if (!BONES.contains(bone)) {
				throw new IllegalArgumentException("кость " + bone);
			}
			String hex = p.get("color").getAsString();
			int color = 0xFF000000 | Integer.parseInt(hex.substring(1), 16);
			String anim = p.has("anim") ? p.get("anim").getAsString() : "";
			float[] pivot = vec(p, "pivot");
			float[] rot = vec(p, "rot");

			CubeListBuilder cubes = CubeListBuilder.create();
			for (JsonElement c : p.getAsJsonArray("cubes")) {
				JsonArray a = c.getAsJsonArray();
				cubes.addBox(a.get(0).getAsFloat(), a.get(1).getAsFloat(), a.get(2).getAsFloat(),
					a.get(3).getAsFloat(), a.get(4).getAsFloat(), a.get(5).getAsFloat());
			}
			MeshDefinition mesh = PlayerModel.createMesh(CubeDeformation.NONE, false);
			PartDefinition root = mesh.getRoot().clearRecursively();
			root.getChild(bone).addOrReplaceChild(PART, cubes,
				PartPose.offsetAndRotation(pivot[0], pivot[1], pivot[2], rot[0], rot[1], rot[2]));
			ModelPart baked = LayerDefinition.create(mesh, 64, 64).bakeRoot();
			out.add(new Part(new CosmeticModel(baked, bone, anim, rot[0], rot[1]), color));
		}
		return out;
	}

	@Override
	public void setupAnim(AvatarRenderState state) {
		super.setupAnim(state);
		float t = state.ageInTicks;
		switch (this.anim) {
			case "flap_left" -> this.piece.yRot = this.baseY - 0.35F * (1 + (float) Math.sin(t * 0.18F)) / 2;
			case "flap_right" -> this.piece.yRot = this.baseY + 0.35F * (1 + (float) Math.sin(t * 0.18F)) / 2;
			case "sway" -> this.piece.yRot = this.baseY + 0.25F * (float) Math.sin(t * 0.1F);
			case "spin" -> this.piece.yRot = t * 0.05F;
			default -> {
			}
		}
		if ("sway".equals(this.anim)) {
			this.piece.xRot = this.baseX + 0.05F * (float) Math.sin(t * 0.07F);
		}
	}
}
