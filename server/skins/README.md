# Сервер Hytpotchi: аккаунты, скины, друзья, туннель

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

Ответ: `{"service":"hytpotchi-skins","ok":true,"friends":true,"accounts":true,"tunnel":true}`.

## Аккаунты и друзья

`POST /api/account/*` и `POST /api/friends/*` обслуживает Durable Object `FriendsHub`
([src/hub.ts](src/hub.ts)). Один экземпляр на весь сервер, хранилище SQLite (бесплатный тариф).

- Аккаунт — ник + пароль. Ник уникален без учёта регистра. Пароль хранится как PBKDF2-SHA256
  (100 000 итераций, соль), токены сеансов и код восстановления — только как SHA-256.
  После 5 неверных паролей вход по нику блокируется на 5 минут.
- Скин для ника (`PUT /api/skins/<ник>`) принимается только с токеном владельца этого ника.
  При регистрации ника старый скин под ним (от прежних офлайн-игроков) удаляется.
- Друзья добавляются по нику. `sync` раз в ~45 с: лаунчер сообщает, во что играет и открыт ли
  мир, а получает друзей, заявки и приглашения. `lastSeen` пишется не чаще раза в 2 минуты.
- Сборка хозяина: `pack` кладёт опись модов (имя, SHA-1, размер, ссылка на CDN Modrinth, до 1 МБ),
  `pack/get` отдаёт её только друзьям. Лаунчер гостя качает файлы только с `cdn.modrinth.com`
  и проверяет SHA-1.

## Туннель

Durable Object `TunnelRelay` ([src/tunnel.ts](src/tunnel.ts)) — по одному на открытый мир.
Лаунчер хозяина держит WebSocket `control`; гость подключается к `join` с билетом от хаба
(`/api/friends/join`, только для друзей, билет живёт 5 минут); на каждое соединение игры хозяин
открывает `data`, и байты Minecraft идут насквозь. Секрет хозяина и билеты хранятся хешами.

## Косметика и магазин

Каталог — [src/cosmetics.ts](src/cosmetics.ts) и [src/cosmetics-extra.ts](src/cosmetics-extra.ts)
(модели из кубов), 3D-модели — [src/cosmetics-meshes.ts](src/cosmetics-meshes.ts) и файлы в
`assets/cosmetics/` (их готовит `tools/cosmetics-import`, отдаются как статика — см. `[assets]`
в `wrangler.toml`). У предмета есть цена: `0` — бесплатно, иначе он продаётся навсегда на аккаунт.
Надеть можно только бесплатное или купленное — сервер сам снимает остальное.

Оплата — ЮKassa ([src/shop.ts](src/shop.ts)). Подключение:

1. Зарегистрируйте магазин в ЮKassa (для самозанятых и ИП). В разделе «Интеграция → Ключи API»
   возьмите `shopId` и секретный ключ (для проверки — тестовый магазин, деньги не списываются).
2. Положите их в секреты Worker'а (в репозиторий — никогда):
   ```bash
   npx wrangler secret put YOOKASSA_SHOP_ID
   npx wrangler secret put YOOKASSA_SECRET_KEY
   ```
3. В ЮKassa, «Интеграция → HTTP-уведомления»: адрес `https://<ваш сервер>/api/shop/yookassa`,
   события `payment.succeeded` и `payment.canceled`.
4. `npx wrangler deploy`. В лаунчере кнопка «Купить» заработает сама (каталог сообщает `shop: true`).

Уведомлениям сервер не верит: по id платежа сам спрашивает ЮKassa и выдаёт предмет, только если
платёж оплачен, сумма равна цене, а ник и предмет — те, что он сам записал при создании. Если
уведомление потерялось, лаунчер, ожидая оплату, спрашивает `/api/shop/payment/<id>`, и сервер
перепроверяет платёж тем же способом. Чеки: самозанятым ЮKassa отправляет доходы в «Мой налог»
сама; если у вас онлайн-касса по 54-ФЗ, в запрос платежа нужно добавить `receipt` (сейчас не
отправляется).

## Тесты

Тесты запускаются локально, без Cloudflare и без установки пакетов (Node 22.6+):

```bash
node --experimental-strip-types server/skins/test/worker.test.mjs
node --experimental-strip-types server/skins/test/hub.test.mjs
node --experimental-strip-types server/skins/test/tunnel.test.mjs
node --experimental-strip-types server/skins/test/cosmetics.test.mjs
node --experimental-strip-types server/skins/test/shop.test.mjs
```
