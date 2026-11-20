//! Связка аккаунтов и хранилища токенов: получить готовую сессию для запуска

use std::sync::Arc;

use anyhow::{Context, Result, bail};

use crate::engine::accounts::microsoft::MicrosoftAuth;
use crate::engine::accounts::session::{Account, AccountKind, AccountStore};
use crate::engine::core::http::HttpClient;
use crate::engine::game::pipeline::plan::GameAccount;
use crate::secrets::{AccountId, SecretsVault, TokenBundle};

pub type TokenVault = Arc<SecretsVault>;

/// Сохранить результат входа Microsoft
pub async fn store_login(
    vault: &SecretsVault,
    account_id: &str,
    login: &crate::engine::accounts::microsoft::MinecraftLogin,
) -> Result<()> {
    vault
        .store_token(
            &AccountId(account_id.to_string()),
            TokenBundle {
                ms_refresh_token: login.ms_refresh_token.clone(),
                mc_access_token: login.mc_access_token.clone(),
                mc_expires_at: chrono::Utc::now().timestamp() + login.mc_expires_in as i64,
            },
        )
        .await
}

/// Сессия для запуска игры; токен Minecraft обновляется, если скоро истечёт
pub async fn game_session(
    http: &HttpClient,
    vault: &SecretsVault,
    store: &AccountStore,
    account: &Account,
) -> Result<GameAccount> {
    if account.kind == AccountKind::Offline {
        bail!(
            "Офлайн-аккаунты больше не поддерживаются. Откройте «Аккаунты» и зарегистрируйте ник {} в Hytpotchi — скин сохранится",
            account.username
        );
    }
    if account.kind == AccountKind::Hytpotchi {
        return Ok(GameAccount {
            uuid: account.uuid.clone(),
            username: account.username.clone(),
            access_token: "0".into(),
            user_type: "legacy".into(),
        });
    }

    let id = AccountId(account.id.clone());
    let bundle = vault
        .get_token(&id)
        .await?
        .context("Нет сохранённого входа — войдите в аккаунт снова")?;

    let token = if bundle.mc_expires_at - chrono::Utc::now().timestamp() > 300 {
        bundle.mc_access_token.clone()
    } else {
        let auth = MicrosoftAuth::new(http.clone())?;
        let ms = auth.refresh(&bundle.ms_refresh_token).await?;
        let login = auth.login(ms, Some(&bundle.ms_refresh_token)).await?;
        store_login(vault, &account.id, &login).await?;
        // Ник мог смениться
        let mut updated = account.clone();
        updated.username = login.profile.name.clone();
        let _ = store.upsert(updated);
        login.mc_access_token
    };

    Ok(GameAccount {
        uuid: account.uuid.clone(),
        username: account.username.clone(),
        access_token: token,
        user_type: "msa".into(),
    })
}
