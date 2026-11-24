package ru.hytpotchi.cosmetics;

import java.util.function.Consumer;
import net.minecraft.client.CameraType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.screens.AccessibilityOnboardingScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.presets.WorldPresets;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.TickEvent;
import ru.hytpotchi.cosmetics.core.Cosmetics;

/**
 * Для проверки мода: -Dhytpotchi.cosmetics.screenshot=<секунд> — через столько секунд в мире
 * снять игрока спереди и сзади (screenshots/cosmetics_*.png) и закрыть игру.
 * С главного экрана сам создаёт новый мир — для проверки в среде разработки (gradlew runClient).
 */
final class TestShot {
	private TestShot() {}

	static void register() {
		registerViewer();
		String raw = System.getProperty("hytpotchi.cosmetics.screenshot");
		if (raw == null) {
			return;
		}
		int ticks = Integer.parseInt(raw.trim()) * 20;
		int[] inWorld = {0};
		boolean[] created = {false};
		everyTick(mc -> {
			// При первом запуске игра показывает не меню, а экран настроек доступности — его пропускаем
			boolean menu = mc.screen instanceof TitleScreen || mc.screen instanceof AccessibilityOnboardingScreen;
			if (!created[0] && mc.level == null && mc.getOverlay() == null && menu) {
				created[0] = true;
				mc.options.onboardAccessibility = false;
				String name = "cosmetics_test_" + System.currentTimeMillis();
				LevelSettings settings = new LevelSettings(name, GameType.CREATIVE, false, Difficulty.PEACEFUL, true,
					new GameRules(), WorldDataConfiguration.DEFAULT);
				mc.createWorldOpenFlows().createFreshLevel(name, settings, new WorldOptions(42L, false, false),
					WorldPresets::createNormalWorldDimensions);
				return;
			}
			if (mc.player == null || mc.level == null || inWorld[0] < 0) {
				return;
			}
			inWorld[0]++;
			if (inWorld[0] == 20) {
				mc.options.hideGui = true;
				mc.player.setXRot(-15);
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

	/**
	 * -Dhytpotchi.cosmetics.viewshot=<секунд>: через столько секунд в мире снять от первого лица,
	 * без интерфейса — так этот игрок видит других (screenshots/cosmetics_view.png). Для проверки
	 * косметики чужих игроков: тест лаунчера ставит двух игроков на сервере друг напротив друга.
	 */
	private static void registerViewer() {
		String raw = System.getProperty("hytpotchi.cosmetics.viewshot");
		if (raw == null) {
			return;
		}
		final int at = Integer.parseInt(raw.trim()) * 20;
		final int[] t = {0};
		everyTick(mc -> {
			if (mc.player == null || mc.level == null || t[0] < 0) {
				return;
			}
			t[0]++;
			if (t[0] == at - 10) {
				mc.options.hideGui = true;
			}
			if (t[0] == at) {
				shot(mc, "cosmetics_view.png");
				t[0] = -1;
			}
		});
	}

	/** Каждый тик клиента (в конце) — как ClientTickEvents.END_CLIENT_TICK у Fabric */
	private static void everyTick(Consumer<Minecraft> body) {
		MinecraftForge.EVENT_BUS.addListener((TickEvent.ClientTickEvent e) -> {
			if (e.phase == TickEvent.Phase.END) {
				body.accept(Minecraft.getInstance());
			}
		});
	}

	private static void shot(Minecraft mc, String name) {
		Screenshot.grab(mc.gameDirectory, name, mc.getMainRenderTarget(), msg -> Cosmetics.log("Тестовый скриншот: " + msg.getString()));
	}
}
