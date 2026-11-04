<?php
/**
 * Spelgram 3000 — accounts, profiles & progress API (v3, multi-family)
 *
 * File-based storage (no database needed on shared hosting):
 *   server-data/accounts.json                 registry of family accounts
 *   server-data/sessions.json                 sign-in session tokens (hashed)
 *   server-data/throttle.json                 per-IP rate limiting for auth endpoints
 *   server-data/accounts/<acct>/profiles.json     that family's players
 *   server-data/accounts/<acct>/save_<id>.json    one progress blob per player
 *   server-data/accounts/<acct>/config.json       parent PIN, Word Lab key & state
 *   server-data/accounts/<acct>/extra-bank.json   that family's unlocked bonus items
 *
 * The folder defaults to server-data/ next to this file. An optional
 * spelgram-local.php next to api.php (never committed) can move it above
 * public_html:   <?php return ['data_dir' => '/home/you/spelgram-data'];
 *
 * Every family account is fully isolated: all player/parent/Word Lab actions
 * require a session token ("auth") and only ever touch that account's folder.
 * Kids never have logins — a family signs in once, then children just pick
 * their player on the "Who's playing?" screen.
 *
 * All requests are POST with a JSON body: {"action": "...", ...}
 * (GET ?action=ping is also allowed so you can test in a browser.)
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

// Warnings must never leak into the JSON (or the error log in a way that
// prints file contents): log them, answer a clean 500, and keep going only
// for notices/deprecations the host's PHP build emits on its own.
ini_set('display_errors', '0');
error_reporting(E_ALL);

/** error_log() wrapper: lines must never carry an email address or a key. */
function log_line(string $msg): void {
    $msg = preg_replace('/[^\s@"\']+@[^\s@"\']+/', '[email]', $msg) ?? $msg;
    $msg = preg_replace('/\b(xkeysib|sk-ant)-[^\s"\']*/', '[key]', $msg) ?? $msg;
    error_log('spelgram ' . $msg);
}

set_error_handler(function (int $errno, string $errstr, string $errfile = '', int $errline = 0): bool {
    if (!(error_reporting() & $errno)) { return false; } // honour the @ operator
    log_line('php[' . $errno . '] ' . $errstr . ' at ' . basename($errfile) . ':' . $errline);
    if (in_array($errno, [E_NOTICE, E_USER_NOTICE, E_DEPRECATED, E_USER_DEPRECATED], true)) {
        return true; // logged; not worth failing the request over
    }
    if (!headers_sent()) { http_response_code(500); }
    echo json_encode(['ok' => false, 'error' => 'server error']);
    exit;
});

register_shutdown_function(function (): void {
    $e = error_get_last();
    if ($e !== null && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        log_line('fatal ' . $e['message'] . ' at ' . basename($e['file']) . ':' . $e['line']);
        if (!headers_sent()) { http_response_code(500); }
        echo json_encode(['ok' => false, 'error' => 'server error']);
    }
});

// The data folder: server-data/ beside this file unless spelgram-local.php
// points somewhere safer (outside the web root). define() rather than const
// because the value is only known after that file has been read.
$spelgramDataDir = __DIR__ . '/server-data';
$spelgramLocal = __DIR__ . '/spelgram-local.php';
if (is_file($spelgramLocal)) {
    $spelgramLocalCfg = include $spelgramLocal;
    if (is_array($spelgramLocalCfg) && is_string($spelgramLocalCfg['data_dir'] ?? null)
        && $spelgramLocalCfg['data_dir'] !== '') {
        $spelgramDataDir = rtrim($spelgramLocalCfg['data_dir'], '/');
    }
}
define('DATA_DIR', $spelgramDataDir);
unset($spelgramDataDir, $spelgramLocal, $spelgramLocalCfg);

const MAX_SAVE_BYTES = 262144; // 256 KB per player is far more than the app ever needs
const MAX_BODY_BYTES = 524288; // 512 KB: a save plus headroom; anything bigger is not the app
const MAX_PROFILES = 20;
const DEFAULT_FROM = 'no-reply@company31.com'; // the owner's domain whose SPF covers the host

function respond(array $payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $error, int $code = 400): void {
    respond(['ok' => false, 'error' => $error], $code);
}

/** A body field as a string; arrays/objects/numbers quietly become '' (no cast warnings). */
function body_str(array $body, string $key): string {
    $v = $body[$key] ?? null;
    return is_string($v) ? $v : '';
}

function body_int(array $body, string $key, int $default = 0): int {
    $v = $body[$key] ?? null;
    return is_int($v) ? $v : (is_numeric($v) ? (int)$v : $default);
}

function ensure_data_dir(): void {
    if (!is_dir(DATA_DIR)) {
        if (!@mkdir(DATA_DIR, 0700, true)) {
            log_line('cannot create the data directory');
            fail('cannot create server-data directory (check hosting file permissions)', 500);
        }
    }
    @chmod(DATA_DIR, 0700); // keep it private even if a file manager loosened it
    // Block direct web access to the stored files (Apache 2.2 and 2.4 syntax).
    // This must succeed: without it the folder's contents are one URL away.
    $ht = DATA_DIR . '/.htaccess';
    $want = "Require all denied\nDeny from all\n";
    $have = is_file($ht) ? file_get_contents($ht) : false;
    if (!is_string($have) || strpos($have, 'Require all denied') === false) {
        if (file_put_contents($ht, $want, LOCK_EX) === false) {
            log_line('cannot write the data directory .htaccess');
            fail('cannot protect server-data directory (check hosting file permissions)', 500);
        }
        @chmod($ht, 0600);
    }
    $ix = DATA_DIR . '/index.html';
    if (!file_exists($ix)) {
        @file_put_contents($ix, '');
        @chmod($ix, 0600);
    }
}

function atomic_write(string $path, string $content): bool {
    $tmp = $path . '.tmp.' . bin2hex(random_bytes(4));
    if (@file_put_contents($tmp, $content, LOCK_EX) === false) {
        log_line('atomic_write: cannot write ' . basename($path));
        return false;
    }
    @chmod($tmp, 0600);
    if (!@rename($tmp, $path)) {
        @unlink($tmp);
        log_line('atomic_write: cannot rename into ' . basename($path));
        return false;
    }
    return true;
}

/**
 * Exclusive file lock that fails closed: if the lock file cannot be opened or
 * locked the request stops with a 500 rather than running unlocked.
 */
function acquire_lock(string $path) {
    $lock = @fopen($path, 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        log_line('cannot take lock ' . basename($path));
        fail('server busy, please try again', 500);
    }
    @chmod($path, 0600);
    return $lock;
}

function release_lock($lock): void {
    flock($lock, LOCK_UN);
    fclose($lock);
}

/* ---------------- family accounts & sessions ---------------- */

const MAX_ACCOUNTS = 2000;            // protects a shared host from runaway sign-ups
const SESSION_TTL = 2592000;          // families stay signed in for 30 days (sliding)
const MAX_SESSIONS_PER_ACCOUNT = 10;  // phones + tablets + laptops; oldest gets dropped
const LOGIN_MAX_FAILS = 8;            // per account AND per IP: other devices are unaffected
const LOGIN_LOCKOUT_SECONDS = 600;
const RESET_CODE_TTL = 900;
const RESET_MAX_TRIES = 5;
const CODE_RESEND_SECONDS = 120;      // one new code per account every 2 minutes
const UNCONFIRMED_TTL = 86400;        // sign-ups never confirmed are purged after a day
const MAX_PASSWORD_BYTES = 72;        // bcrypt ignores anything beyond 72 bytes

$ACCT = null; // account id of the signed-in family, set by require_account()

function accounts_path(): string { return DATA_DIR . '/accounts.json'; }
function sessions_path(): string { return DATA_DIR . '/sessions.json'; }
function throttle_path(): string { return DATA_DIR . '/throttle.json'; }

function valid_acct_id(?string $id): bool {
    return is_string($id) && (bool)preg_match('/^a_[a-f0-9]{12}\z/', $id);
}

function acct_dir(): string {
    global $ACCT;
    if (!valid_acct_id($ACCT)) { fail('sign-in required', 401); }
    return DATA_DIR . '/accounts/' . $ACCT;
}

function ensure_acct_dir(): void {
    $dir = acct_dir();
    if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
        log_line('cannot create an account directory');
        fail('cannot create account data directory (check hosting file permissions)', 500);
    }
}

/**
 * Coarse exclusive lock shared by all account/session/throttle writes.
 * Not re-entrant: never call it from inside $fn (use the *_locked helpers).
 */
function with_accounts_lock(callable $fn) {
    $lock = acquire_lock(accounts_path() . '.lock');
    try {
        return $fn();
    } finally {
        release_lock($lock);
    }
}

function load_accounts(): array {
    $raw = @file_get_contents(accounts_path());
    $data = $raw === false ? null : json_decode($raw, true);
    if (!is_array($data) || !isset($data['accounts']) || !is_array($data['accounts'])) {
        return ['accounts' => []];
    }
    return $data;
}

function save_accounts(array $data): void {
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if ($json === false || !atomic_write(accounts_path(), $json)) {
        fail('could not write accounts', 500);
    }
}

function clean_email(string $email): ?string {
    $email = strtolower(trim($email));
    if (strlen($email) > 120 || !filter_var($email, FILTER_VALIDATE_EMAIL)) { return null; }
    return $email;
}

/** Passwords nobody should be allowed to protect their kids' progress with. */
const COMMON_PASSWORDS = [
    'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd',
    '12345678', '123456789', '1234567890', '87654321', '11111111', '00000000',
    '12341234', '123123123', 'abcd1234', 'abc12345', 'aa123456', '1q2w3e4r',
    '1qaz2wsx', 'qwerty123', 'qwertyuiop', 'letmein1',
    'welcome1', 'iloveyou', 'sunshine', 'princess', 'football', 'baseball',
    'superman', 'trustno1', 'dragon123', 'monkey123', 'computer', 'michael1',
    'jennifer', 'admin123', 'administrator', 'changeme', 'whatever', 'starwars',
    'pokemon1', 'batman123', 'spelgram', 'spelgram3000', 'australia', 'liverpool',
    'chocolate', 'shadow123', 'master123', 'hello123',
];

/** null when the password is acceptable, otherwise the message to show. */
function password_problem(string $pw): ?string {
    if (strlen($pw) < 8) { return 'the password needs at least 8 characters'; }
    if (strlen($pw) > MAX_PASSWORD_BYTES) { return 'the password can be at most 72 characters'; }
    if (in_array(strtolower($pw), COMMON_PASSWORDS, true)) {
        return 'that password is too common, please choose another';
    }
    return null;
}

/* ---------------- outbound email (Brevo, mail() as fallback) ---------------- */

/**
 * Site-wide mail settings live in server-data/mail.json (web-blocked, not in git):
 *   {"brevo_key": "xkeysib-...", "from_email": "no-reply@your-domain", "from_name": "Spelgram 3000"}
 * from_email must be a sender address (or domain) verified in the Brevo account.
 * Without it the sender is DEFAULT_FROM; the request's Host header is never used.
 */
function load_mail_config(): array {
    $raw = @file_get_contents(DATA_DIR . '/mail.json');
    $data = $raw === false ? null : json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function send_mail(string $to, string $subject, string $text): void {
    $cfg = load_mail_config();
    $from = clean_email(body_str($cfg, 'from_email')) ?? DEFAULT_FROM;
    $name = trim(body_str($cfg, 'from_name'));
    if ($name === '') { $name = 'Spelgram 3000'; }
    $key = $cfg['brevo_key'] ?? null;
    if (is_string($key) && $key !== '') {
        $payload = [
            'sender' => ['name' => $name, 'email' => $from],
            'to' => [['email' => $to]],
            'subject' => $subject,
            'textContent' => $text,
        ];
        $ch = curl_init('https://api.brevo.com/v3/smtp/email');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_HTTPHEADER => [
                'api-key: ' . $key,
                'accept: application/json',
                'content-type: application/json',
            ],
            CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
        ]);
        curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        if ($status >= 200 && $status < 300) { return; }
        // mail trouble must reach the error log (status only: the body could echo addresses)
        log_line('send_mail: brevo status=' . $status);
    }
    // no Brevo key configured, or Brevo rejected the send — try the host's mail()
    $fromHeader = $name . ' <' . $from . '>';
    @mail($to, $subject, $text, 'From: ' . $fromHeader . "\r\nReply-To: " . $from);
}

function send_reset_email(string $to, string $code): void {
    send_mail($to, 'Spelgram 3000 — your password reset code',
        "Hi!\n\nYour Spelgram 3000 reset code is: {$code}\n\n"
        . "Enter it on the sign-in screen within 15 minutes to choose a new password.\n"
        . "If you didn't ask for this, you can safely ignore this email.\n");
}

function send_confirm_email(string $to, string $code): void {
    send_mail($to, 'Spelgram 3000 — confirm your family account',
        "Hi!\n\nYour Spelgram 3000 confirmation code is: {$code}\n\n"
        . "Enter it on the sign-up screen within 15 minutes to finish creating your account.\n"
        . "If you didn't sign up, you can safely ignore this email.\n");
}

function send_existing_account_email(string $to): void {
    send_mail($to, 'Spelgram 3000 — you already have an account',
        "Hi!\n\nSomeone (probably you) just tried to create a Spelgram 3000 account with this email address, "
        . "but it already has one.\n\nJust sign in, or use \"Forgot password\" on the sign-in screen "
        . "if you need a new password.\nIf this wasn't you, you can safely ignore this email.\n");
}

/* ---------------- rate limiting (file-based, under the accounts lock) ---------------- */

function client_ip_hash(): string {
    return hash('sha256', $_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

function throttle_load(): array {
    $raw = @file_get_contents(throttle_path());
    $data = $raw === false ? null : json_decode($raw, true);
    return is_array($data) ? $data : [];
}

/** Fails closed: a throttle that cannot be recorded must not let the request through. */
function throttle_save(array $data): void {
    $now = time();
    // keep the file tiny: drop keys with no hits in the last day
    $data = array_filter($data, fn($ts) => is_array($ts) && count($ts) && max($ts) > $now - 86400);
    if (!atomic_write(throttle_path(), json_encode($data))) {
        fail('could not record attempt', 500);
    }
}

function throttle_hits(array $data, string $key, int $window): int {
    $now = time();
    return count(array_filter(
        is_array($data[$key] ?? null) ? $data[$key] : [],
        fn($t) => is_numeric($t) && $t > $now - $window
    ));
}

function throttle_record(array &$data, string $key, int $window): void {
    $now = time();
    $hits = array_values(array_filter(
        is_array($data[$key] ?? null) ? $data[$key] : [],
        fn($t) => is_numeric($t) && $t > $now - $window
    ));
    $hits[] = $now;
    $data[$key] = $hits;
}

/**
 * Per-IP sliding-window rate limit for the auth endpoints; every call counts.
 * Fails the request with 429 when the window is full.
 */
function throttle_check(string $kind, int $max, int $window): void {
    $key = $kind . ':' . client_ip_hash();
    $ok = with_accounts_lock(function () use ($key, $max, $window) {
        $data = throttle_load();
        if (throttle_hits($data, $key, $window) >= $max) { return false; }
        throttle_record($data, $key, $window);
        throttle_save($data);
        return true;
    });
    if (!$ok) { fail('too many attempts — please wait a while and try again', 429); }
}

/** Key for the account-plus-IP password slow-down (used by login and parent-reset-pin). */
function login_pair_key(string $acctId): string {
    return 'loginpair:' . hash('sha256', $acctId . '|' . ($_SERVER['REMOTE_ADDR'] ?? 'unknown'));
}

function load_sessions(): array {
    $raw = @file_get_contents(sessions_path());
    $data = $raw === false ? null : json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function save_sessions(array $sessions): void {
    if (!atomic_write(sessions_path(), json_encode($sessions))) {
        fail('could not write sessions', 500);
    }
}

/**
 * Tokens are stored hashed: a copied server-data folder must not grant sign-in.
 * Must run inside with_accounts_lock. Sessions are issued inside the same lock
 * as the password check (rather than a sessions_revoked_at stamp) so that a
 * reset-confirm landing between "password verified" and "token issued" cannot
 * leave a token minted from the old password alive.
 */
function issue_session_locked(string $acctId): string {
    $token = bin2hex(random_bytes(16));
    $now = time();
    $sessions = array_filter(load_sessions(), fn($s) => is_array($s) && ($s['exp'] ?? 0) > $now);
    $mine = array_filter($sessions, fn($s) => ($s['acct'] ?? '') === $acctId);
    if (count($mine) >= MAX_SESSIONS_PER_ACCOUNT) {
        uasort($mine, fn($a, $b) => ($a['exp'] ?? 0) <=> ($b['exp'] ?? 0));
        $drop = count($mine) - MAX_SESSIONS_PER_ACCOUNT + 1;
        foreach (array_slice(array_keys($mine), 0, $drop) as $k) { unset($sessions[$k]); }
    }
    $sessions[hash('sha256', $token)] = ['acct' => $acctId, 'exp' => $now + SESSION_TTL];
    save_sessions($sessions);
    return $token;
}

function drop_session(?string $token): void {
    if (!is_string($token) || $token === '') { return; }
    with_accounts_lock(function () use ($token) {
        $sessions = load_sessions();
        $hash = hash('sha256', $token);
        if (isset($sessions[$hash])) {
            unset($sessions[$hash]);
            save_sessions($sessions);
        }
        return null;
    });
}

/** Must run inside with_accounts_lock. $keepToken (raw) survives, everything else goes. */
function drop_account_sessions_locked(string $acctId, ?string $keepToken = null): void {
    $keep = is_string($keepToken) ? hash('sha256', $keepToken) : null;
    save_sessions(array_filter(
        load_sessions(),
        fn($s, $h) => ($s['acct'] ?? '') !== $acctId || $h === $keep,
        ARRAY_FILTER_USE_BOTH
    ));
}

function find_account(array $data, string $email): ?int {
    foreach ($data['accounts'] as $i => $a) {
        if (($a['email'] ?? '') === $email) { return $i; }
    }
    return null;
}

function find_account_by_id(array $data, string $acctId): ?int {
    foreach ($data['accounts'] as $i => $a) {
        if (($a['id'] ?? '') === $acctId) { return $i; }
    }
    return null;
}

/** Accounts created before email confirmation existed carry no flag and count as confirmed. */
function account_confirmed(array $a): bool {
    return (bool)($a['confirmed'] ?? true);
}

/** Must run inside with_accounts_lock. Drops sign-ups that never confirmed; true if anything changed. */
function purge_unconfirmed_locked(array &$data): bool {
    $cutoff = time() - UNCONFIRMED_TTL;
    $before = count($data['accounts']);
    $data['accounts'] = array_values(array_filter(
        $data['accounts'],
        fn($a) => account_confirmed($a) || (int)($a['createdAt'] ?? 0) > $cutoff
    ));
    return count($data['accounts']) !== $before;
}

/** A fresh 6-digit code plus its hash. The hash is slow: make it outside any lock. */
function new_code(): array {
    $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    return [$code, password_hash($code, PASSWORD_DEFAULT)];
}

/**
 * Resolves the session token in the body, sets $ACCT and makes sure the
 * account's data folder exists. Every player/parent/Word Lab action runs
 * through this, so one family can never touch another family's files.
 */
function require_account(array $body): void {
    global $ACCT;
    $token = $body['auth'] ?? null;
    if (!is_string($token) || $token === '') { fail('sign-in required', 401); }
    $hash = hash('sha256', $token);
    $sess = load_sessions()[$hash] ?? null;
    if (!is_array($sess) || ($sess['exp'] ?? 0) <= time() || !valid_acct_id($sess['acct'] ?? null)) {
        fail('sign-in required', 401);
    }
    $ACCT = $sess['acct'];
    // sliding renewal — rewrite the file at most once a day per session
    if (($sess['exp'] - time()) < SESSION_TTL - 86400) {
        with_accounts_lock(function () use ($hash) {
            $sessions = load_sessions();
            if (isset($sessions[$hash])) {
                $sessions[$hash]['exp'] = time() + SESSION_TTL;
                save_sessions($sessions);
            }
            return null;
        });
    }
    ensure_acct_dir();
}

function registry_path(): string {
    return acct_dir() . '/profiles.json';
}

/** Exclusive lock for the profile registry (create/update/save/delete). Fails closed. */
function with_registry_lock(callable $fn) {
    $lock = acquire_lock(registry_path() . '.lock');
    try {
        return $fn();
    } finally {
        release_lock($lock);
    }
}

function load_registry(): array {
    $path = registry_path();
    if (!file_exists($path)) {
        return ['profiles' => []];
    }
    $raw = @file_get_contents($path);
    $data = $raw === false ? null : json_decode($raw, true);
    if (!is_array($data) || !isset($data['profiles']) || !is_array($data['profiles'])) {
        return ['profiles' => []];
    }
    return $data;
}

function save_registry(array $registry): void {
    $json = json_encode($registry, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if ($json === false || !atomic_write(registry_path(), $json)) {
        fail('could not write profile registry', 500);
    }
}

function clean_name(string $name, int $max = 16): string {
    $name = trim(strip_tags($name));
    $name = preg_replace('/\s+/u', ' ', $name) ?? '';
    if (function_exists('mb_substr')) {
        $name = mb_substr($name, 0, $max);
    } elseif (preg_match('/^.{0,' . $max . '}/us', $name, $m)) {
        $name = $m[0]; // UTF-8-safe truncation without mbstring
    } else {
        $name = substr($name, 0, $max);
        while ($name !== '' && json_encode($name) === false) {
            $name = substr($name, 0, -1); // strip a trailing partial UTF-8 sequence
        }
    }
    return $name;
}

function clean_avatar(string $avatar): string {
    $avatar = trim($avatar);
    if ($avatar === '' || strlen($avatar) > 16) {
        return "\u{1F984}"; // 🦄 default buddy
    }
    return strip_tags($avatar);
}

function valid_id(string $id): bool {
    return (bool)preg_match('/^p_[a-f0-9]{12}\z/', $id);
}

function save_path(string $id): string {
    return acct_dir() . '/save_' . $id . '.json';
}

/* ---------------- config store (PIN, parent tokens, Word Lab state) ---------------- */

const KID_REFRESH_COOLDOWN = 21600;   // 6 hours between kid-triggered refreshes
const BREW_WINDOW_SECONDS = 600;      // steps 2-4 must follow step 1 within 10 minutes
const PARENT_TOKEN_TTL = 900;         // 15 min backstop; the client also drops the
                                      // session on leaving the zone, reload or tab close
const PIN_MAX_FAILS = 5;
const PIN_LOCKOUT_SECONDS = 300;      // first lockout; doubles each round up to PIN_LOCKOUT_MAX
const PIN_LOCKOUT_MAX = 3600;
const MAX_EXTRA_ITEMS = 3000;
const MAX_GENERATIONS_PER_DAY = 12;   // paid Claude calls per family per UTC day
const GENERATING_STALE_SECONDS = 130; // a "generating" flag older than this is a dead request
const ALLOWED_AI_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
const DEFAULT_AI_MODEL = 'claude-opus-5';

function config_path(): string { return acct_dir() . '/config.json'; }
function extra_bank_path(): string { return acct_dir() . '/extra-bank.json'; }

function default_config(): array {
    return [
        'pin_hash' => null,
        'tokens' => [],            // sha256(token) => expiry timestamp
        'pin_fail_count' => 0,
        'pin_lock_until' => 0,
        'pin_lock_round' => 0,     // how many lockouts in a row; drives the escalation
        'anthropic_key' => null,
        'ai_model' => DEFAULT_AI_MODEL,
        'last_kid_refresh' => 0,
        'brew_started' => 0,       // when step 1 of the current brew ran
        'brew_steps' => [],        // steps already run in that brew
        'generating_since' => 0,   // > 0 while a Claude call is in flight
        'gen_day' => '',           // UTC date of gen_count
        'gen_count' => 0,
        'last_key_status' => 0,    // HTTP status of the last Claude attempt (0 = none/network)
        'unlocked' => [],          // reservoir item ids already moved to the extra bank
    ];
}

function load_config(): array {
    $raw = @file_get_contents(config_path());
    $data = $raw === false ? null : json_decode($raw, true);
    return is_array($data) ? array_merge(default_config(), $data) : default_config();
}

function save_config(array $config): void {
    if (!atomic_write(config_path(), json_encode($config, JSON_UNESCAPED_UNICODE))) {
        fail('could not write config', 500);
    }
}

/** Run $fn under the config lock; $fn receives fresh config and returns [newConfigOrNull, result]. */
function with_config_lock(callable $fn) {
    $lock = acquire_lock(config_path() . '.lock');
    try {
        [$newConfig, $result] = $fn(load_config());
        if (is_array($newConfig)) { save_config($newConfig); }
        return $result;
    } finally {
        release_lock($lock);
    }
}

function prune_tokens(array &$config): void {
    $now = time();
    $config['tokens'] = array_filter(is_array($config['tokens']) ? $config['tokens'] : [], fn($exp) => $exp > $now);
}

/** Parent tokens are stored hashed, like sessions: config.json must not grant the zone. */
function issue_parent_token(array &$config): string {
    prune_tokens($config);
    $token = bin2hex(random_bytes(16));
    $config['tokens'][hash('sha256', $token)] = time() + PARENT_TOKEN_TTL;
    return $token;
}

function parent_token_valid(array $config, ?string $token): bool {
    if (!is_string($token) || $token === '') { return false; }
    $exp = $config['tokens'][hash('sha256', $token)] ?? 0;
    return $exp > time();
}

/** The parent token travels as "parentToken" (new calls) or "token" (older calls). */
function body_parent_token(array $body): ?string {
    $t = body_str($body, 'parentToken');
    if ($t === '') { $t = body_str($body, 'token'); }
    return $t === '' ? null : $t;
}

function require_parent(array $body): void {
    $config = load_config();
    if (!parent_token_valid($config, body_parent_token($body))) {
        fail('parent authentication required', 401);
    }
}

/** Codes set before the 6-digit minimum keep working until they are changed. */
function valid_pin(string $pin): bool {
    return (bool)preg_match('/^[0-9]{4,8}\z/', $pin);
}

function valid_new_pin(string $pin): bool {
    return (bool)preg_match('/^[0-9]{6,8}\z/', $pin);
}

/** Count a wrong PIN; the lockout starts at 5 minutes and doubles each round, up to an hour. */
function record_pin_failure(array &$config): void {
    $config['pin_fail_count'] = (int)($config['pin_fail_count'] ?? 0) + 1;
    if ($config['pin_fail_count'] >= PIN_MAX_FAILS) {
        $round = (int)($config['pin_lock_round'] ?? 0);
        $config['pin_lock_until'] = time() + min(PIN_LOCKOUT_MAX, PIN_LOCKOUT_SECONDS * (2 ** min($round, 8)));
        $config['pin_lock_round'] = $round + 1;
        $config['pin_fail_count'] = 0;
    }
}

function clear_pin_failures(array &$config): void {
    $config['pin_fail_count'] = 0;
    $config['pin_lock_until'] = 0;
    $config['pin_lock_round'] = 0;
}

/* ---------------- extra bank + reservoir (Word Lab) ---------------- */

function load_extra_bank(): array {
    $raw = @file_get_contents(extra_bank_path());
    $data = $raw === false ? null : json_decode($raw, true);
    return (is_array($data) && isset($data['items']) && is_array($data['items'])) ? $data['items'] : [];
}

function save_extra_bank(array $items): bool {
    return atomic_write(extra_bank_path(), json_encode(['items' => array_values($items)], JSON_UNESCAPED_UNICODE));
}

function load_reservoir(): array {
    $items = [];
    foreach (glob(__DIR__ . '/data/reservoir-*.json') ?: [] as $path) {
        $data = json_decode(@file_get_contents($path) ?: 'null', true);
        if (is_array($data) && isset($data['items']) && is_array($data['items'])) {
            foreach ($data['items'] as $it) { $items[] = $it; }
        }
    }
    return $items;
}

/** Every target word already used anywhere in the game (lowercased). */
function known_words(): array {
    $words = [];
    $files = array_merge(
        glob(__DIR__ . '/data/spelling-*.js') ?: [],
        glob(__DIR__ . '/data/reservoir-*.json') ?: [],
        [extra_bank_path()]
    );
    foreach ($files as $path) {
        $raw = @file_get_contents($path);
        if ($raw === false) { continue; }
        if (preg_match_all('/"word"\s*:\s*"([^"]+)"/', $raw, $m)) {
            foreach ($m[1] as $w) { $words[mb_strtolower($w)] = true; }
        }
    }
    return $words;
}

/** A non-empty generated string within $max bytes and free of markup characters. */
function clean_gen_text($v, int $max): bool {
    return is_string($v) && trim($v) !== '' && strlen($v) <= $max && !preg_match('/[<>&]/', $v);
}

function validate_generated_item(array $it, array $levels, array $knownWords): ?array {
    $level = $it['level'] ?? null;
    if (!is_int($level) || !in_array($level, $levels, true)) { return null; }
    $kind = $it['kind'] ?? null;
    if ($kind === 'spelling') {
        $w = $it['word'] ?? ''; $s = $it['sentence'] ?? ''; $wrong = $it['wrong'] ?? [];
        if (!clean_gen_text($w, 40)) { return null; }
        if (isset($knownWords[mb_strtolower($w)])) { return null; }
        if (!clean_gen_text($s, 220)
            || preg_match_all("/(?<![A-Za-z'])" . preg_quote($w, '/') . "(?![A-Za-z'])/", $s) !== 1) { return null; }
        if (!is_array($wrong) || count($wrong) !== 3) { return null; }
        $seenWrong = [];
        foreach ($wrong as $o) {
            if (!clean_gen_text($o, 40)) { return null; }
            $k = mb_strtolower(trim($o));
            if ($k === mb_strtolower($w) || isset($seenWrong[$k])) { return null; }
            $seenWrong[$k] = true;
        }
        foreach (['definition', 'hint', 'pattern'] as $f) {
            if (!clean_gen_text($it[$f] ?? null, 300)) { return null; }
        }
        return [
            'kind' => 'spelling', 'id' => 'ai-' . bin2hex(random_bytes(5)), 'level' => $level,
            'pattern' => $it['pattern'], 'word' => $w, 'definition' => $it['definition'],
            'sentence' => $s, 'hint' => $it['hint'], 'wrong' => array_values($wrong),
        ];
    }
    if ($kind === 'grammar') {
        $opts = $it['options'] ?? []; $ans = $it['answer'] ?? null; $fmt = $it['format'] ?? '';
        if (!is_array($opts) || count($opts) !== 4 || count(array_unique($opts)) !== 4) { return null; }
        foreach ($opts as $o) {
            if (!clean_gen_text($o, 200)) { return null; }
        }
        if (!is_int($ans) || $ans < 0 || $ans > 3) { return null; }
        if ($fmt === 'mc') {
            if (!clean_gen_text($it['sentence'] ?? null, 300) || strpos($it['sentence'], '___') === false) { return null; }
        } elseif ($fmt === 'sentence-choice') {
            $it['sentence'] = null;
        } else { return null; }
        foreach (['strand', 'prompt', 'hint', 'explanation'] as $f) {
            if (!clean_gen_text($it[$f] ?? null, 300)) { return null; }
        }
        return [
            'kind' => 'grammar', 'id' => 'ai-' . bin2hex(random_bytes(5)), 'level' => $level,
            'strand' => $it['strand'], 'format' => $fmt, 'prompt' => $it['prompt'],
            'sentence' => $it['sentence'], 'options' => array_values($opts), 'answer' => $ans,
            'hint' => $it['hint'], 'explanation' => $it['explanation'],
        ];
    }
    return null;
}

const LEVEL_BRIEFS = [
    5 => 'spelling: -tion/-sion/-ssion endings, soft c and g, silent letters; grammar: apostrophes for possession vs plurals, prepositions, commas after fronted phrases',
    6 => 'spelling: homophones spelled for the right meaning, famously tricky everyday words; grammar: direct speech punctuation, comparatives and superlatives, commonly confused pairs',
    7 => 'spelling: double consonants inside words, unstressed vowels, -able/-ible; grammar: main and subordinate clauses, irregular verb forms, commas around extra information',
    8 => 'spelling: ie/ei words, -ous/-ious/-eous, -ance/-ence; grammar: clear pronoun reference, tricky agreement (everyone is, each of them was), fixing run-on sentences',
    9 => 'spelling: Greek and Latin root words, hard NAPLAN favourites; grammar: modality (must/should/might), adverbial phrases, spot-the-error questions',
    10 => 'spelling: Year 6 stretch champion words; grammar: hardest mixed editing review of punctuation, tense, agreement and apostrophes',
    11 => 'spelling (Year 7): -cious/-tious/-cial/-tial, formal vocabulary, deeper Greek and Latin roots; grammar: active vs passive voice, complex sentences, colons and semicolons, formal register',
    12 => 'spelling (Year 7 stretch): hardest high-school-entry words; grammar: editing complex sentences, nominalisation, comma splices vs semicolons',
];

const CLAUDE_MAX_RESPONSE_BYTES = 2097152; // 2 MB: a valid batch is a few KB

/**
 * Asks Claude for a batch. Returns [items-or-null, httpStatus]; the status is
 * stored by the caller so the parent zone can show that the key is in trouble.
 */
function claude_generate(array $levels, array $config, array $knownWords): array {
    $key = $config['anthropic_key'] ?? null;
    if (!is_string($key) || $key === '') { return [null, 0]; }
    $model = in_array($config['ai_model'] ?? '', ALLOWED_AI_MODELS, true) ? $config['ai_model'] : DEFAULT_AI_MODEL;

    $briefs = '';
    foreach ($levels as $lvl) { $briefs .= "Level {$lvl}: " . (LEVEL_BRIEFS[$lvl] ?? '') . "\n"; }
    $avoid = implode(', ', array_slice(array_keys($knownWords), 0, 900));

    $prompt = "You are a content author for an Australian spelling and grammar game for Years 5-7 (NAPLAN Language Conventions). Generate exactly 10 spelling items and 4 grammar items, split evenly across these levels:\n{$briefs}\n"
        . "Rules: AUSTRALIAN English only (colour, realise, favourite). All content original, age-appropriate, positive; everyday Aussie kid life topics; straight apostrophes. Spelling: word lowercase, genuinely matching the level's pattern; sentence natural, 8-14 words, starts with a capital, contains the word exactly once in lowercase and never as the first word; definition kid-friendly without the word; hint = the rule; wrong = 3 plausible distinct misspellings, none a real fitting word. Grammar: format 'mc' (sentence contains ___ plus 4 short options) or 'sentence-choice' (sentence null, 4 full sentences); exactly one option defensibly correct, others clearly wrong; answer = 0-based index; hint guides without revealing; explanation teaches the rule.\n"
        . "CRITICAL: none of these already-used words may appear as a target word: {$avoid}";

    $schema = [
        'type' => 'object', 'additionalProperties' => false, 'required' => ['items'],
        'properties' => ['items' => ['type' => 'array', 'items' => ['anyOf' => [
            ['type' => 'object', 'additionalProperties' => false,
             'required' => ['kind', 'level', 'pattern', 'word', 'definition', 'sentence', 'hint', 'wrong'],
             'properties' => [
                'kind' => ['const' => 'spelling'], 'level' => ['type' => 'integer'],
                'pattern' => ['type' => 'string'], 'word' => ['type' => 'string'],
                'definition' => ['type' => 'string'], 'sentence' => ['type' => 'string'],
                'hint' => ['type' => 'string'],
                'wrong' => ['type' => 'array', 'items' => ['type' => 'string']],
             ]],
            ['type' => 'object', 'additionalProperties' => false,
             'required' => ['kind', 'level', 'strand', 'format', 'prompt', 'sentence', 'options', 'answer', 'hint', 'explanation'],
             'properties' => [
                'kind' => ['const' => 'grammar'], 'level' => ['type' => 'integer'],
                'strand' => ['type' => 'string'], 'format' => ['enum' => ['mc', 'sentence-choice']],
                'prompt' => ['type' => 'string'], 'sentence' => ['type' => ['string', 'null']],
                'options' => ['type' => 'array', 'items' => ['type' => 'string']],
                'answer' => ['type' => 'integer'], 'hint' => ['type' => 'string'],
                'explanation' => ['type' => 'string'],
             ]],
        ]]]],
    ];

    $payload = [
        'model' => $model,
        'max_tokens' => 16000, // hard cap covers thinking + JSON together on claude-opus-5
        'messages' => [['role' => 'user', 'content' => $prompt]],
        'output_config' => [
            'effort' => 'medium', // routine generation — cuts thinking spend, quality holds
            'format' => ['type' => 'json_schema', 'schema' => $schema],
        ],
    ];

    $ch = curl_init('https://api.anthropic.com/v1/messages');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 110,
        CURLOPT_MAXFILESIZE => CLAUDE_MAX_RESPONSE_BYTES, // only honoured with Content-Length; strlen below is the real guard
        CURLOPT_HTTPHEADER => [
            'x-api-key: ' . $key,
            'anthropic-version: 2023-06-01',
            'content-type: application/json',
        ],
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
    ]);
    $raw = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    // no curl_close(): a no-op since PHP 8.0 and a deprecation warning on 8.5+
    // that would leak HTML into the JSON response
    if ($status !== 200) {
        // the status is enough to diagnose a bad key or quota; the body never goes to the log
        log_line('claude_generate: http status=' . $status . ' model=' . $model);
        return [null, $status];
    }
    if (!is_string($raw) || strlen($raw) > CLAUDE_MAX_RESPONSE_BYTES) { return [null, $status]; }

    $res = json_decode($raw, true);
    if (!is_array($res)) { return [null, $status]; }
    $stop = $res['stop_reason'] ?? '';
    if ($stop !== 'end_turn') {
        // truncation/refusal must be visible in the host's error log, not silently
        // masquerade as "no key configured" while still billing the parent
        log_line('claude_generate: stop_reason=' . $stop . ' model=' . $model);
        return [null, $status];
    }
    foreach ($res['content'] ?? [] as $block) {
        if (($block['type'] ?? '') === 'text') {
            $data = json_decode($block['text'] ?? '', true);
            return [(is_array($data) && isset($data['items']) && is_array($data['items'])) ? $data['items'] : null, $status];
        }
    }
    return [null, $status];
}

function extract_summary(?array $save): array {
    return [
        'xp' => isset($save['xp']) && is_numeric($save['xp']) ? (int)$save['xp'] : 0,
        'badges' => isset($save['badges']) && is_array($save['badges']) ? count($save['badges']) : 0,
        'stars' => isset($save['levels']) && is_array($save['levels'])
            ? array_sum(array_map(fn($l) => (int)($l['stars'] ?? 0), $save['levels']))
            : 0,
    ];
}

/** Recursively turns a json_decode() object tree into arrays (one decode, two views). */
function obj_to_array($v) {
    if (is_object($v)) { $v = get_object_vars($v); }
    if (is_array($v)) {
        foreach ($v as $k => $x) { $v[$k] = obj_to_array($x); }
    }
    return $v;
}

// ---------------------------------------------------------------------------

ensure_data_dir();

$method = $_SERVER['REQUEST_METHOD'] ?? 'POST';
if ($method === 'GET') {
    // a browser-typed health check is the only thing GET may do
    if (($_GET['action'] ?? '') !== 'ping') { fail('method not allowed', 405); }
    respond(['ok' => true, 'app' => 'spelgram3000', 'v' => 3]);
}
if ($method !== 'POST') { fail('method not allowed', 405); }

if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > MAX_BODY_BYTES) { fail('request too large', 413); }

$action = null;
$body = [];
$saveObject = null; // kept in object form so JS {} stays {} (array form collapses it to [])
$raw = file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
if (is_string($raw) && strlen($raw) > MAX_BODY_BYTES) { fail('request too large', 413); }
if (is_string($raw) && $raw !== '') {
    // sendBeacon posts as text/plain, so parse the raw body regardless of content type;
    // decoded once (objects), then viewed as arrays for everything except the save blob
    $decoded = json_decode($raw);
    if (is_object($decoded)) {
        if (isset($decoded->save) && is_object($decoded->save)) {
            $saveObject = $decoded->save;
        }
        $body = obj_to_array($decoded);
        $action = $body['action'] ?? null;
    }
}
if (!is_string($action) || $action === '') {
    fail('missing action');
}

// everything except these runs inside a signed-in family account
$publicActions = ['ping', 'register', 'register-confirm', 'login', 'logout', 'reset-request', 'reset-confirm'];
if (!in_array($action, $publicActions, true)) {
    require_account($body);
}

switch ($action) {

    case 'ping':
        respond(['ok' => true, 'app' => 'spelgram3000', 'v' => 3]);
        // no break — respond() exits

    /* ---------------- family accounts ---------------- */

    case 'register': {
        throttle_check('register', 5, 3600);
        $email = clean_email(body_str($body, 'email'));
        if ($email === null) { fail('please enter a valid email address'); }
        $password = body_str($body, 'password');
        if (($problem = password_problem($password)) !== null) { fail($problem); }
        $family = clean_name(body_str($body, 'family'), 40);
        if ($family === '') { fail('please enter a family name (it\'s what the kids will see)'); }

        // both hashes happen before the lock and whether or not the email is
        // taken, so the answer takes the same time either way
        $hash = password_hash($password, PASSWORD_DEFAULT);
        [$code, $codeHash] = new_code();
        $outcome = with_accounts_lock(function () use ($email, $family, $hash, $codeHash) {
            $data = load_accounts();
            $changed = purge_unconfirmed_locked($data);
            $i = find_account($data, $email);
            if ($i !== null) {
                $a = $data['accounts'][$i];
                if (account_confirmed($a)) {
                    // the owner hears about it, at most once an hour so this is no inbox flooder
                    if ((int)($a['notifiedAt'] ?? 0) > time() - 3600) {
                        if ($changed) { save_accounts($data); }
                        return 'wait';
                    }
                    $data['accounts'][$i]['notifiedAt'] = time();
                    save_accounts($data);
                    return 'exists';
                }
                // An unconfirmed sign-up asking again. The pending account always
                // belongs to the latest requester (password and family name replaced),
                // so someone who pre-registered another person's address cannot
                // keep their own password on the account that person then confirms.
                $data['accounts'][$i]['pass_hash'] = $hash;
                $data['accounts'][$i]['family'] = $family;
                // a fresh code, but not more than one every 2 minutes
                if ((int)($a['confirm']['sentAt'] ?? 0) > time() - CODE_RESEND_SECONDS) {
                    save_accounts($data);
                    return 'wait';
                }
                $data['accounts'][$i]['confirm'] = ['hash' => $codeHash, 'exp' => time() + RESET_CODE_TTL, 'tries' => 0, 'sentAt' => time()];
                save_accounts($data);
                return 'resend';
            }
            if (count($data['accounts']) >= MAX_ACCOUNTS) {
                if ($changed) { save_accounts($data); }
                return 'full';
            }
            $data['accounts'][] = [
                'id' => 'a_' . bin2hex(random_bytes(6)), 'email' => $email, 'family' => $family, 'pass_hash' => $hash,
                'createdAt' => time(), 'confirmed' => false,
                'confirm' => ['hash' => $codeHash, 'exp' => time() + RESET_CODE_TTL, 'tries' => 0, 'sentAt' => time()],
            ];
            save_accounts($data);
            return 'new';
        });
        if ($outcome === 'full') { fail('sign-ups are full right now — please try again later'); }
        if ($outcome === 'exists') {
            send_existing_account_email($email);
        } elseif ($outcome === 'new' || $outcome === 'resend') {
            send_confirm_email($email, $code);
        }
        // always the same answer — never reveal whether an email has an account
        respond(['ok' => true, 'pending' => true]);
    }

    case 'register-confirm': {
        throttle_check('register-confirm', 10, 3600);
        $email = clean_email(body_str($body, 'email'));
        $code = trim(body_str($body, 'code'));
        $uniform = 'that code isn\'t right or has expired';
        if ($email === null || !preg_match('/^[0-9]{6}\z/', $code)) { fail($uniform, 401); }
        $result = with_accounts_lock(function () use ($email, $code) {
            $data = load_accounts();
            $i = find_account($data, $email);
            $a = $i === null ? null : $data['accounts'][$i];
            $confirm = (is_array($a) && !account_confirmed($a)) ? ($a['confirm'] ?? null) : null;
            if (!is_array($confirm) || ($confirm['exp'] ?? 0) <= time()) {
                password_hash($code, PASSWORD_DEFAULT); // same cost as a real check
                return null;
            }
            if (($confirm['tries'] ?? 0) >= RESET_MAX_TRIES) {
                unset($data['accounts'][$i]['confirm']);
                save_accounts($data);
                return null;
            }
            if (!password_verify($code, $confirm['hash'] ?? '')) {
                $data['accounts'][$i]['confirm']['tries'] = ($confirm['tries'] ?? 0) + 1;
                save_accounts($data);
                return null;
            }
            unset($data['accounts'][$i]['confirm']);
            $data['accounts'][$i]['confirmed'] = true;
            save_accounts($data);
            $token = issue_session_locked($a['id']);
            return ['ok' => true, 'auth' => $token,
                    'account' => ['id' => $a['id'], 'email' => $a['email'], 'family' => $a['family'] ?? '']];
        });
        if ($result === null) { fail($uniform, 401); }
        respond($result);
    }

    case 'login': {
        $email = clean_email(body_str($body, 'email'));
        $password = body_str($body, 'password');
        if ($email === null || $password === '') {
            fail('wrong email or password', 401);
        }
        $ipKey = 'login:' . client_ip_hash();
        // One lock covers the IP throttle, the password check, the slow-down and the
        // session issue: see issue_session_locked() for why the token is minted here.
        $result = with_accounts_lock(function () use ($email, $password, $ipKey) {
            $throttle = throttle_load();
            if (throttle_hits($throttle, $ipKey, 3600) >= 30) { return 'throttled'; }
            $data = load_accounts();
            if (purge_unconfirmed_locked($data)) { save_accounts($data); }
            $i = find_account($data, $email);
            $a = $i === null ? null : $data['accounts'][$i];
            $pairKey = $a === null ? null : login_pair_key($a['id']);
            if ($a === null || !account_confirmed($a)
                || throttle_hits($throttle, $pairKey, LOGIN_LOCKOUT_SECONDS) >= LOGIN_MAX_FAILS) {
                // unknown, unconfirmed or slowed-down: same cost and same answer as a wrong password
                password_hash($password, PASSWORD_DEFAULT);
                throttle_record($throttle, $ipKey, 3600);
                throttle_save($throttle);
                return 'wrong';
            }
            if (!password_verify($password, $a['pass_hash'] ?? '')) {
                throttle_record($throttle, $ipKey, 3600);
                throttle_record($throttle, $pairKey, LOGIN_LOCKOUT_SECONDS);
                throttle_save($throttle);
                return 'wrong';
            }
            // a successful sign-in costs the IP nothing; refresh an old hash while we have the password
            if (password_needs_rehash($a['pass_hash'], PASSWORD_DEFAULT)) {
                $data['accounts'][$i]['pass_hash'] = password_hash($password, PASSWORD_DEFAULT);
                save_accounts($data);
            }
            $token = issue_session_locked($a['id']);
            return ['ok' => true, 'auth' => $token,
                    'account' => ['id' => $a['id'], 'email' => $email, 'family' => $a['family'] ?? '']];
        });
        if ($result === 'throttled') { fail('too many attempts — please wait a while and try again', 429); }
        if ($result === 'wrong') { fail('wrong email or password', 401); }
        respond($result);
    }

    case 'logout': {
        drop_session($body['auth'] ?? null);
        respond(['ok' => true]);
    }

    case 'logout-all': {
        global $ACCT;
        $acctId = $ACCT;
        with_accounts_lock(function () use ($acctId) {
            drop_account_sessions_locked($acctId);
            return null;
        });
        respond(['ok' => true]);
    }

    case 'change-password': {
        // a session token plus a guessed password must not be a faster way in
        // than the sign-in screen: same IP throttle and account+IP slow-down
        throttle_check('password-check', 20, 3600);
        global $ACCT;
        $acctId = $ACCT;
        $current = body_str($body, 'current');
        $new = body_str($body, 'new');
        $auth = body_str($body, 'auth');
        if (($problem = password_problem($new)) !== null) { fail($problem); }
        if ($current === '') { fail('the current password is wrong', 401); }
        $newHash = password_hash($new, PASSWORD_DEFAULT); // outside the lock — it's slow
        $ok = with_accounts_lock(function () use ($acctId, $current, $newHash, $auth) {
            $throttle = throttle_load();
            $pairKey = login_pair_key($acctId);
            $data = load_accounts();
            $i = find_account_by_id($data, $acctId);
            if ($i === null || throttle_hits($throttle, $pairKey, LOGIN_LOCKOUT_SECONDS) >= LOGIN_MAX_FAILS) {
                password_hash($current, PASSWORD_DEFAULT);
                return false;
            }
            if (!password_verify($current, $data['accounts'][$i]['pass_hash'] ?? '')) {
                throttle_record($throttle, $pairKey, LOGIN_LOCKOUT_SECONDS);
                throttle_save($throttle);
                return false;
            }
            $data['accounts'][$i]['pass_hash'] = $newHash;
            unset($data['accounts'][$i]['reset']);
            save_accounts($data);
            drop_account_sessions_locked($acctId, $auth); // every other device signs out
            return true;
        });
        if (!$ok) { fail('the current password is wrong', 401); }
        respond(['ok' => true]);
    }

    case 'me': {
        // require_account() already ran — report who this session belongs to
        global $ACCT;
        $data = load_accounts();
        foreach ($data['accounts'] as $a) {
            if (($a['id'] ?? '') === $ACCT) {
                respond(['ok' => true,
                         'account' => ['id' => $a['id'], 'email' => $a['email'], 'family' => $a['family'] ?? '']]);
            }
        }
        fail('sign-in required', 401);
    }

    case 'reset-request': {
        throttle_check('reset-request', 5, 3600);
        $email = clean_email(body_str($body, 'email'));
        // the code hash is made whether or not the email is known: same work, same timing
        [$code, $codeHash] = new_code();
        $send = false;
        if ($email !== null) {
            $send = with_accounts_lock(function () use ($email, $codeHash) {
                $data = load_accounts();
                $i = find_account($data, $email);
                if ($i === null || !account_confirmed($data['accounts'][$i])) { return false; }
                // inside the cooldown the earlier code stays valid and nothing new goes out
                $prev = $data['accounts'][$i]['reset'] ?? null;
                if (is_array($prev) && (int)($prev['sentAt'] ?? 0) > time() - CODE_RESEND_SECONDS
                    && ($prev['exp'] ?? 0) > time()) {
                    return false;
                }
                $data['accounts'][$i]['reset'] = [
                    'hash' => $codeHash, 'exp' => time() + RESET_CODE_TTL, 'tries' => 0, 'sentAt' => time(),
                ];
                save_accounts($data);
                return true;
            });
        }
        if ($send) {
            send_reset_email($email, $code);
        }
        // always the same answer — never reveal whether an email has an account
        respond(['ok' => true, 'sent' => true]);
    }

    case 'reset-confirm': {
        throttle_check('reset-confirm', 10, 3600);
        $email = clean_email(body_str($body, 'email'));
        $code = trim(body_str($body, 'code'));
        $password = body_str($body, 'password');
        $uniform = 'that code isn\'t right or has expired';
        // the password rules are checked before the code is touched, so their
        // messages can never double as a hint that the code was right
        if (($problem = password_problem($password)) !== null) { fail($problem); }
        if ($email === null || !preg_match('/^[0-9]{6}\z/', $code)) { fail($uniform, 401); }
        $hash = password_hash($password, PASSWORD_DEFAULT);
        $result = with_accounts_lock(function () use ($email, $code, $hash) {
            $data = load_accounts();
            $i = find_account($data, $email);
            $a = $i === null ? null : $data['accounts'][$i];
            $reset = (is_array($a) && account_confirmed($a)) ? ($a['reset'] ?? null) : null;
            if (!is_array($reset) || ($reset['exp'] ?? 0) <= time()) {
                password_hash($code, PASSWORD_DEFAULT); // same cost as a real check
                return null;
            }
            if (($reset['tries'] ?? 0) >= RESET_MAX_TRIES) {
                unset($data['accounts'][$i]['reset']);
                save_accounts($data);
                return null;
            }
            if (!password_verify($code, $reset['hash'] ?? '')) {
                $data['accounts'][$i]['reset']['tries'] = ($reset['tries'] ?? 0) + 1;
                save_accounts($data);
                return null;
            }
            unset($data['accounts'][$i]['reset']);
            $data['accounts'][$i]['pass_hash'] = $hash;
            save_accounts($data);
            drop_account_sessions_locked($a['id']); // a stolen password stops working everywhere
            $token = issue_session_locked($a['id']);
            return ['ok' => true, 'auth' => $token,
                    'account' => ['id' => $a['id'], 'email' => $email, 'family' => $a['family'] ?? '']];
        });
        if ($result === null) { fail($uniform, 401); }
        respond($result);
    }

    /* ---------------- Word Lab ---------------- */

    case 'extra-bank': {
        respond(['ok' => true, 'items' => load_extra_bank()]);
    }

    case 'refresh-status': {
        $config = load_config();
        $unlocked = array_flip($config['unlocked']);
        $left = 0;
        foreach (load_reservoir() as $it) {
            if (!isset($unlocked[$it['id'] ?? ''])) { $left++; }
        }
        $ai = is_string($config['anthropic_key'] ?? null) && $config['anthropic_key'] !== '';
        $wait = max(0, ($config['last_kid_refresh'] + KID_REFRESH_COOLDOWN) - time());
        respond([
            'ok' => true,
            'canRefresh' => ($wait === 0) && ($left > 0 || $ai),
            'waitSeconds' => $wait,
            'exhausted' => $left === 0 && !$ai,
            'extraCount' => count(load_extra_bank()),
            'reservoirLeft' => $left,
            'aiConfigured' => $ai,
        ]);
    }

    case 'refresh-step': {
        $step = body_int($body, 'step');
        $total = body_int($body, 'total', 4);
        if ($step < 1 || $step > 4 || $total !== 4) { fail('bad step'); }
        $brackets = [1 => [5, 6], 2 => [7, 8], 3 => [9, 10], 4 => [11, 12]];
        $levels = $brackets[$step];
        $parentToken = body_parent_token($body);

        // Section 1 (short lock): cooldown gate, brew-window bookkeeping, the daily
        // cap and the "generating" flag. The Claude HTTP call must NOT run under
        // this lock or it would block the parent PIN endpoints.
        $gate = with_config_lock(function (array $config) use ($parentToken, $step) {
            $now = time();
            $isParent = parent_token_valid($config, $parentToken);
            if (!$isParent) {
                $sinceStart = $now - (int)$config['last_kid_refresh'];
                if ($step === 1) {
                    if ($sinceStart < KID_REFRESH_COOLDOWN) {
                        return [null, ['blocked' => true, 'code' => 429,
                            'resp' => ['ok' => false, 'error' => 'cooldown',
                                       'waitSeconds' => KID_REFRESH_COOLDOWN - $sinceStart]]];
                    }
                    $config['last_kid_refresh'] = $now;
                } elseif ($sinceStart > BREW_WINDOW_SECONDS) {
                    // steps 2-4 are only valid inside the brew window opened by step 1
                    return [null, ['blocked' => true, 'code' => 429,
                        'resp' => ['ok' => false, 'error' => 'cooldown', 'waitSeconds' => 0]]];
                }
            }
            // each step runs once per brew; step 1 (or a stale window) opens a new brew
            $windowOpen = ($now - (int)$config['brew_started']) <= BREW_WINDOW_SECONDS;
            if ($step === 1 || !$windowOpen) {
                $config['brew_started'] = $now;
                $config['brew_steps'] = [];
            }
            $steps = is_array($config['brew_steps']) ? $config['brew_steps'] : [];
            if (in_array($step, $steps, true)) {
                return [null, ['blocked' => true, 'code' => 409,
                    'resp' => ['ok' => false, 'error' => 'that step has already run']]];
            }
            $steps[] = $step;
            $config['brew_steps'] = $steps;

            // will this step call Claude? only with a key and room in the bank
            $generate = is_string($config['anthropic_key'] ?? null) && $config['anthropic_key'] !== ''
                && count(load_extra_bank()) < MAX_EXTRA_ITEMS;
            if ($generate) {
                $since = (int)$config['generating_since'];
                if ($since > 0 && $now - $since < GENERATING_STALE_SECONDS) {
                    return [null, ['blocked' => true, 'code' => 429,
                        'resp' => ['ok' => false, 'error' => 'busy']]];
                }
                $today = gmdate('Y-m-d');
                if (($config['gen_day'] ?? '') !== $today) {
                    $config['gen_day'] = $today;
                    $config['gen_count'] = 0;
                }
                if ((int)$config['gen_count'] >= MAX_GENERATIONS_PER_DAY) {
                    // nothing is saved, so the step and the kid cooldown are not used up
                    return [null, ['blocked' => true, 'code' => 429,
                        'resp' => ['ok' => false, 'error' => 'daily-limit']]];
                }
                $config['gen_count'] = (int)$config['gen_count'] + 1; // attempts count, paid or not
                $config['generating_since'] = $now;
            }
            return [$config, ['blocked' => false, 'generate' => $generate, 'snapshot' => $config]];
        });
        if ($gate['blocked']) { respond($gate['resp'], $gate['code']); }
        $snapshot = $gate['snapshot'];

        // Outside any lock: AI generation (long network call) + validation.
        $aiItems = [];
        $keyStatus = null;
        if ($gate['generate']) {
            $known = known_words();
            [$generated, $keyStatus] = claude_generate($levels, $snapshot, $known);
            if (is_array($generated)) {
                foreach ($generated as $it) {
                    if (!is_array($it)) { continue; }
                    $clean = validate_generated_item($it, $levels, $known);
                    if ($clean !== null) {
                        $aiItems[] = $clean;
                        if ($clean['kind'] === 'spelling') { $known[mb_strtolower($clean['word'])] = true; }
                    }
                }
            }
        }

        // Section 2 (short lock): commit — reservoir fallback selection and all writes.
        $result = with_config_lock(function (array $config) use ($aiItems, $levels, $step, $keyStatus) {
            if ($keyStatus !== null) {
                $config['generating_since'] = 0;
                $config['last_key_status'] = $keyStatus;
            }
            $bank = load_extra_bank();
            if (count($bank) >= MAX_EXTRA_ITEMS) {
                return [$config, ['ok' => true, 'added' => 0, 'source' => 'full', 'step' => $step]];
            }
            $added = $aiItems;
            $source = count($aiItems) > 0 ? 'ai' : 'reservoir';

            if (count($added) === 0) {
                $unlockedSet = array_flip($config['unlocked']);
                $candidates = ['spelling' => [], 'grammar' => []];
                foreach (load_reservoir() as $it) {
                    $id = $it['id'] ?? '';
                    $lvl = $it['level'] ?? 0;
                    $kind = $it['kind'] ?? '';
                    if ($id !== '' && !isset($unlockedSet[$id]) && in_array($lvl, $levels, true)
                        && isset($candidates[$kind])) {
                        $candidates[$kind][] = $it;
                    }
                }
                shuffle($candidates['spelling']);
                shuffle($candidates['grammar']);
                $added = array_merge(
                    array_slice($candidates['spelling'], 0, 9),
                    array_slice($candidates['grammar'], 0, 3)
                );
                foreach ($added as $it) { $config['unlocked'][] = $it['id']; }
            }

            // never store two items with the same id
            if (count($added) > 0) {
                $existing = array_flip(array_map(fn($i) => $i['id'], $bank));
                $added = array_values(array_filter($added, fn($i) => !isset($existing[$i['id']])));
            }
            if (count($added) > 0 && !save_extra_bank(array_merge($bank, $added))) {
                return [$config, ['ok' => false, 'error' => 'could not write extra bank']];
            }
            return [$config, ['ok' => true, 'added' => count($added), 'source' => $source, 'step' => $step]];
        });
        respond($result, ($result['ok'] ?? false) ? 200 : 429);
    }

    /* ---------------- parent zone ---------------- */

    case 'parent-status': {
        $config = load_config();
        $last = (int)($config['last_key_status'] ?? 0);
        respond([
            'ok' => true,
            'pinSet' => is_string($config['pin_hash'] ?? null),
            'aiConfigured' => is_string($config['anthropic_key'] ?? null) && $config['anthropic_key'] !== '',
            'model' => $config['ai_model'],
            'keyProblem' => $last > 0 && $last !== 200, // the last Claude call was answered with an error
        ]);
    }

    case 'parent-setup': {
        $pin = body_str($body, 'pin');
        if (!valid_new_pin($pin)) { fail('the code must be 6 to 8 digits'); }
        $result = with_config_lock(function (array $config) use ($pin) {
            if (is_string($config['pin_hash'] ?? null)) {
                return [null, ['ok' => false, 'error' => 'a parent code is already set']];
            }
            $config['pin_hash'] = password_hash($pin, PASSWORD_DEFAULT);
            $token = issue_parent_token($config);
            return [$config, ['ok' => true, 'token' => $token]];
        });
        respond($result, ($result['ok'] ?? false) ? 200 : 400);
    }

    case 'parent-login': {
        $pin = body_str($body, 'pin');
        if (!valid_pin($pin)) { fail('wrong code', 401); }
        $result = with_config_lock(function (array $config) use ($pin) {
            if (!is_string($config['pin_hash'] ?? null)) {
                return [null, ['ok' => false, 'error' => 'no parent code set yet']];
            }
            if ($config['pin_lock_until'] > time()) {
                return [null, ['ok' => false, 'error' => 'locked',
                               'waitSeconds' => $config['pin_lock_until'] - time()]];
            }
            if (!password_verify($pin, $config['pin_hash'])) {
                record_pin_failure($config);
                return [$config, ['ok' => false, 'error' => 'wrong code']];
            }
            clear_pin_failures($config);
            $token = issue_parent_token($config);
            return [$config, ['ok' => true, 'token' => $token]];
        });
        respond($result, ($result['ok'] ?? false) ? 200 : 401);
    }

    case 'parent-logout': {
        $token = body_parent_token($body);
        with_config_lock(function (array $config) use ($token) {
            if ($token !== null) { unset($config['tokens'][hash('sha256', $token)]); }
            prune_tokens($config);
            return [$config, null];
        });
        respond(['ok' => true]);
    }

    case 'parent-change-pin': {
        // needs the open parent session AND the current code typed again
        require_parent($body);
        $current = body_str($body, 'current');
        $pin = body_str($body, 'pin');
        if ($pin === '') { $pin = body_str($body, 'newPin'); } // older client field name
        if (!valid_new_pin($pin)) { fail('the code must be 6 to 8 digits'); }
        $result = with_config_lock(function (array $config) use ($current, $pin) {
            if ($config['pin_lock_until'] > time()) {
                return [null, ['ok' => false, 'error' => 'locked',
                               'waitSeconds' => $config['pin_lock_until'] - time()]];
            }
            if (!is_string($config['pin_hash'] ?? null) || !password_verify($current, $config['pin_hash'])) {
                record_pin_failure($config);
                return [$config, ['ok' => false, 'error' => 'wrong code']];
            }
            clear_pin_failures($config);
            $config['pin_hash'] = password_hash($pin, PASSWORD_DEFAULT);
            return [$config, ['ok' => true]];
        });
        respond($result, ($result['ok'] ?? false) ? 200 : 401);
    }

    case 'parent-reset-pin': {
        // a forgotten code: the family password stands in for it, with the same
        // slow-down as sign-in so this cannot become a password-guessing side door
        throttle_check('password-check', 20, 3600);
        global $ACCT;
        $acctId = $ACCT;
        $password = body_str($body, 'password');
        $pin = body_str($body, 'pin');
        if (!valid_new_pin($pin)) { fail('the code must be 6 to 8 digits'); }
        if ($password === '') { fail('wrong password', 401); }
        $ok = with_accounts_lock(function () use ($acctId, $password) {
            $throttle = throttle_load();
            $pairKey = login_pair_key($acctId);
            $data = load_accounts();
            $i = find_account_by_id($data, $acctId);
            if ($i === null || throttle_hits($throttle, $pairKey, LOGIN_LOCKOUT_SECONDS) >= LOGIN_MAX_FAILS) {
                password_hash($password, PASSWORD_DEFAULT);
                return false;
            }
            if (!password_verify($password, $data['accounts'][$i]['pass_hash'] ?? '')) {
                throttle_record($throttle, $pairKey, LOGIN_LOCKOUT_SECONDS);
                throttle_save($throttle);
                return false;
            }
            return true;
        });
        if (!$ok) { fail('wrong password', 401); }
        with_config_lock(function (array $config) use ($pin) {
            $config['pin_hash'] = password_hash($pin, PASSWORD_DEFAULT);
            $config['tokens'] = []; // any open parent session ends with the old code
            clear_pin_failures($config);
            return [$config, null];
        });
        respond(['ok' => true]);
    }

    case 'parent-set-key': {
        require_parent($body);
        $key = trim(body_str($body, 'key'));
        $model = body_str($body, 'model');
        $hasKey = array_key_exists('key', $body);
        // a key is printable ASCII, 20 to 256 characters; an empty one clears it
        if ($hasKey && $key !== '' && !preg_match('/^[\x20-\x7e]{20,256}\z/', $key)) {
            fail('that key doesn\'t look right');
        }
        with_config_lock(function (array $config) use ($key, $model, $hasKey) {
            if ($hasKey) {
                $config['anthropic_key'] = $key === '' ? null : $key;
                $config['last_key_status'] = 0; // a new key starts with a clean slate
            }
            if ($model !== '' && in_array($model, ALLOWED_AI_MODELS, true)) {
                $config['ai_model'] = $model;
            }
            return [$config, null];
        });
        $config = load_config();
        respond(['ok' => true,
                 'aiConfigured' => is_string($config['anthropic_key'] ?? null) && $config['anthropic_key'] !== '']);
    }

    case 'parent-delete-profile': {
        require_parent($body);
        $id = body_str($body, 'id');
        if (!valid_id($id)) { fail('bad id'); }
        $found = with_registry_lock(function () use ($id) {
            $registry = load_registry();
            $before = count($registry['profiles']);
            $registry['profiles'] = array_values(array_filter(
                $registry['profiles'], fn($p) => $p['id'] !== $id
            ));
            $found = count($registry['profiles']) < $before;
            if ($found) { save_registry($registry); }
            return $found;
        });
        if ($found) { @unlink(save_path($id)); }
        $found ? respond(['ok' => true]) : fail('profile not found', 404);
    }

    case 'profiles': {
        $registry = load_registry();
        $out = [];
        foreach ($registry['profiles'] as $p) {
            $save = null;
            $rawSave = @file_get_contents(save_path($p['id']));
            if ($rawSave !== false) {
                $save = json_decode($rawSave, true);
            }
            $out[] = [
                'id' => $p['id'],
                'name' => $p['name'],
                'avatar' => $p['avatar'],
                'updatedAt' => $p['updatedAt'] ?? 0,
                'summary' => extract_summary(is_array($save) ? $save : null),
            ];
        }
        respond(['ok' => true, 'profiles' => $out]);
    }

    case 'create': {
        $name = clean_name(body_str($body, 'name'));
        if ($name === '') {
            fail('name required');
        }
        $avatar = clean_avatar(body_str($body, 'avatar'));

        $id = with_registry_lock(function () use ($name, $avatar) {
            $registry = load_registry();
            if (count($registry['profiles']) >= MAX_PROFILES) {
                fail('too many profiles');
            }
            $id = 'p_' . bin2hex(random_bytes(6));
            $now = time();
            $registry['profiles'][] = ['id' => $id, 'name' => $name, 'avatar' => $avatar, 'createdAt' => $now, 'updatedAt' => $now];
            save_registry($registry);
            return $id;
        });

        // optional initial save (used to migrate v1 progress from a device)
        if ($saveObject !== null) {
            $json = json_encode($saveObject, JSON_UNESCAPED_UNICODE);
            if ($json !== false && strlen($json) <= MAX_SAVE_BYTES) {
                atomic_write(save_path($id), $json);
            }
        }
        respond(['ok' => true, 'profile' => ['id' => $id, 'name' => $name, 'avatar' => $avatar]]);
    }

    case 'update': {
        $id = body_str($body, 'id');
        if (!valid_id($id)) {
            fail('bad id');
        }
        $found = with_registry_lock(function () use ($id, $body) {
            $registry = load_registry();
            $found = false;
            foreach ($registry['profiles'] as &$p) {
                if ($p['id'] === $id) {
                    if (is_string($body['name'] ?? null)) {
                        $name = clean_name($body['name']);
                        if ($name !== '') { $p['name'] = $name; }
                    }
                    if (is_string($body['avatar'] ?? null)) {
                        $p['avatar'] = clean_avatar($body['avatar']);
                    }
                    $p['updatedAt'] = time();
                    $found = true;
                    break;
                }
            }
            unset($p);
            if ($found) {
                save_registry($registry);
            }
            return $found;
        });
        $found ? respond(['ok' => true]) : fail('profile not found', 404);
    }

    case 'load': {
        $id = body_str($body, 'id');
        if (!valid_id($id)) {
            fail('bad id');
        }
        $registry = load_registry();
        $exists = false;
        foreach ($registry['profiles'] as $p) {
            if ($p['id'] === $id) { $exists = true; break; }
        }
        if (!$exists) {
            fail('profile not found', 404);
        }
        $rawSave = @file_get_contents(save_path($id));
        if ($rawSave === false) {
            // genuinely no save yet (new profile)
            respond(['ok' => true, 'save' => null]);
        }
        // decode in object mode so empty JS objects survive the round-trip as {}
        $save = json_decode($rawSave);
        if (!is_object($save)) {
            // the file exists but can't be read — never report it as "no save",
            // or a fresh client would happily overwrite recoverable progress
            fail('stored save unreadable', 500);
        }
        respond(['ok' => true, 'save' => $save]);
    }

    case 'save': {
        $id = body_str($body, 'id');
        if (!valid_id($id)) {
            fail('bad id');
        }
        if ($saveObject === null) {
            fail('save payload required');
        }
        // updatedAt is a JS millisecond stamp; a clock set far ahead must not be
        // able to freeze a player's save against every honest device, so clamp
        // it to five minutes ahead of the server before it is stored
        $incomingT = isset($saveObject->updatedAt) && is_numeric($saveObject->updatedAt)
            ? (float)$saveObject->updatedAt : 0.0;
        $maxT = (time() + 300) * 1000.0;
        if ($incomingT > $maxT) { $incomingT = $maxT; $saveObject->updatedAt = (int)$maxT; }
        $json = json_encode($saveObject, JSON_UNESCAPED_UNICODE);
        if ($json === false || strlen($json) > MAX_SAVE_BYTES) {
            fail('save too large');
        }

        // registry read-modify-write must hold the same lock as create/update,
        // or a racing create can be silently rolled back; the stale check lives
        // under the same lock so two late writers cannot both pass it
        $result = with_registry_lock(function () use ($id, $json, $incomingT) {
            // refuse stale writes: a late beacon or long-backgrounded tab must not
            // roll back days of newer progress made on another device
            $prevRaw = @file_get_contents(save_path($id));
            if ($prevRaw !== false) {
                $prev = json_decode($prevRaw, true);
                $storedT = is_array($prev) && isset($prev['updatedAt']) && is_numeric($prev['updatedAt'])
                    ? (float)$prev['updatedAt'] : 0.0;
                if ($storedT > $incomingT) { return 'stale'; }
            }
            $registry = load_registry();
            $exists = false;
            foreach ($registry['profiles'] as &$p) {
                if ($p['id'] === $id) { $exists = true; $p['updatedAt'] = time(); break; }
            }
            unset($p);
            if (!$exists) { return 'missing'; }
            if (!atomic_write(save_path($id), $json)) { return 'unwritable'; }
            save_registry($registry);
            return 'saved';
        });
        if ($result === 'stale') { respond(['ok' => false, 'error' => 'stale'], 409); }
        if ($result === 'missing') { fail('profile not found', 404); }
        if ($result === 'unwritable') { fail('could not write save', 500); }
        respond(['ok' => true, 'updatedAt' => time()]);
    }

    default:
        fail('unknown action: ' . substr($action, 0, 32));
}
