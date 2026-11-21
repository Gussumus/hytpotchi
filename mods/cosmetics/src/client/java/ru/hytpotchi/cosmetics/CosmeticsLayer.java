package ru.hytpotchi.cosmetics;

import com.mojang.blaze3d.vertex.PoseStack;
import java.util.List;
import net.minecraft.client.Minecraft;
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

/** Слой рендера игрока: рисует надетую косметику (белая текстура, окрашенная в цвет детали) */
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
		List<List<CosmeticModel.Part>> items = Cosmetics.forPlayer(player.getGameProfile().name());
		if (items.isEmpty()) {
			return;
		}
		int overlay = LivingEntityRenderer.getOverlayCoords(state, 0.0F);
		for (List<CosmeticModel.Part> item : items) {
			for (CosmeticModel.Part part : item) {
				collector.submitModel(part.model(), state, poseStack, RenderTypes.entityCutout(WHITE), lightCoords, overlay,
					part.color(), null, state.outlineColor);
			}
		}
	}
}
