// Voice/Video call commands

use tauri::command;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Call {
    pub id: String,
    pub call_type: String, // "voice", "video"
    pub participants: Vec<CallParticipant>,
    pub status: String, // "ringing", "active", "ended"
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CallParticipant {
    pub uuid: String,
    pub username: String,
    pub muted: bool,
    pub deafened: bool,
    pub video_enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CallInvite {
    pub id: String,
    pub caller: CallParticipant,
    pub callee_uuid: String,
    pub call_type: String,
    pub created_at: String,
}

#[command]
pub async fn call_start(
        _callee_uuid: String,
    _call_type: String, // "voice" or "video"
) -> Result<Call, String> {
    Err("Voice calls not implemented - requires WebRTC backend".to_string())
}

#[command]
pub async fn call_join(_call_id: String) -> Result<Call, String> {
    Err("Not implemented".to_string())
}

#[command]
pub async fn call_leave(_call_id: String) -> Result<(), String> {
    Ok(())
}

#[command]
pub async fn call_invite(
        _callee_uuid: String,
    _call_type: String,
) -> Result<CallInvite, String> {
    Err("Not implemented".to_string())
}