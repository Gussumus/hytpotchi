// Friends commands

use tauri::command;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Friend {
    pub id: String,
    pub uuid: String,
    pub username: String,
    pub display_name: Option<String>,
    pub status: String, // "online", "offline", "in_game", "busy"
    pub game_info: Option<GameInfo>,
    pub added_at: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GameInfo {
    pub server: Option<String>,
    pub version: Option<String>,
    pub instance_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Presence {
    pub uuid: String,
    pub status: String,
    pub game_info: Option<GameInfo>,
}

#[command]
pub async fn friend_list() -> Result<Vec<Friend>, String> {
    Ok(vec![])
}

#[command]
pub async fn friend_add( _username: String) -> Result<Friend, String> {
    Err("Friend add not implemented - requires backend".to_string())
}

#[command]
pub async fn friend_remove( _friend_id: String) -> Result<(), String> {
    Ok(())
}

#[command]
pub async fn friend_accept( _request_id: String) -> Result<Friend, String> {
    Err("Not implemented".to_string())
}

#[command]
pub async fn friend_block( _friend_id: String) -> Result<(), String> {
    Ok(())
}

#[command]
pub async fn presence_list() -> Result<Vec<Presence>, String> {
    Ok(vec![])
}