package ru.hytpotchi.cosmetics;

import com.mojang.blaze3d.vertex.PoseStack;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.client.model.geom.ModelPart;
import net.minecraft.client.model.player.PlayerModel;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.entity.LivingEntityRenderer;
import net.minecraft.client.renderer.entity.RenderLayerParent;
import net.minecraft.client.renderer.entity.layers.RenderLayer;
import net.minecraft.client.renderer.entity.state.AvatarRenderState;
import net.minecraft.client.renderer.rendertype.RenderTypes;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import org.joml.Quaternionf;

/**
 * Слой рендера игрока: рисует надетую косметику. Модели из кубов — белая текстура, окрашенная
 * в цвет детали; 3D-модели — треугольники со своей текстурой на кости игрока.
 */
public final class CosmeticsLayer extends RenderLayer<AvatarRenderState, PlayerModel> {
	static final Identifier WHITE = Identifier.fromNamespaceAndPath("hytpotchi_cosmetics", "textures/white.png");

	public CosmeticsLayer(RenderLayerParent<AvatarRenderState, PlayerModel> parent) {
		super(parent);
	}

	@Override
	public void submit(PoseStack poseStack, SubmitNodeCollector collector, int lightCoords, AvatarRenderState state, float yRot, float xRot) {
		if (state.isInvisible || Minecraft.getInstance().level == null) {
			return;
		}
		Entity entity = Minecraft.getInstance().level.getEntity(state.id);
		if (!(entity instanceof Player player)) {
			return;
		}
		List<Cosmetics.Item> items = Cosmetics.forPlayer(player.getGameProfile().name());
		if (items.isEmpty()) {
			return;
		}
		int overlay = LivingEntityRenderer.getOverlayCoords(state, 0.0F);
		for (Cosmetics.Item item : items) {
			List<MeshModel.Part> meshes = item.meshes;
			if (meshes != null) {
				for (MeshModel.Part part : meshes) {
					submitMesh(poseStack, collector, part, state, lightCoords, overlay);
				}
				continue;
			}
			for (CosmeticModel.Part part : item.cubes) {
				collector.submitModel(part.model(), state, poseStack, RenderTypes.entityCutout(WHITE), lightCoords, overlay,
					part.color(), null, state.outlineColor);
			}
		}
	}

	/** 3D-модель на кости: та же цепочка поворотов, что у частей модели игрока, затем точка опоры детали */
	private void submitMesh(PoseStack poseStack, SubmitNodeCollector collector, MeshModel.Part part, AvatarRenderState state,
		int light, int overlay) {
		PlayerModel model = this.getParentModel();
		ModelPart bone = switch (part.bone()) {
			case "head" -> model.head;
			case "body" -> model.body;
			case "left_arm" -> model.leftArm;
			case "right_arm" -> model.rightArm;
			default -> null;
		};
		if (bone == null || !bone.visible) {
			return;
		}
		poseStack.pushPose();
		model.root().translateAndRotate(poseStack);
		bone.translateAndRotate(poseStack);
		float[] pivot = part.pivot();
		poseStack.translate(pivot[0] / 16.0F, pivot[1] / 16.0F, pivot[2] / 16.0F);
		float[] a = part.angles(state.ageInTicks);
		poseStack.rotate(new Quaternionf().rotationZYX(a[2], a[1], a[0]));
		poseStack.scale(1.0F / 16.0F, 1.0F / 16.0F, 1.0F / 16.0F);
		for (MeshModel.Group group : part.groups()) {
			Identifier texture = group.texture() >= 0 ? part.textures().get(group.texture()) : WHITE;
			collector.submitCustomGeometry(poseStack, RenderTypes.entityCutout(texture),
				(pose, buffer) -> group.emit(pose, buffer, light, overlay));
		}
		poseStack.popPose();
	}
}
