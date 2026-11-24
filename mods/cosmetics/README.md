# Hytpotchi Cosmetics

Мод для Fabric (и Forge 1.20.1): рисует на игроках Hytpotchi косметику (шапки, крылья, хвосты…). Лаунчер вшивает
его в себя и ставит в сборки Fabric вместе с Fabric API. Версии игры: 1.16.5, 1.18.2, 1.19.2,
1.20–1.20.1, 1.21–1.21.1, 1.21.4 и 26.3 — под каждую своя сборка мода. Адрес сервера мод получает
через `-Dhytpotchi.server=…`.

Сборки Quilt тоже получают мод: Quilt запускает моды Fabric. Для Forge 1.20.1 — своя сборка
(`versions/forge-1.20.1`, см. ниже).

Сеть — так, чтобы косметику других игроков было видно и при плохой связи:
- каталог и 3D-модели — только со сжатием (gzip): у части российских провайдеров без VPN
  соединение с Cloudflare обрывается после ~16 КБ, а без сжатия каталог весит 31 КБ;
- системный прокси Windows (его ставят VPN-программы) Java не видит — лаунчер передаёт его моду
  через `-Dhytpotchi.proxy=http://host:port` (или `socks5://`), мод идёт через него, а если не
  вышло — напрямую;
- «что надето у игрока» запрашивается в отдельной очереди (не ждёт скачивания 3D-моделей),
  обновляется раз в минуту, после ошибки — через 15 с; незнакомый предмет (появился в магазине
  после входа в игру) — повод перечитать каталог.

Проверка целиком — тест лаунчера `cosmetics_multiplayer` (`src-tauri/src/engine/skins/cosmetics_live.rs`):
локальный сервер и два клиента, поставленные как в лаунчере; второй снимает первого от первого
лица (`-Dhytpotchi.cosmetics.viewshot=<секунд>`).

Модели не зашиты в мод: мод берёт каталог с сервера (`/api/cosmetics/catalog`, см.
`server/skins/src/cosmetics.ts`) и строит их из кубов. Новый предмет добавляется на сервере
без обновления мода. Что надето у игрока — `/api/cosmetics/<ник>`, выбирается в лаунчере («Скины»).

## Сборка

Нужен JDK 25 (у лаунчера своя Java — только среда выполнения, для сборки не подходит).

```bash
cd mods/cosmetics
./gradlew build
cp build/libs/hytpotchi-cosmetics-*.jar ../../src-tauri/resources/hytpotchi-cosmetics.jar
```

После замены jar пересоберите лаунчер.

## Старые версии игры

Сборки под другие версии — в `versions/<версия>/` (для Forge — `versions/forge-<версия>/`) (свой код рендера в `src/`, общий код — сеть,
каталог, геометрия — в `common/java`, общая настройка — `versions/shared.gradle`):

```bash
cd mods/cosmetics
./gradlew -p versions/1.20.1 build
cp versions/1.20.1/build/libs/hytpotchi-cosmetics-mc1.20.1-*.jar \
   ../../src-tauri/resources/cosmetics/hytpotchi-cosmetics-mc1.20.1.jar
```

Какие версии игры получают какой jar — таблица `BUILDS` в `src-tauri/src/engine/skins/cosmetics.rs`.
Список версий там должен совпадать с `mod_minecraft` в `gradle.properties` версии (иначе Fabric
не запустит игру) — это проверяет тест `embedded_mods_match_their_versions`.

Чем версии отличаются (код рендера — `versions/<версия>/src`):

| Версия | Java | Особенности |
|---|---|---|
| 1.16.5 | 8 | Fabric API называется `fabric` (`fabric_api_id` в gradle.properties), колбэк слоёв — в пакете `rendereregistry`, математика `com.mojang.math` |
| 1.18.2, 1.19.2 | 17 | математика `com.mojang.math` |
| 1.20.1 | 17 | JOML, `vertex(…).endVertex()` |
| 1.21.1 | 21 | `addVertex(…).setNormal(pose, …)`, `ResourceLocation.fromNamespaceAndPath` |
| 1.21.4 | 21 | слой получает `PlayerRenderState` (ник — `state.name`) |
| 26.3 (корень) | 25 | `SubmitNodeCollector`, свой код без `common/` |
| Forge 1.20.1 | 17 | `versions/forge-1.20.1`, Architectury Loom; слой — как у Fabric 1.20.1 |

### Forge 1.20.1

`versions/forge-1.20.1` собирается Architectury Loom (`dev.architectury.loom`, `loom.platform=forge`):
в исходниках имена Mojang, при сборке jar переводится в имена Forge (SRG). Общая настройка —
`versions/forge-shared.gradle`, метаданные — `versions/forge-template` (`META-INF/mods.toml` и
обязательный `pack.mcmeta`: без него Forge на каждом запуске останавливается на экране
«Warning while loading mods»). Слой рендера тот же, что у Fabric 1.20.1; подключение — событие
`EntityRenderersEvent.AddLayers`, тики — `TickEvent.ClientTickEvent`. Fabric API не нужен.
Устаревшие в Forge 47.4 `new ResourceLocation(…)` и `FMLJavaModLoadingContext.get()` оставлены
намеренно: замен нет в 47.0–47.3, а в лаунчере можно выбрать любую сборку Forge 1.20.1.

```bash
./gradlew -p versions/forge-1.20.1 build
cp versions/forge-1.20.1/build/libs/hytpotchi-cosmetics-forge-mc1.20.1-*.jar \
   ../../src-tauri/resources/cosmetics/hytpotchi-cosmetics-forge-mc1.20.1.jar
```

`./gradlew -p versions/<версия> runClient` — проверка в игре: заходит ником gussumus, сам создаёт
мир, снимает игрока спереди и сзади в `versions/<версия>/run/screenshots` и закрывает игру.
Игре нужна Java своей версии (8/17/21); если Gradle её не находит, укажите Java лаунчера:
`-Porg.gradle.java.installations.paths=%APPDATA%/.hytpotchi/java/temurin-8,%APPDATA%/.hytpotchi/java/temurin-17`.

## Проверка в игре

`-Dhytpotchi.cosmetics.screenshot=<секунд>`: через столько секунд в мире мод снимает игрока
спереди, сзади и сбоку (`screenshots/cosmetics_*.png`).
