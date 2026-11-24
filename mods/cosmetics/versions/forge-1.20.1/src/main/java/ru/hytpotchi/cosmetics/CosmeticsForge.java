package ru.hytpotchi.cosmetics;

import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;
import net.minecraftforge.fml.loading.FMLEnvironment;

/** Точка входа Forge. Мод только для клиента: на сервере ничего не делает */
@Mod("hytpotchi_cosmetics")
public final class CosmeticsForge {
	// FMLJavaModLoadingContext.get() устарел в Forge 47.4, но замены нет в 47.0–47.3 — а в лаунчере
	// можно выбрать любую сборку Forge 1.20.1
	@SuppressWarnings("removal")
	public CosmeticsForge() {
		if (FMLEnvironment.dist == Dist.CLIENT) {
			CosmeticsClient.init(FMLJavaModLoadingContext.get().getModEventBus());
		}
	}
}
