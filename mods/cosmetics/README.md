# Hytpotchi Cosmetics

Мод для Fabric: рисует на игроках Hytpotchi косметику (шапки, крылья, хвосты…). Лаунчер вшивает
его в себя и ставит в сборки Fabric 26.3 вместе с Fabric API. Адрес сервера мод получает
через `-Dhytpotchi.server=…`.

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

После замены jar пересоберите лаунчер. Под другую версию игры: поменяйте версии в
`gradle.properties` (см. fabricmc.net/develop) и `MOD_MC` в `src-tauri/src/engine/skins/cosmetics.rs`.

## Проверка в игре

`-Dhytpotchi.cosmetics.screenshot=<секунд>`: через столько секунд в мире мод снимает игрока
спереди, сзади и сбоку (`screenshots/cosmetics_*.png`).
