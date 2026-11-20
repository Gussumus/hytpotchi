# Сервер скинов Hytpotchi

Общий сервер, через который игроки Hytpotchi видят офлайн-скины друг друга.
Это Cloudflare Worker с хранилищем KV. Бесплатного тарифа хватает на тысячи игроков:
до 100 000 запросов скинов в день.

## Как это работает

- Игрок нажимает «Надеть» на офлайн-аккаунте, и лаунчер загружает PNG сюда (`PUT /api/skins/<ник>`).
- Ник закрепляется за первым, кто загрузил на него скин. Лаунчер хранит секретный ключ в зашифрованном
  хранилище, а сервер хранит только его SHA-256.
- При запуске сборки лаунчер настраивает CustomSkinLoader: источник `CustomSkinAPI` с адресом этого
  сервера. Мод сам запрашивает `/<ник>.json` и `/textures/<hash>`.

## Развёртывание (один раз)

Нужен бесплатный аккаунт Cloudflare. Подробная инструкция для новичков — [docs/02-skins-server.md](../../docs/02-skins-server.md).

```bash
cd server/skins
npx wrangler login
npx wrangler kv namespace create SKINS
```

Вставьте выданный `id` в `wrangler.toml`, затем:

```bash
npx wrangler deploy
```

Wrangler покажет адрес вида `https://hytpotchi-skins.<ваш-поддомен>.workers.dev`.
Укажите его в лаунчере: «Настройки» → «Общие скины». Чтобы адрес был у всех игроков из коробки,
задайте его при сборке лаунчера:

```bash
set HYTPOTCHI_SKIN_SERVER=https://hytpotchi-skins.example.workers.dev
npm run tauri build
```

## Проверка

```bash
curl https://hytpotchi-skins.example.workers.dev/
```

Ответ: `{"service":"hytpotchi-skins","ok":true}`.

## Тесты

Тесты запускаются локально, без Cloudflare и без установки пакетов (Node 22.6+):

```bash
node --experimental-strip-types server/skins/test/worker.test.mjs
```
