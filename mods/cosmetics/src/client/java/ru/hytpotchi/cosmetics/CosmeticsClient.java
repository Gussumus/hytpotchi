package ru.hytpotchi.cosmetics;

import java.io.File;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.LivingEntityRenderLayerRegistrationCallback;
import net.minecraft.client.CameraType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.renderer.entity.player.AvatarRenderer;

/**
 * Мод косметики Hytpotchi. Лаунчер ставит его в сборки Fabric и передаёт адрес сервера:
 * -Dhytpotchi.server=https://…  Что надето у игрока, выбирается в лаунчере («Скины»).
 */
public final class CosmeticsClient implements ClientModInitializer {
	@Override
	@SuppressWarnings({"unchecked", "rawtypes"})
	public void onInitializeClient() {
		Cosmetics.init(System.getProperty("hytpotchi.server"));
		LivingEntityRenderLayerRegistrationCallback.EVENT.register((type, renderer, helper, context) -> {
			if (renderer instanceof AvatarRenderer avatar) {
				helper.register(new CosmeticsLayer(avatar));
			}
		});
		registerTestScreenshot();
	}

	/**
	 * Для проверки мода: -Dhytpotchi.cosmetics.screenshot=<секунд> — через столько секунд в мире
	 * повернуть камеру к лицу игрока и сохранить скриншот в screenshots/.
	 */
	private static void registerTestScreenshot() {
		String raw = System.getProperty("hytpotchi.cosmetics.screenshot");
		if (raw == null) {
			return;
		}
		int ticks = Integer.parseInt(raw.trim()) * 20;
		int[] inWorld = {0};
		ClientTickEvents.END_CLIENT_TICK.register(mc -> {
			if (mc.player == null || mc.level == null || inWorld[0] < 0) {
				return;
			}
			inWorld[0]++;
			if (inWorld[0] == 20) {
				// Крупный план: без интерфейса, узкий угол обзора, взгляд чуть вверх
				if (!mc.gui.hud.isHidden()) {
					mc.gui.hud.toggle();
				}
				mc.options.fov().set(30);
				mc.player.setXRot(-15);
				mc.options.setCameraType(CameraType.THIRD_PERSON_FRONT);
			}
			if (inWorld[0] == ticks) {
				shot(mc, "cosmetics_front.png");
				mc.options.setCameraType(CameraType.THIRD_PERSON_BACK);
			}
			if (inWorld[0] == ticks + 40) {
				shot(mc, "cosmetics_back.png");
				mc.player.setYRot(mc.player.getYRot() + 70);
			}
			if (inWorld[0] == ticks + 80) {
				shot(mc, "cosmetics_side.png");
				inWorld[0] = -1;
			}
		});
	}

	private static void shot(Minecraft mc, String name) {
		Screenshot.grab(mc.gameDirectory, name, mc.gameRenderer.mainRenderTarget(), 1,
			msg -> Cosmetics.LOG.info("Тестовый скриншот: {}", msg.getString()));
	}
}
