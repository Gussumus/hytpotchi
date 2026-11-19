//! Вход через Microsoft (device code flow) → Xbox Live → XSTS → Minecraft

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::engine::core::http::HttpClient;

const SCOPE: &str = "XboxLive.signin offline_access";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

/// Client ID приложения Azure: из переменной окружения при запуске или при сборке
pub fn client_id() -> Result<String> {
    for var in ["HYTPOTCHI_MS_CLIENT_ID", "MICROSOFT_CLIENT_ID"] {
        if let Ok(v) = std::env::var(var) {
            if !v.trim().is_empty() {
                return Ok(v.trim().to_string());
            }
        }
    }
    if let Some(v) = option_env!("HYTPOTCHI_MS_CLIENT_ID") {
        if !v.is_empty() {
            return Ok(v.to_string());
        }
    }
    bail!(
        "Вход через Microsoft не настроен: зарегистрируйте приложение в Azure и задайте HYTPOTCHI_MS_CLIENT_ID"
    )
}

#[derive(Debug, Deserialize)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    #[serde(default = "default_interval")]
    pub interval: u64,
    #[serde(default)]
    pub message: Option<String>,
}

fn default_interval() -> u64 {
    5
}

#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    pub expires_in: u64,
}

#[derive(Deserialize)]
struct XboxResponse {
    #[serde(rename = "Token")]
    token: String,
    #[serde(rename = "DisplayClaims")]
    display_claims: XboxClaims,
}

#[derive(Deserialize)]
struct XboxClaims {
    xui: Vec<XboxUser>,
}

#[derive(Deserialize)]
struct XboxUser {
    uhs: String,
}

#[derive(Deserialize)]
pub struct McTokenResponse {
    pub access_token: String,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct McProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub skins: Vec<SkinInfo>,
    #[serde(default)]
    pub capes: Vec<CapeInfo>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SkinInfo {
    pub id: String,
    pub state: String,
    pub url: String,
    #[serde(default)]
    pub variant: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CapeInfo {
    pub id: String,
    pub state: String,
    pub url: String,
}

/// Результат полного входа в Minecraft
pub struct MinecraftLogin {
    pub ms_refresh_token: String,
    pub mc_access_token: String,
    pub mc_expires_in: u64,
    pub profile: McProfile,
}

pub struct MicrosoftAuth {
    http: HttpClient,
    client_id: String,
}

impl MicrosoftAuth {
    pub fn new(http: HttpClient) -> Result<Self> {
        Ok(Self { http, client_id: client_id()? })
    }

    pub async fn start_device_flow(&self) -> Result<DeviceCodeResponse> {
        let response = self
            .http
            .client
            .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode")
            .form(&[("client_id", self.client_id.as_str()), ("scope", SCOPE)])
            .send()
            .await
            .context("Нет связи с Microsoft")?;
        if !response.status().is_success() {
            bail!("Microsoft отклонил запрос: {}", response.text().await.unwrap_or_default());
        }
        Ok(response.json().await?)
    }

    /// Один опрос: `None`, пока пользователь не подтвердил вход
    pub async fn poll_token(&self, device_code: &str) -> Result<Option<TokenResponse>> {
        let response = self
            .http
            .client
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", self.client_id.as_str()),
                ("device_code", device_code),
            ])
            .send()
            .await
            .context("Нет связи с Microsoft")?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status.is_success() {
            return Ok(Some(serde_json::from_str(&text)?));
        }
        let err: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        match err["error"].as_str().unwrap_or("") {
            "authorization_pending" | "slow_down" => Ok(None),
            "expired_token" => bail!("Код истёк — начните вход заново"),
            "access_denied" | "authorization_declined" => bail!("Вход отменён"),
            _ => bail!("Ошибка входа Microsoft: {text}"),
        }
    }

    pub async fn refresh(&self, refresh_token: &str) -> Result<TokenResponse> {
        let response = self
            .http
            .client
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", self.client_id.as_str()),
                ("refresh_token", refresh_token),
                ("scope", SCOPE),
            ])
            .send()
            .await
            .context("Нет связи с Microsoft")?;
        if !response.status().is_success() {
            bail!("Сессия Microsoft истекла — войдите снова");
        }
        Ok(response.json().await?)
    }

    async fn xbox_live(&self, ms_token: &str) -> Result<(String, String)> {
        let body = serde_json::json!({
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": format!("d={ms_token}")
            },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        });
        let response = self
            .http
            .client
            .post("https://user.auth.xboxlive.com/user/authenticate")
            .json(&body)
            .send()
            .await?;
        if !response.status().is_success() {
            bail!("Xbox Live: {}", response.text().await.unwrap_or_default());
        }
        let xbl: XboxResponse = response.json().await?;
        let uhs = xbl
            .display_claims
            .xui
            .first()
            .map(|u| u.uhs.clone())
            .context("Xbox Live не вернул UHS")?;
        Ok((xbl.token, uhs))
    }

    async fn xsts(&self, xbl_token: &str) -> Result<String> {
        let body = serde_json::json!({
            "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl_token] },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        });
        let response = self
            .http
            .client
            .post("https://xsts.auth.xboxlive.com/xsts/authorize")
            .json(&body)
            .send()
            .await?;
        if response.status() == 401 {
            let err: serde_json::Value = response.json().await.unwrap_or_default();
            let code = err["XErr"].as_u64().unwrap_or(0);
            bail!(match code {
                2148916233 => "У этого аккаунта Microsoft нет профиля Xbox — создайте его на xbox.com",
                2148916235 => "Xbox Live недоступен в вашей стране",
                2148916236 | 2148916237 => "Аккаунту нужна верификация возраста на xbox.com",
                2148916238 => "Детский аккаунт: добавьте его в семью Microsoft",
                _ => "Xbox отклонил вход",
            });
        }
        if !response.status().is_success() {
            bail!("XSTS: {}", response.text().await.unwrap_or_default());
        }
        let xsts: XboxResponse = response.json().await?;
        Ok(xsts.token)
    }

    async fn minecraft_token(&self, xsts: &str, uhs: &str) -> Result<McTokenResponse> {
        let response = self
            .http
            .client
            .post("https://api.minecraftservices.com/authentication/login_with_xbox")
            .json(&serde_json::json!({ "identityToken": format!("XBL3.0 x={uhs};{xsts}") }))
            .send()
            .await?;
        if response.status() == 403 {
            bail!("Minecraft отклонил вход: Client ID ещё не одобрен Mojang для доступа к API");
        }
        if !response.status().is_success() {
            bail!("Minecraft: {}", response.text().await.unwrap_or_default());
        }
        Ok(response.json().await?)
    }

    pub async fn profile(&self, mc_token: &str) -> Result<McProfile> {
        let response = self
            .http
            .client
            .get("https://api.minecraftservices.com/minecraft/profile")
            .bearer_auth(mc_token)
            .send()
            .await?;
        if response.status() == 404 {
            bail!("На этом аккаунте не куплен Minecraft: Java Edition");
        }
        if !response.status().is_success() {
            bail!("Профиль Minecraft: {}", response.text().await.unwrap_or_default());
        }
        Ok(response.json().await?)
    }

    /// Полная цепочка от токена Microsoft до профиля Minecraft
    pub async fn login(&self, ms: TokenResponse, previous_refresh: Option<&str>) -> Result<MinecraftLogin> {
        let (xbl, uhs) = self.xbox_live(&ms.access_token).await?;
        let xsts = self.xsts(&xbl).await?;
        let mc = self.minecraft_token(&xsts, &uhs).await?;
        let profile = self.profile(&mc.access_token).await?;
        let ms_refresh_token = ms
            .refresh_token
            .or_else(|| previous_refresh.map(str::to_string))
            .context("Microsoft не выдал refresh-токен")?;
        Ok(MinecraftLogin {
            ms_refresh_token,
            mc_access_token: mc.access_token,
            mc_expires_in: mc.expires_in,
            profile,
        })
    }
}
