# Hytpotchi

Лаунчер Minecraft на Tauri 2 + React 19 + Rust.

- **Сборки**: Vanilla, Fabric, Quilt. Любая версия от 1.0 до последних снапшотов.
- **Java ставится сама**: лаунчер читает из манифеста версии, какая Java ей нужна
  (8 / 17 / 21 / …), и скачивает Eclipse Temurin с проверкой SHA-256. Каждая Java
  скачивается один раз и используется всеми сборками.
- **Моды с Modrinth**: подбирается версия под сборку, обязательные зависимости ставятся автоматически.
- **Аккаунты**: Microsoft (device code) и офлайн. Токены шифруются AES-256-GCM, ключ защищён DPAPI.
- Общие версии, библиотеки и ресурсы для всех сборок, параллельная загрузка с проверкой хешей.

## Запуск

```bash
npm install
npm run tauri dev
```

Релизная сборка (NSIS-установщик):

```bash
npm run tauri build
```

Только интерфейс в браузере (демо-данные, без бэкенда):

```bash
npm run dev
```

## Вход через Microsoft

Нужен свой Client ID из Azure (App registrations → «Personal Microsoft accounts only»,
включить «Allow public client flows»). Затем подать заявку Mojang на доступ к Minecraft API.
ID передаётся через переменную окружения при сборке или запуске:

```bash
set HYTPOTCHI_MS_CLIENT_ID=00000000-0000-0000-0000-000000000000
```

## Где лежат данные

`%APPDATA%\.hytpotchi` (переопределяется `HYTPOTCHI_HOME`):

```
versions/   libraries/   assets/   java/temurin-<N>/   instances/<id>/minecraft/
```

## Лицензия

GPL-3.0. Не связан с Mojang Studios и Microsoft.
