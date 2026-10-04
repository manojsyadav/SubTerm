// Vault crypto primitives: Argon2id key derivation, AES-256-GCM encrypt/decrypt,
// on-disk blob framing, and the zstd compress/decompress wrapping used around
// the encrypted SQLite serialisation. Extracted out of `lib.rs` (which still
// owns `DbState` and calls these via `save_vault_internal`) so the crypto
// surface is isolated and auditable in one place.

use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use zeroize::Zeroizing;
use rand::Rng;
use rusqlite::{ffi, Connection, DatabaseName};
use rusqlite::serialize::OwnedData;
use std::ptr::NonNull;
use std::fs;

use crate::DbState;

// On-disk vault layout:
//   bytes 0..3   magic ("OMNV")
//   byte  4      version (1)
//   bytes 5..20  salt (16 bytes, per-profile)
//   bytes 21..32 nonce (12 bytes, per-save)
//   rest         AES-256-GCM(zstd(serialised-sqlite)) + 16-byte tag
pub(crate) const VAULT_MAGIC: &[u8; 4] = b"OMNV";
pub(crate) const VAULT_VERSION: u8 = 1;
/// zstd compression level. 3 is the library default — fast enough that
/// save latency is dominated by sqlite serialisation, with compression
/// ratios within a couple percent of the slower levels for SQL-like data.
pub(crate) const VAULT_COMPRESS_LEVEL: i32 = 3;
pub(crate) const SALT_LEN: usize = 16;
pub(crate) const NONCE_LEN: usize = 12;
pub(crate) const HEADER_LEN: usize = 4 + 1 + SALT_LEN;

// Argon2id parameters for vault-key derivation:
//   m_cost   64 MiB  — memory hardness; raises cost of GPU/ASIC attacks
//   t_cost   3       — passes over the buffer
//   p_cost   4       — parallelism; up to 4 lanes if available
//   output   32 B    — AES-256-GCM key length
// Tuned higher than OWASP's interactive-login defaults because this protects
// the entire profile vault, not a single-request login. Changing these
// values invalidates every existing vault — bump only on a deliberate
// re-keying migration.
const ARGON2_M_COST: u32 = 64 * 1024;
const ARGON2_T_COST: u32 = 3;
const ARGON2_P_COST: u32 = 4;

pub(crate) fn derive_key(password: &str, salt_bytes: &[u8]) -> Result<[u8; 32], String> {
    let params = Params::new(ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST, Some(32))
        .map_err(|e| format!("[CRYPTO] ARGON2_PARAMS: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    // Raw API: write derived bytes directly into the key buffer. Avoids
    // the PHC-string round-trip (encode then truncate b64) the previous
    // implementation used, which was fragile and made parameter changes
    // invisible to type-checking.
    argon2
        .hash_password_into(password.as_bytes(), salt_bytes, &mut key)
        .map_err(|e| format!("[CRYPTO] HASH_FAILED: {}", e))?;
    Ok(key)
}

pub(crate) fn encrypt_with_key(plaintext: &[u8], key: &[u8; 32]) -> Result<(Vec<u8>, [u8; NONCE_LEN]), String> {
    let cipher = Aes256Gcm::new(key.into());
    let nonce_bytes: [u8; NONCE_LEN] = rand::thread_rng().gen();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, plaintext)
        .map_err(|e| format!("[CRYPTO] ENCRYPT_FAILED: {}", e))?;
    Ok((ciphertext, nonce_bytes))
}

pub(crate) fn decrypt_with_key(ciphertext: &[u8], nonce_bytes: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if nonce_bytes.len() != NONCE_LEN {
        return Err("[CRYPTO] NONCE_LEN_INVALID".into());
    }
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher.decrypt(nonce, ciphertext)
        .map_err(|e| format!("[CRYPTO] DECRYPT_FAILURE: Possible wrong key or corrupted data. Details: {}", e))
}

/// Returns (salt, nonce, ciphertext) parsed out of an on-disk vault blob.
pub(crate) fn parse_vault_blob(data: &[u8]) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>), String> {
    if data.len() < HEADER_LEN + NONCE_LEN {
        return Err("[VAULT] INVALID_FORMAT: Data too short".into());
    }
    if &data[..4] != VAULT_MAGIC {
        return Err("[VAULT] BAD_MAGIC".into());
    }
    if data[4] != VAULT_VERSION {
        return Err(format!("[VAULT] UNSUPPORTED_VERSION: {}", data[4]));
    }
    let salt = data[5..5 + SALT_LEN].to_vec();
    let nonce = data[HEADER_LEN..HEADER_LEN + NONCE_LEN].to_vec();
    let ct = data[HEADER_LEN + NONCE_LEN..].to_vec();
    Ok((salt, nonce, ct))
}

/// Copies `data` into a sqlite-allocated buffer wrapped in `OwnedData`.
/// `Connection::deserialize` requires a buffer allocated by `sqlite3_malloc`
/// because it frees it via `SQLITE_DESERIALIZE_FREEONCLOSE`.
pub(crate) fn to_sqlite_owned(data: &[u8]) -> Result<OwnedData, String> {
    let sz = data.len();
    let raw = unsafe { ffi::sqlite3_malloc64(sz as u64) } as *mut u8;
    let ptr = NonNull::new(raw).ok_or("[DATABASE] SQLITE_MALLOC_FAILED")?;
    unsafe {
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr.as_ptr(), sz);
        Ok(OwnedData::from_raw_nonnull(ptr, sz))
    }
}

pub(crate) fn write_vault_blob(salt: &[u8; SALT_LEN], nonce: &[u8; NONCE_LEN], ciphertext: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(VAULT_MAGIC);
    out.push(VAULT_VERSION);
    out.extend_from_slice(salt);
    out.extend_from_slice(nonce);
    out.extend_from_slice(ciphertext);
    out
}

/// Compress the plaintext SQLite serialisation for vault v2 writes.
/// Errors here are surfaced as crypto-domain errors because the caller's
/// invariant ("save the DB") is what's broken, not just I/O.
pub(crate) fn vault_compress(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    zstd::stream::encode_all(plaintext, VAULT_COMPRESS_LEVEL)
        .map_err(|e| format!("[VAULT] COMPRESS_FAILED: {}", e))
}

/// Decompress the post-decrypt body for vault v2 reads. Bounded by a
/// generous max-size guard so a corrupt or hostile file can't make us
/// allocate gigabytes — a real Submarine SQLite snapshot is well under
/// 64 MiB even with thousands of nodes.
pub(crate) fn vault_decompress(compressed: &[u8]) -> Result<Vec<u8>, String> {
    const MAX_DECOMPRESSED: usize = 64 * 1024 * 1024;
    let mut out = Vec::new();
    let mut decoder = zstd::stream::Decoder::new(compressed)
        .map_err(|e| format!("[VAULT] DECOMPRESS_INIT_FAILED: {}", e))?;
    use std::io::Read;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = decoder.read(&mut buf)
            .map_err(|e| format!("[VAULT] DECOMPRESS_FAILED: {}", e))?;
        if n == 0 { break; }
        if out.len() + n > MAX_DECOMPRESSED {
            return Err("[VAULT] DECOMPRESS_TOO_LARGE: refusing to inflate past 64 MiB".into());
        }
        out.extend_from_slice(&buf[..n]);
    }
    Ok(out)
}

pub(crate) fn save_vault_internal(state: &DbState) -> Result<(), String> {
    let conn_guard = state.conn.lock().map_err(|_| "[STATE] MUTEX_POISON_CONN")?;
    let key_guard = state.master_key.lock().map_err(|_| "[STATE] MUTEX_POISON_KEY")?;
    let salt_guard = state.salt.lock().map_err(|_| "[STATE] MUTEX_POISON_SALT")?;
    let path_guard = state.db_path.lock().map_err(|_| "[STATE] MUTEX_POISON_PATH")?;

    if let (Some(conn), Some(key), Some(salt), Some(path)) =
        (&*conn_guard, &*key_guard, &*salt_guard, &*path_guard)
    {
        save_vault_blocking(conn, key, salt, path)
    } else {
        Err("[STATE] MISSING_REQUIRED_RESOURCES_FOR_SAVE".into())
    }
}

/// Pure-sync vault serialise + encrypt + atomic write. Pulled out of
/// `save_vault_internal` so the async wrapper below can hand it to
/// `spawn_blocking` with owned snapshots — keeps the SQLite serialise,
/// zstd compression, AES-GCM encrypt, and fsync off the tokio worker
/// pool during hot paths like the post-connect `persist_vault` call.
pub(crate) fn save_vault_blocking(
    conn: &Connection,
    key: &Zeroizing<[u8; 32]>,
    salt: &[u8; SALT_LEN],
    path: &std::path::Path,
) -> Result<(), String> {
    let serialized = conn.serialize(DatabaseName::Main)
        .map_err(|e| format!("[DATABASE] SERIALIZE_FAILED: {}", e))?;
    // Compress-then-encrypt. Order matters: compressing AFTER encryption
    // is useless because AES-GCM ciphertext is indistinguishable from
    // random. Doing it before keeps the on-disk file small AND keeps
    // ciphertext semantically secure.
    let compressed = Zeroizing::new(vault_compress(&*serialized)?);
    let (ciphertext, nonce) = encrypt_with_key(&compressed, key)?;
    let blob = write_vault_blob(salt, &nonce, &ciphertext);
    // Atomic write: tmp -> fsync -> rename. A crash / power loss in the
    // middle of a direct fs::write would leave the vault truncated, and
    // every saved credential would be unrecoverable on next launch.
    let tmp_path = path.with_extension("submarine.tmp");
    {
        use std::io::Write as _;
        let mut f = fs::File::create(&tmp_path)
            .map_err(|e| format!("[FILE] VAULT_TMP_CREATE_FAILED at {:?}: {}", tmp_path, e))?;
        f.write_all(&blob)
            .map_err(|e| format!("[FILE] VAULT_TMP_WRITE_FAILED at {:?}: {}", tmp_path, e))?;
        f.sync_all()
            .map_err(|e| format!("[FILE] VAULT_TMP_SYNC_FAILED at {:?}: {}", tmp_path, e))?;
    }
    fs::rename(&tmp_path, path)
        .map_err(|e| format!("[FILE] VAULT_RENAME_FAILED {:?} -> {:?}: {}", tmp_path, path, e))?;
    Ok(())
}

/// This profile's Data Encryption Key — the 256-bit key that every per-entity
/// sync blob is encrypted under. Stored in `sync_meta` inside the vault (itself
/// encrypted at rest with the vault password), so a solo profile needs no
/// passphrase to sync. When the profile is shared, THIS key is what gets sealed
/// to each member's public key — decoupling "who can read the synced data" from
/// "who knows the vault password". Generated once and reused; rotating it (on a
/// member revoke) is a deliberate, separate action. Returns `(dek, created)`.
pub(crate) fn get_or_create_dek(conn: &Connection) -> Result<([u8; 32], bool), String> {
    let existing: Option<String> = conn
        .query_row("SELECT value FROM sync_meta WHERE key='dek'", [], |r| r.get(0))
        .ok();
    if let Some(hex_s) = existing {
        let raw = hex::decode(&hex_s).map_err(|e| format!("[SHARE] DEK_HEX: {e}"))?;
        if raw.len() == 32 {
            let mut d = [0u8; 32];
            d.copy_from_slice(&raw);
            return Ok((d, false));
        }
        // Malformed row (shouldn't happen) — fall through and mint a fresh one.
    }
    let mut d = [0u8; 32];
    rand::thread_rng().fill(&mut d);
    conn.execute(
        "INSERT INTO sync_meta(key,value) VALUES('dek',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [hex::encode(d)],
    )
    .map_err(|e| format!("[SHARE] DEK_STORE: {e}"))?;
    Ok((d, true))
}

#[cfg(test)]
mod vault_crypto_tests {
    use super::*;

    // --- KDF (Argon2id) ---------------------------------------------------

    #[test]
    fn derive_key_is_deterministic() {
        let salt = [7u8; SALT_LEN];
        let k1 = derive_key("correct horse battery staple", &salt).unwrap();
        let k2 = derive_key("correct horse battery staple", &salt).unwrap();
        assert_eq!(k1, k2, "same password+salt must always derive the same key");
    }

    #[test]
    fn derive_key_changes_with_salt() {
        // Regression guard: if a future refactor ever stops threading the
        // salt into Argon2id (e.g. accidentally hardcoding it), every vault
        // would derive the same key regardless of its stored salt — this
        // would silently defeat the whole point of a per-profile salt.
        let k1 = derive_key("same password", &[1u8; SALT_LEN]).unwrap();
        let k2 = derive_key("same password", &[2u8; SALT_LEN]).unwrap();
        assert_ne!(k1, k2, "different salts must derive different keys");
    }

    #[test]
    fn derive_key_changes_with_password() {
        let salt = [9u8; SALT_LEN];
        let k1 = derive_key("password one", &salt).unwrap();
        let k2 = derive_key("password two", &salt).unwrap();
        assert_ne!(k1, k2, "different passwords must derive different keys");
    }

    // --- AES-256-GCM round trip --------------------------------------------

    #[test]
    fn encrypt_decrypt_round_trips() {
        let key = derive_key("master password", &[3u8; SALT_LEN]).unwrap();
        let plaintext = b"CREATE TABLE servers(...); -- pretend sqlite blob";
        let (ciphertext, nonce) = encrypt_with_key(plaintext, &key).unwrap();
        let recovered = decrypt_with_key(&ciphertext, &nonce, &key).unwrap();
        assert_eq!(recovered, plaintext);
    }

    #[test]
    fn decrypt_fails_with_wrong_key() {
        let key_a = derive_key("password A", &[4u8; SALT_LEN]).unwrap();
        let key_b = derive_key("password B", &[4u8; SALT_LEN]).unwrap();
        let (ciphertext, nonce) = encrypt_with_key(b"secret data", &key_a).unwrap();
        assert!(
            decrypt_with_key(&ciphertext, &nonce, &key_b).is_err(),
            "decrypting with the wrong key must fail, not return garbage plaintext"
        );
    }

    #[test]
    fn decrypt_fails_on_tampered_ciphertext() {
        // AES-GCM's authentication tag must catch a flipped byte — proves the
        // vault can't be silently corrupted/tampered with undetected.
        let key = derive_key("master password", &[5u8; SALT_LEN]).unwrap();
        let (mut ciphertext, nonce) = encrypt_with_key(b"integrity matters", &key).unwrap();
        let last = ciphertext.len() - 1;
        ciphertext[last] ^= 0xFF;
        assert!(decrypt_with_key(&ciphertext, &nonce, &key).is_err());
    }

    // --- zstd compression round trip ---------------------------------------

    #[test]
    fn compress_decompress_round_trips() {
        let original = b"the quick brown fox jumps over the lazy dog".repeat(100);
        let compressed = vault_compress(&original).unwrap();
        let decompressed = vault_decompress(&compressed).unwrap();
        assert_eq!(decompressed, original);
    }

    #[test]
    fn decompress_rejects_oversized_payload() {
        // zstd makes a highly-repetitive buffer trivial to compress to a few
        // KB even well past the 64 MiB decompressed guard, so this runs fast.
        let huge = vec![0u8; 70 * 1024 * 1024];
        let compressed = vault_compress(&huge).unwrap();
        let err = vault_decompress(&compressed).unwrap_err();
        assert!(err.contains("DECOMPRESS_TOO_LARGE"), "got: {err}");
    }

    // --- on-disk blob framing -----------------------------------------------

    #[test]
    fn vault_blob_round_trips() {
        let salt = [6u8; SALT_LEN];
        let nonce = [8u8; NONCE_LEN];
        let ciphertext = b"ciphertext-and-tag-placeholder".to_vec();
        let blob = write_vault_blob(&salt, &nonce, &ciphertext);
        let (parsed_salt, parsed_nonce, parsed_ct) = parse_vault_blob(&blob).unwrap();
        assert_eq!(parsed_salt, salt);
        assert_eq!(parsed_nonce, nonce);
        assert_eq!(parsed_ct, ciphertext);
    }

    #[test]
    fn parse_vault_blob_rejects_bad_magic() {
        let mut blob = write_vault_blob(&[0u8; SALT_LEN], &[0u8; NONCE_LEN], b"x");
        blob[0] = b'X'; // corrupt the magic
        let err = parse_vault_blob(&blob).unwrap_err();
        assert!(err.contains("BAD_MAGIC"), "got: {err}");
    }

    #[test]
    fn parse_vault_blob_rejects_unsupported_version() {
        let mut blob = write_vault_blob(&[0u8; SALT_LEN], &[0u8; NONCE_LEN], b"x");
        blob[4] = VAULT_VERSION + 1; // a version this binary has never written
        let err = parse_vault_blob(&blob).unwrap_err();
        assert!(err.contains("UNSUPPORTED_VERSION"), "got: {err}");
    }

    #[test]
    fn parse_vault_blob_rejects_truncated_header() {
        let blob = write_vault_blob(&[0u8; SALT_LEN], &[0u8; NONCE_LEN], b"x");
        let truncated = &blob[..HEADER_LEN]; // header present, nonce+ciphertext missing
        let err = parse_vault_blob(truncated).unwrap_err();
        assert!(err.contains("INVALID_FORMAT"), "got: {err}");
    }

    // --- DEK (per-entity sync key) ------------------------------------------

    #[test]
    fn get_or_create_dek_errors_on_malformed_stored_hex() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)", []).unwrap();
        conn.execute(
            "INSERT INTO sync_meta(key,value) VALUES('dek','not-valid-hex!!')",
            [],
        ).unwrap();
        // A corrupted stored DEK should surface an error rather than being
        // silently treated as valid key material.
        assert!(get_or_create_dek(&conn).is_err());
    }
}
