package ru.hytpotchi.cosmetics;

import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.CameraType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.core.Registry;
import net.minecraft.core.RegistryAccess;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.DataPackConfig;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.levelgen.WorldGenSettings;
import ru.hytpotchi.cosmetics.core.Cosmetics;

/**
 * Для проверки мода: -Dhytpotchi.cosmetics.screenshot=<секунд> — через столько секунд в мире
 * снять игрока спереди и сзади (screenshots/cosmetics_*.png) и закрыть игру.
 * С главного экрана сам создаёт новый мир — для проверки в среде разработки (gradlew runClient).
 */
final class TestShot {
	private TestShot() {}

	static void register() {
		String raw = System.getProperty("hytpotchi.cosmetics.screenshot");
		if (raw == null) {
			return;
		}
		final int ticks = Integer.parseInt(raw.trim()) * 20;
		final int[] inWorld = {0};
		final boolean[] created = {false};
		ClientTickEvents.END_CLIENT_TICK.register(mc -> {
			if (!created[0] && mc.level == null && mc.getOverlay() == null && mc.screen instanceof TitleScreen) {
				created[0] = true;
				String name = "cosmetics_test_" + System.currentTimeMillis();
				LevelSettings settings = new LevelSettings(name, GameType.CREATIVE, false, Difficulty.PEACEFUL, true,
					new GameRules(), DataPackConfig.DEFAULT);
				RegistryAccess.RegistryHolder registries = RegistryAccess.builtin();
				WorldGenSettings gen = WorldGenSettings.makeDefault(registries.dimensionTypes(),
					registries.registryOrThrow(Registry.BIOME_REGISTRY),
					registries.registryOrThrow(Registry.NOISE_GENERATOR_SETTINGS_REGISTRY));
				mc.createLevel(name, settings, registries, gen);
				return;
			}
			if (mc.player == null || mc.level == null || inWorld[0] < 0) {
				return;
			}
			inWorld[0]++;
			if (inWorld[0] == 20) {
				mc.options.hideGui = true;
				mc.player.xRot = -15;
				mc.options.setCameraType(CameraType.THIRD_PERSON_FRONT);
			}
			if (inWorld[0] == ticks) {
				shot(mc, "cosmetics_front.png");
				mc.options.setCameraType(CameraType.THIRD_PERSON_BACK);
			}
			if (inWorld[0] == ticks + 40) {
				shot(mc, "cosmetics_back.png");
				inWorld[0] = -1;
				mc.stop();
			}
		});
	}

	private static void shot(Minecraft mc, String name) {
		Screenshot.grab(mc.gameDirectory, name, mc.getWindow().getWidth(), mc.getWindow().getHeight(),
			mc.getMainRenderTarget(), msg -> Cosmetics.log("Тестовый скриншот: " + msg.getString()));
	}
}
