//! Desktop shell native surface (plan S6.18 seam, tickets #15/#22,
//! issue #94).
//!
//! These commands are the ONLY native surface of the shell: the webview
//! never touches the filesystem directly. Every project/image command
//! takes an OPAGUE HANDLE TOKEN issued by the Rust-side open/save dialogs
//! (or loaded from the Rust-owned recent-project store) and resolved by
//! `native_scope::NativeScope`; no command accepts a raw filesystem path,
//! so a compromised webview cannot read, write, delete, or probe any file
//! the user never chose through a dialog. Handles are scope-bound
//! (project vs image) and canonicalized at issue time; adjacent artifacts
//! (`.bak`, `.journal`, temp files) derive from the canonical path, and
//! operations refuse to follow symbolic links planted at the stored path.
//! See `native_scope` for the full threat model.

mod native_scope;

use native_scope::{
    append_journal_bytes, image_exists, pick_open_project, pick_preview_image_paths,
    pick_save_project, project_exists, read_backup_bytes, read_journal_bytes, read_project_bytes,
    read_recent_projects, record_recent_project, remove_journal, remove_project,
    remove_recent_project, replace_journal_bytes, write_image_bytes_atomic,
    write_project_bytes_atomic, NativeScope,
};
use tauri::Manager;

/// OS-keychain credential commands (plan S12.4, ADR-0010, ticket #34,
/// issue #95): the webview never sees a stored secret except through its
/// own `credential_get` call. The service is pinned to
/// `voxel-maker:provider` (the agent package's `KEYCHAIN_SERVICE`) and the
/// account must be an allowlisted provider id, so IPC can never address a
/// keychain entry outside Voxel Maker's service/provider scope; forged
/// invokes fail before any keyring access. Values are bounded and never
/// logged.
const KEYCHAIN_SERVICE: &str = "voxel-maker:provider";

/// Provider accounts the shell may address in the keychain (v1: OpenAI).
/// Adding a provider requires extending this allowlist in the same change
/// that introduces its adapter.
const ALLOWED_PROVIDER_ACCOUNTS: &[&str] = &["openai"];

fn validate_provider_account(account: &str) -> Result<(), String> {
    if ALLOWED_PROVIDER_ACCOUNTS.contains(&account) {
        Ok(())
    } else {
        Err("credential account is not an allowlisted provider account".to_string())
    }
}

/// Builds the pinned keychain entry for an allowlisted provider account;
/// rejected accounts never reach the keychain.
fn keychain_entry(account: &str) -> Result<keyring::Entry, String> {
    validate_provider_account(account)?;
    keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|error| error.to_string())
}

/// Stores one credential in the OS keychain (replaces any existing value).
#[tauri::command]
fn credential_save(account: String, value: String) -> Result<(), String> {
    if value.is_empty() || value.len() > 16_384 {
        return Err("credential value is empty or exceeds the size limit".to_string());
    }
    let entry = keychain_entry(&account)?;
    entry
        .set_password(&value)
        .map_err(|error| error.to_string())
}

/// Reads one credential from the OS keychain; `None` when absent.
#[tauri::command]
fn credential_get(account: String) -> Result<Option<String>, String> {
    let entry = keychain_entry(&account)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Removes one credential from the OS keychain; a missing entry is not an error.
#[tauri::command]
fn credential_delete(account: String) -> Result<(), String> {
    let entry = keychain_entry(&account)?;
    match entry.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(NativeScope::default())
        .setup(|app| {
            // Point the Rust-owned recent-project store at the app config
            // directory and load persisted tokens so recent projects stay
            // openable across restarts.
            let scope = app.state::<NativeScope>();
            let recent_path = app.path().app_config_dir()?.join("recent-projects.json");
            scope.set_recent_file(recent_path);
            scope.load_recent();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_open_project,
            pick_save_project,
            pick_preview_image_paths,
            read_project_bytes,
            write_project_bytes_atomic,
            project_exists,
            read_backup_bytes,
            remove_project,
            write_image_bytes_atomic,
            image_exists,
            read_journal_bytes,
            append_journal_bytes,
            replace_journal_bytes,
            remove_journal,
            read_recent_projects,
            record_recent_project,
            remove_recent_project,
            credential_save,
            credential_get,
            credential_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running the voxel-maker desktop shell");
}

#[cfg(test)]
mod keychain_tests {
    use super::*;
    use keyring::credential::{
        Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence,
    };
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    /// Serializes keychain-scope tests: `set_default_credential_builder`
    /// swaps a process-global builder, and every test installs its own
    /// in-memory store, so keychain tests must not interleave.
    static KEYCHAIN_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// A keyring builder backed by one shared in-memory map, so entries
    /// created by separate `Entry::new` calls (as the commands do)
    /// round-trip through the same store. This is the deterministic
    /// stand-in for the OS keychain; no test ever touches the real store.
    struct SharedKeychain {
        entries: Arc<Mutex<HashMap<(String, String), String>>>,
    }

    struct SharedKeychainCredential {
        store: Arc<Mutex<HashMap<(String, String), String>>>,
        key: (String, String),
    }

    impl CredentialApi for SharedKeychainCredential {
        fn set_password(&self, password: &str) -> keyring::Result<()> {
            self.store
                .lock()
                .expect("keychain harness poisoned")
                .insert(self.key.clone(), password.to_string());
            Ok(())
        }

        fn get_password(&self) -> keyring::Result<String> {
            match self
                .store
                .lock()
                .expect("keychain harness poisoned")
                .get(&self.key)
            {
                Some(value) => Ok(value.clone()),
                None => Err(keyring::Error::NoEntry),
            }
        }

        fn delete_password(&self) -> keyring::Result<()> {
            if self
                .store
                .lock()
                .expect("keychain harness poisoned")
                .remove(&self.key)
                .is_some()
            {
                Ok(())
            } else {
                Err(keyring::Error::NoEntry)
            }
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    impl CredentialBuilderApi for SharedKeychain {
        fn build(
            &self,
            _target: Option<&str>,
            service: &str,
            account: &str,
        ) -> keyring::Result<Box<Credential>> {
            Ok(Box::new(SharedKeychainCredential {
                store: self.entries.clone(),
                key: (service.to_string(), account.to_string()),
            }))
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }

        fn persistence(&self) -> CredentialPersistence {
            CredentialPersistence::UntilDelete
        }
    }

    /// Installs a fresh in-memory keychain as the keyring default and
    /// returns the store so tests can assert exactly which (service,
    /// account) pairs were addressed.
    fn install_mock_keychain() -> Arc<Mutex<HashMap<(String, String), String>>> {
        let entries = Arc::new(Mutex::new(HashMap::new()));
        keyring::set_default_credential_builder(Box::new(SharedKeychain {
            entries: entries.clone(),
        }));
        entries
    }

    fn store_contains(
        entries: &Mutex<HashMap<(String, String), String>>,
        service: &str,
        account: &str,
    ) -> bool {
        entries
            .lock()
            .expect("keychain harness poisoned")
            .contains_key(&(service.to_string(), account.to_string()))
    }

    fn assert_store_empty(entries: &Mutex<HashMap<(String, String), String>>) {
        assert!(
            entries
                .lock()
                .expect("keychain harness poisoned")
                .is_empty(),
            "the keychain must stay untouched"
        );
    }

    /// Issue #95: forged service/account pairs must fail on every command
    /// and never touch the keychain. Service is not an IPC parameter at
    /// all — Tauri's `CommandArg` deserialization reads only the named
    /// argument keys from the invoke payload (`v.get(key)` in
    /// `tauri::ipc::command`), so a smuggled `service` key is never read
    /// and no code path can pass an attacker-chosen service to
    /// `keyring::Entry::new`. Accounts outside the provider allowlist are
    /// rejected before any keyring access.
    #[test]
    fn forged_account_is_rejected_on_all_commands() {
        let _guard = KEYCHAIN_TEST_LOCK
            .lock()
            .expect("keychain test lock poisoned");
        for account in [
            "com.apple.Safari",
            "other-provider",
            "openai/extra",
            "OPENAI",
            "openai ",
            "*",
            "",
        ] {
            let entries = install_mock_keychain();
            let read = credential_get(account.to_string());
            assert!(
                read.is_err(),
                "forged account {account:?} must be rejected on read: {read:?}"
            );
            let write = credential_save(account.to_string(), "sk-forged".to_string());
            assert!(
                write.is_err(),
                "forged account {account:?} must be rejected on write: {write:?}"
            );
            let delete = credential_delete(account.to_string());
            assert!(
                delete.is_err(),
                "forged account {account:?} must be rejected on delete: {delete:?}"
            );
            assert_store_empty(&entries);
        }
    }

    /// Issue #95: the service is pinned (not an IPC parameter), so every
    /// successful credential addresses exactly `voxel-maker:provider` and
    /// the allowlisted account.
    #[test]
    fn credentials_are_addressed_under_the_pinned_service() {
        let _guard = KEYCHAIN_TEST_LOCK
            .lock()
            .expect("keychain test lock poisoned");
        assert_eq!(KEYCHAIN_SERVICE, "voxel-maker:provider");
        let entries = install_mock_keychain();
        credential_save("openai".to_string(), "sk-test".to_string()).unwrap();
        let locked = entries.lock().expect("keychain harness poisoned");
        assert_eq!(locked.len(), 1);
        assert!(locked.contains_key(&("voxel-maker:provider".to_string(), "openai".to_string())));
        drop(locked);
        assert!(store_contains(&entries, KEYCHAIN_SERVICE, "openai"));
        assert!(!store_contains(&entries, "com.apple.Safari", "openai"));
    }

    /// Acceptance criteria: the OpenAI credential workflow round-trips
    /// through the pinned service, including missing-entry semantics.
    #[test]
    fn openai_credential_round_trips() {
        let _guard = KEYCHAIN_TEST_LOCK
            .lock()
            .expect("keychain test lock poisoned");
        let entries = install_mock_keychain();
        assert_eq!(credential_get("openai".to_string()).unwrap(), None);
        credential_save("openai".to_string(), "sk-test".to_string()).unwrap();
        assert_eq!(
            credential_get("openai".to_string()).unwrap().as_deref(),
            Some("sk-test")
        );
        assert!(store_contains(&entries, KEYCHAIN_SERVICE, "openai"));
        credential_delete("openai".to_string()).unwrap();
        assert_eq!(credential_get("openai".to_string()).unwrap(), None);
        credential_delete("openai".to_string()).unwrap();
        assert_store_empty(&entries);
    }

    /// Credential values stay bounded; oversized or empty values are
    /// rejected before the keychain is touched.
    #[test]
    fn value_size_is_validated() {
        let _guard = KEYCHAIN_TEST_LOCK
            .lock()
            .expect("keychain test lock poisoned");
        let entries = install_mock_keychain();
        assert!(credential_save("openai".to_string(), String::new()).is_err());
        assert!(credential_save("openai".to_string(), "x".repeat(16_385)).is_err());
        assert_store_empty(&entries);
    }
}
