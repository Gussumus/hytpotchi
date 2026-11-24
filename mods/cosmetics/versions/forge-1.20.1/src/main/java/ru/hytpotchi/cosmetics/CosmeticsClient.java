package ru.hytpotchi.cosmetics;

import com.mojang.blaze3d.platform.NativeImage;
import java.io.ByteArrayInputStream;
import net.minecraft.client.Minecraft;
import net.minecraft.client.model.EntityModel;
import net.minecraft.client.renderer.entity.LivingEntityRenderer;
import net.minecraft.client.renderer.entity.player.PlayerRenderer;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.entity.player.Player;
import net.minecraftforge.client.event.EntityRenderersEvent;
import net.minecraftforge.eventbus.api.IEventBus;
import ru.hytpotchi.cosmetics.core.Cosmetics;

/**
 * Мод косметики Hytpotchi для Forge 1.20–1.20.1. Лаунчер ставит его в сборки Forge и передаёт адрес
 * сервера: -Dhytpotchi.server=https://…  Что надето у игрока, выбирается в лаунчере.
 * Рисует тот же слой, что и сборка для Fabric 1.20.1; отличается только подключение к игре.
 */
// new ResourceLocation(…) устарел в Forge 47.4, но fromNamespaceAndPath нет в 47.0–47.3 — а в лаунчере
// можно выбрать любую сборку Forge 1.20.1
@SuppressWarnings("removal")
public final class CosmeticsClient {
	static final ResourceLocation WHITE = new ResourceLocation("hytpotchi_cosmetics", "textures/white.png");
	static Cosmetics<ResourceLocation> cosmetics;

	private CosmeticsClient() {}

	static void init(IEventBus modBus) {
		cosmetics = Cosmetics.start(new Cosmetics.Platform<ResourceLocation>() {
			@Override
			public ResourceLocation white() {
				return WHITE;
			}

			@Override
			public ResourceLocation registerTexture(String path, byte[] png) throws Exception {
				ResourceLocation id = new ResourceLocation("hytpotchi_cosmetics", path);
				NativeImage image = NativeImage.read(new ByteArrayInputStream(png));
				Minecraft.getInstance().getTextureManager().register(id, new DynamicTexture(image));
				return id;
			}

			@Override
			public void onMain(Runnable task) {
				Minecraft.getInstance().execute(task);
			}
		});
		if (cosmetics == null) {
			return;
		}
		modBus.addListener(CosmeticsClient::addLayers);
		TestShot.register();
	}

	/** Слой косметики — каждой модели игрока (обычная и тонкие руки) */
	private static void addLayers(EntityRenderersEvent.AddLayers event) {
		for (String skin : event.getSkins()) {
			LivingEntityRenderer<? extends Player, ? extends EntityModel<? extends Player>> renderer = event.getSkin(skin);
			if (renderer instanceof PlayerRenderer player) {
				player.addLayer(new CosmeticsLayer(player));
			}
		}
	}
}
