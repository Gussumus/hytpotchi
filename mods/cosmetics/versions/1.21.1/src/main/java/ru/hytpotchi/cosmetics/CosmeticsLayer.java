package ru.hytpotchi.cosmetics;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import java.util.List;
import net.minecraft.client.model.PlayerModel;
import net.minecraft.client.model.geom.ModelPart;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.entity.LivingEntityRenderer;
import net.minecraft.client.renderer.entity.RenderLayerParent;
import net.minecraft.client.renderer.entity.layers.RenderLayer;
import net.minecraft.resources.ResourceLocation;
import org.joml.Quaternionf;
import ru.hytpotchi.cosmetics.core.Cosmetics;
import ru.hytpotchi.cosmetics.core.Geometry;

/** Слой рендера игрока: надетая косметика — треугольники на костях игрока */
public final class CosmeticsLayer extends RenderLayer<AbstractClientPlayer, PlayerModel<AbstractClientPlayer>> {
	public CosmeticsLayer(RenderLayerParent<AbstractClientPlayer, PlayerModel<AbstractClientPlayer>> parent) {
		super(parent);
	}

	@Override
	public void render(PoseStack pose, MultiBufferSource buffers, int light, AbstractClientPlayer player, float limbSwing,
		float limbSwingAmount, float partialTick, float ageInTicks, float netHeadYaw, float headPitch) {
		if (player.isInvisible()) {
			return;
		}
		List<Cosmetics.Part<ResourceLocation>> parts = CosmeticsClient.cosmetics.forPlayer(player.getGameProfile().getName());
		if (parts.isEmpty()) {
			return;
		}
		int overlay = LivingEntityRenderer.getOverlayCoords(player, 0.0F);
		PlayerModel<AbstractClientPlayer> model = this.getParentModel();
		for (Cosmetics.Part<ResourceLocation> part : parts) {
			ModelPart bone = switch (part.bone) {
				case "head" -> model.head;
				case "body" -> model.body;
				case "left_arm" -> model.leftArm;
				case "right_arm" -> model.rightArm;
				default -> null;
			};
			if (bone == null || !bone.visible) {
				continue;
			}
			pose.pushPose();
			bone.translateAndRotate(pose);
			pose.translate(part.pivot[0] / 16.0F, part.pivot[1] / 16.0F, part.pivot[2] / 16.0F);
			float[] a = part.angles(ageInTicks);
			pose.mulPose(new Quaternionf().rotationZYX(a[2], a[1], a[0]));
			pose.scale(1.0F / 16.0F, 1.0F / 16.0F, 1.0F / 16.0F);
			PoseStack.Pose p = pose.last();
			for (Geometry.Group g : part.groups) {
				VertexConsumer out = buffers.getBuffer(RenderType.entityCutoutNoCull(part.texture(g)));
				// Entity-слои рисуют четырёхугольниками: треугольник — с повторённой вершиной
				for (int t = 0; t + 2 < g.i.length; t += 3) {
					vertex(out, p, g, g.i[t], light, overlay);
					vertex(out, p, g, g.i[t + 1], light, overlay);
					vertex(out, p, g, g.i[t + 2], light, overlay);
					vertex(out, p, g, g.i[t + 2], light, overlay);
				}
			}
			pose.popPose();
		}
	}

	private static void vertex(VertexConsumer out, PoseStack.Pose p, Geometry.Group g, int k, int light, int overlay) {
		int o = k * 11;
		int c = g.colors[k];
		out.addVertex(p, g.v[o], g.v[o + 1], g.v[o + 2])
			.setColor(c >> 16 & 0xFF, c >> 8 & 0xFF, c & 0xFF, 0xFF)
			.setUv(g.v[o + 3], g.v[o + 4])
			.setOverlay(overlay)
			.setLight(light)
			.setNormal(p, g.v[o + 5], g.v[o + 6], g.v[o + 7]);
	}
}
