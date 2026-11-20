# Как сделать, чтобы у всех всё работало

Лаунчер уже работает у любого, кто его скачает: офлайн-аккаунты, сборки, моды, модпаки и Java.
Остальные возможности требуют внешних сервисов. Их подключает владелец проекта один раз,
а игрокам ничего настраивать не нужно.

| Что | Сервис | Время | Стоимость |
|---|---|---|---|
| 1. Скачивание и автообновление | GitHub | 10 мин | бесплатно |
| 2. Общие офлайн-скины | Cloudflare Workers | 10 мин | бесплатно |
| 3. Статус в Discord | Discord Developer Portal | 3 мин | бесплатно |
| 4. Вход через Microsoft | Azure + заявка в Mojang | 15 мин + ожидание одобрения | бесплатно |

Все значения из шагов 2–4 вставляются в GitHub (шаг 1), и каждый следующий релиз собирается с ними сам.

---

## 1. GitHub: релизы и автообновление

1. Создайте репозиторий на https://github.com/new, например `hytpotchi`. Он может быть публичным
   (по GPL-3.0 исходники и так открыты) или приватным — тогда установщики тоже будут приватными.
   Для раздачи всем нужен **публичный**.
2. Отправьте код:
   ```bash
   git remote add origin https://github.com/<ваш-логин>/hytpotchi.git
   git branch -M main
   git push -u origin main
   ```
3. Добавьте **Settings → Secrets and variables → Actions → Secrets**:
   - `TAURI_SIGNING_PRIVATE_KEY` — содержимое файла `C:\Users\<вы>\.tauri\hytpotchi.key`
     (откройте его в Блокноте и скопируйте целиком). **Никому не передавайте этот ключ**:
     им подписываются обновления. Если его потерять, установленные лаунчеры перестанут принимать обновления.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — оставьте пустым (ключ создан без пароля) или не создавайте.
4. Выпустите релиз:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
   Через ~15 минут во вкладке **Releases** появится `Hytpotchi_0.2.0_x64-setup.exe`. Ссылку на эту страницу
   можно давать игрокам. Следующие версии (`v0.2.1`…) установленные лаунчеры подтянут сами:
   при запуске появится «Доступна новая версия → Обновить».

Публичный ключ (`src-tauri/updater.pub`) уже лежит в репозитории. Приватный хранится только у вас и в секретах GitHub.

## 2. Общие офлайн-скины (Cloudflare)

Подробно: [server/skins/README.md](../server/skins/README.md). Коротко:

```bash
cd server/skins
npx wrangler login
npx wrangler kv namespace create SKINS   # вставьте id в wrangler.toml
npx wrangler deploy
```

Адрес вида `https://hytpotchi-skins.<поддомен>.workers.dev` добавьте в GitHub:
**Settings → Secrets and variables → Actions → Variables** → `HYTPOTCHI_SKIN_SERVER`.

## 3. Статус в Discord

1. https://discord.com/developers/applications → **New Application** → имя **Hytpotchi**
   (оно и будет видно в статусе «Играет в Hytpotchi»).
2. **Rich Presence → Art Assets** → загрузите `src-tauri/icons/icon.png` с ключом `logo`.
3. Скопируйте **Application ID** со страницы General Information и добавьте его как переменную `HYTPOTCHI_DISCORD_ID`.

## 4. Вход через Microsoft

1. https://portal.azure.com → **App registrations → New registration**:
   - Supported account types: **Personal Microsoft accounts only**;
   - Redirect URI можно не указывать.
2. В приложении: **Authentication → Allow public client flows → Yes** → Save.
3. Скопируйте **Application (client) ID**.
4. Новые приложения Mojang по умолчанию не пускает в Minecraft API — подайте заявку:
   https://aka.ms/mce-reviewappid (укажите client ID и коротко опишите лаунчер). Одобрение обычно
   занимает от нескольких дней до пары недель; до этого вход будет падать с ошибкой 403.
5. После одобрения добавьте переменную `HYTPOTCHI_MS_CLIENT_ID` и выпустите новый релиз.

---

## Проверка

В лаунчере: **Настройки → О программе**. Там видно, какие сервисы подключены в этой сборке
(Обновления, Вход через Microsoft, Общие скины, Статус в Discord).

## Подпись установщика (необязательно)

Без сертификата Windows показывает «Система Windows защитила ваш компьютер». Убрать это можно только платным
сертификатом подписи кода (OV/EV) или бесплатно через [SignPath Foundation](https://signpath.org) для open-source проектов.
