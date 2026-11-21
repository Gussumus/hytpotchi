# Релей Hytpotchi в России

Нужен, чтобы друзья могли играть вместе **без VPN**.

## Зачем

Туннель «Присоединиться» по умолчанию идёт через сервер Hytpotchi на Cloudflare. У части
российских провайдеров долгие соединения к Cloudflare без VPN «замерзают»: проходит несколько
килобайт, потом тишина и обрыв. Список друзей это не ломает, а игру ломает.

Поэтому лаунчер гостя пробует пути по очереди:

1. **Напрямую к хозяину.** Лаунчер хозяина сам пробрасывает порт на роутере (UPnP). Работает,
   если у хозяина «белый» IP и на роутере включён UPnP.
2. **Через этот релей** — маленький сервер на VPS в России. Трафик не уходит за границу.
3. **Через Cloudflare**, как раньше.

Сервер на Cloudflare по-прежнему отвечает за аккаунты, друзей и скины. Релей ничего не хранит:
хаб выдаёт подписанные пропуска, релей проверяет их общим ключом.

## Что нужно

- VPS в России с Linux (подойдёт самый дешёвый: 1 ядро, 512 МБ памяти).
- Открытый TCP-порт, например 8443.
- Желательно домен, тогда можно включить TLS (`wss://`). Без домена тоже работает (`ws://`),
  но пропуски идут открытым текстом.

## Установка

```bash
# 1. Bun (один файл, без зависимостей)
curl -fsSL https://bun.sh/install | bash

# 2. Код релея: нужны папки server/relay и server/skins/src
git clone https://github.com/<вы>/<репозиторий>.git /opt/hytpotchi

# 3. Ключ подписи: случайная строка, та же будет у воркера
openssl rand -hex 32
```

Служба systemd (`/etc/systemd/system/hytpotchi-relay.service`):

```ini
[Unit]
Description=Hytpotchi relay
After=network-online.target

[Service]
Environment=RELAY_KEY=<ключ из openssl>
Environment=PORT=8443
# Для wss:// (сертификат, например, от certbot):
# Environment=TLS_CERT=/etc/letsencrypt/live/relay.example.ru/fullchain.pem
# Environment=TLS_KEY=/etc/letsencrypt/live/relay.example.ru/privkey.pem
ExecStart=/root/.bun/bin/bun run /opt/hytpotchi/server/relay/relay.ts
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now hytpotchi-relay
curl http://<IP VPS>:8443/        # {"service":"hytpotchi-relay","ok":true,...}
```

## Подключить к серверу Hytpotchi

В `server/skins/wrangler.toml` раскомментируйте `[vars]` и укажите адрес релея:

```toml
[vars]
RELAY_URL = "ws://<IP VPS>:8443"      # или "wss://relay.example.ru:8443" с TLS
```

Ключ задаётся секретом, в файл его не пишите:

```bash
cd server/skins
npx wrangler secret put RELAY_KEY     # вставьте тот же ключ, что на VPS
npx wrangler deploy
```

Лаунчеры подхватят релей сами при следующей синхронизации друзей. Обновлять лаунчер не нужно,
если у игроков уже версия с поддержкой релея.

## Проверка

```bash
node --experimental-strip-types server/relay/test/relay.test.mjs
```

В логе лаунчера гостя видно, каким путём он зашёл: «в мир друга напрямую», «через релей Hytpotchi»
или без пометки (через Cloudflare). У хозяина отдельно видно, получился ли проброс:
«Прямой вход: мир доступен из интернета по …» или «Прямой вход недоступен: …».
