package ru.hytpotchi.cosmetics;

import com.mojang.blaze3d.platform.NativeImage;
import java.io.ByteArrayInputStream;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.rendereregistry.v1.LivingEntityFeatureRendererRegistrationCallback;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.entity.player.PlayerRenderer;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.resources.ResourceLocation;
import ru.hytpotchi.cosmetics.core.Cosmetics;

/**
 * Мод косметики Hytpotchi для Minecraft 1.16.5 (Java 8). Лаунчер ставит его в сборки Fabric и передаёт
 * адрес сервера: -Dhytpotchi.server=https://…  Что надето у игрока, выбирается в лаунчере.
 */
public final class CosmeticsClient implements ClientModInitializer {
	static final ResourceLocation WHITE = new ResourceLocation("hytpotchi_cosmetics", "textures/white.png");
	static Cosmetics<ResourceLocation> cosmetics;

	@Override
	public void onInitializeClient() {
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
		// В Fabric API для 1.16 колбэк — в пакете rendereregistry (так он и назывался) и без context
		LivingEntityFeatureRendererRegistrationCallback.EVENT.register((type, renderer, helper) -> {
			if (renderer instanceof PlayerRenderer) {
				helper.register(new CosmeticsLayer((PlayerRenderer) renderer));
			}
		});
		TestShot.register();
	}
}
