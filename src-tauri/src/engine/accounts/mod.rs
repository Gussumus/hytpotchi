//! Аккаунты: Microsoft и офлайн

pub mod microsoft;
pub mod millida;
pub mod session;
pub mod vault;

pub use microsoft::{McProfile, MicrosoftAuth};
pub use session::{Account, AccountKind, AccountStore};
pub use vault::TokenVault;
