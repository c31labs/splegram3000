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

const DATA_DIR = __DIR__ . '/server-data';
const MAX_SAVE_BYTES = 262144; // 256 KB per player is far more than the app ever needs
const MAX_PROFILES = 20;

function respond(array $payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $error, int $code = 400): void {
    respond(['ok' => false, 'error' => $error], $code);
}

function ensure_data_dir(): void {
    if (!is_dir(DATA_DIR)) {
        if (!@mkdir(DATA_DIR, 0755, true)) {
            fail('cannot create server-data directory (check hosting file permissions)', 500);
        }
    }
    // Block direct web access to the stored files (Apache 2.2 and 2.4 syntax).
    $ht = DATA_DIR . '/.htaccess';
    if (!file_exists($ht)) {
        @file_put_contents($ht, "Require all denied\nDeny from all\n");
    }
    $ix = DATA_DIR . '/index.html';
    if (!file_exists($ix)) {
        @file_put_contents($ix, '');
    }
}

function atomic_write(string $path, string $content): bool {
    $tmp = $path . '.tmp.' . bin2hex(random_bytes(4));
    if (@file_put_contents($tmp, $content, LOCK_EX) === false) {
        return false;
    }
    if (!@rename($tmp, $path)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

/* ---------------- family accounts & sessions ---------------- */

const MAX_ACCOUNTS = 500;             // protects a shared host from runaway sign-ups
const SESSION_TTL = 2592000;          // families stay signed in for 30 days (sliding)
const MAX_SESSIONS_PER_ACCOUNT = 10;  // phones + tablets + laptops; oldest gets dropped
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCKOUT_SECONDS = 600;
const RESET_CODE_TTL = 900;
const RESET_MAX_TRIES = 5;

$ACCT = null; // account id of the signed-in family, set by require_account()

function accounts_path(): string { return DATA_DIR . '/accounts.json'; }
function sessions_path(): string { return DATA_DIR . '/sessions.json'; }
function throttle_path(): string { return DATA_DIR . '/throttle.json'; }

function valid_acct_id(?string $id): bool {
    return is_string($id) && (bool)preg_match('/^a_[a-f0-9]{12}$/', $id);
}

function acct_dir(): string {
    global $ACCT;
    if (!valid_acct_id($ACCT)) { fail('sign-in required', 401); }
    return DATA_DIR . '/accounts/' . $ACCT;
}

function ensure_acct_dir(): void {
    $dir = acct_dir();
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
        fail('cannot create account data directory (check hosting file permissions)', 500);
    }
}

/** Coarse exclusive lock shared by all account/session/throttle writes. */
function with_accounts_lock(callable $fn) {
    $lock = fopen(accounts_path() . '.lock', 'c');
    if ($lock) { flock($lock, LOCK_EX); }
    try {
        return $fn();
    } finally {
        if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
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

function valid_password(string $pw): bool {
    $len = strlen($pw);
    return $len >= 8 && $len <= 200;
}

/**
 * Per-IP sliding-window rate limit for the auth endpoints. File-based like
 * everything else; fails the request with 429 when the window is full.
 */
function throttle_check(string $kind, int $max, int $window): void {
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $key = $kind . ':' . hash('sha256', $ip);
    $ok = with_accounts_lock(function () use ($key, $max, $window) {
        $raw = @file_get_contents(throttle_path());
        $data = $raw === false ? null : json_decode($raw, true);
        if (!is_array($data)) { $data = []; }
        $now = time();
        $hits = array_values(array_filter(
            is_array($data[$key] ?? null) ? $data[$key] : [],
            fn($t) => is_numeric($t) && $t > $now - $window
        ));
        if (count($hits) >= $max) { return false; }
        $hits[] = $now;
        $data[$key] = $hits;
        // keep the file tiny: drop keys with no hits in the last day
        $data = array_filter($data, fn($ts) => is_array($ts) && count($ts) && max($ts) > $now - 86400);
        atomic_write(throttle_path(), json_encode($data));
        return true;
    });
    if (!$ok) { fail('too many attempts — please wait a while and try again', 429); }
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

/** Tokens are stored hashed: a copied server-data folder must not grant sign-in. */
function issue_session(string $acctId): string {
    $token = bin2hex(random_bytes(16));
    with_accounts_lock(function () use ($token, $acctId) {
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
        return null;
    });
    return $token;
}

function drop_session(?string $token): void {
    if (!is_string($token) || $token === '') { return; }
    with_accounts_lock(function () use ($token) {
        $sessions = load_sessions();
        unset($sessions[hash('sha256', $token)]);
        save_sessions($sessions);
        return null;
    });
}

function drop_account_sessions(string $acctId): void {
    with_accounts_lock(function () use ($acctId) {
        save_sessions(array_filter(load_sessions(), fn($s) => ($s['acct'] ?? '') !== $acctId));
        return null;
    });
}

function find_account(array $data, string $email): ?int {
    foreach ($data['accounts'] as $i => $a) {
        if (($a['email'] ?? '') === $email) { return $i; }
    }
    return null;
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
    return (bool)preg_match('/^p_[a-f0-9]{12}$/', $id);
}

function save_path(string $id): string {
    return acct_dir() . '/save_' . $id . '.json';
}

/* ---------------- config store (PIN, parent tokens, Word Lab state) ---------------- */

const KID_REFRESH_COOLDOWN = 21600;   // 6 hours between kid-triggered refreshes
const PARENT_TOKEN_TTL = 900;         // 15 min backstop; the client also drops the
                                      // session on leaving the zone, reload or tab close
const PIN_MAX_FAILS = 5;
const PIN_LOCKOUT_SECONDS = 300;
const MAX_EXTRA_ITEMS = 3000;
const ALLOWED_AI_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
const DEFAULT_AI_MODEL = 'claude-opus-5';

function config_path(): string { return acct_dir() . '/config.json'; }
function extra_bank_path(): string { return acct_dir() . '/extra-bank.json'; }

function default_config(): array {
    return [
        'pin_hash' => null,
        'tokens' => [],            // token => expiry timestamp
        'pin_fail_count' => 0,
        'pin_lock_until' => 0,
        'anthropic_key' => null,
        'ai_model' => DEFAULT_AI_MODEL,
        'last_kid_refresh' => 0,
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
    $lock = fopen(config_path() . '.lock', 'c');
    if ($lock) { flock($lock, LOCK_EX); }
    try {
        [$newConfig, $result] = $fn(load_config());
        if (is_array($newConfig)) { save_config($newConfig); }
        return $result;
    } finally {
        if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
    }
}

function prune_tokens(array &$config): void {
    $now = time();
    $config['tokens'] = array_filter($config['tokens'], fn($exp) => $exp > $now);
}

function issue_parent_token(array &$config): string {
    prune_tokens($config);
    $token = bin2hex(random_bytes(16));
    $config['tokens'][$token] = time() + PARENT_TOKEN_TTL;
    return $token;
}

function parent_token_valid(array $config, ?string $token): bool {
    if (!is_string($token) || $token === '') { return false; }
    $exp = $config['tokens'][$token] ?? 0;
    return $exp > time();
}

function require_parent(array $body): void {
    $config = load_config();
    if (!parent_token_valid($config, $body['token'] ?? null)) {
        fail('parent authentication required', 401);
    }
}

function valid_pin(string $pin): bool {
    return (bool)preg_match('/^[0-9]{4,8}$/', $pin);
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

function validate_generated_item(array $it, array $levels, array $knownWords): ?array {
    $level = $it['level'] ?? null;
    if (!is_int($level) || !in_array($level, $levels, true)) { return null; }
    $kind = $it['kind'] ?? null;
    if ($kind === 'spelling') {
        $w = $it['word'] ?? ''; $s = $it['sentence'] ?? ''; $wrong = $it['wrong'] ?? [];
        if (!is_string($w) || $w === '' || strlen($w) > 40) { return null; }
        if (isset($knownWords[mb_strtolower($w)])) { return null; }
        if (!is_string($s) || strlen($s) > 220
            || preg_match_all("/(?<![A-Za-z'])" . preg_quote($w, '/') . "(?![A-Za-z'])/", $s) !== 1) { return null; }
        if (!is_array($wrong) || count($wrong) !== 3) { return null; }
        $seenWrong = [];
        foreach ($wrong as $o) {
            if (!is_string($o) || trim($o) === '' || strlen($o) > 40) { return null; }
            $k = mb_strtolower(trim($o));
            if ($k === mb_strtolower($w) || isset($seenWrong[$k])) { return null; }
            $seenWrong[$k] = true;
        }
        foreach (['definition', 'hint', 'pattern'] as $f) {
            if (!is_string($it[$f] ?? null) || trim($it[$f]) === '' || strlen($it[$f]) > 300) { return null; }
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
            if (!is_string($o) || trim($o) === '' || strlen($o) > 200) { return null; }
        }
        if (!is_int($ans) || $ans < 0 || $ans > 3) { return null; }
        if ($fmt === 'mc') {
            if (!is_string($it['sentence'] ?? null) || strpos($it['sentence'], '___') === false) { return null; }
        } elseif ($fmt === 'sentence-choice') {
            $it['sentence'] = null;
        } else { return null; }
        foreach (['strand', 'prompt', 'hint', 'explanation'] as $f) {
            if (!is_string($it[$f] ?? null) || $it[$f] === '') { return null; }
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

function claude_generate(array $levels, array $config, array $knownWords): ?array {
    $key = $config['anthropic_key'] ?? null;
    if (!is_string($key) || $key === '') { return null; }
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
        CURLOPT_TIMEOUT => 110,
        CURLOPT_HTTPHEADER => [
            'x-api-key: ' . $key,
            'anthropic-version: 2023-06-01',
            'content-type: application/json',
        ],
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
    ]);
    $raw = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if (!is_string($raw) || $status !== 200) { return null; }

    $res = json_decode($raw, true);
    if (!is_array($res)) { return null; }
    $stop = $res['stop_reason'] ?? '';
    if ($stop !== 'end_turn') {
        // truncation/refusal must be visible in the host's error log, not silently
        // masquerade as "no key configured" while still billing the parent
        error_log('spelgram claude_generate: stop_reason=' . $stop . ' model=' . $model);
        return null;
    }
    foreach ($res['content'] ?? [] as $block) {
        if (($block['type'] ?? '') === 'text') {
            $data = json_decode($block['text'] ?? '', true);
            return (is_array($data) && isset($data['items']) && is_array($data['items'])) ? $data['items'] : null;
        }
    }
    return null;
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

// ---------------------------------------------------------------------------

ensure_data_dir();

$action = $_GET['action'] ?? null;
$body = [];
$saveObject = null; // decoded in object mode so JS {} stays {} (assoc mode collapses it to [])
$raw = file_get_contents('php://input');
if (is_string($raw) && $raw !== '') {
    // sendBeacon posts as text/plain, so parse the raw body regardless of content type
    $decoded = json_decode($raw, true);
    if (is_array($decoded)) {
        $body = $decoded;
        $action = $body['action'] ?? $action;
    }
    $objDecoded = json_decode($raw);
    if (is_object($objDecoded) && isset($objDecoded->save) && is_object($objDecoded->save)) {
        $saveObject = $objDecoded->save;
    }
}
if (!is_string($action) || $action === '') {
    fail('missing action');
}

// everything except these runs inside a signed-in family account
$publicActions = ['ping', 'register', 'login', 'logout', 'reset-request', 'reset-confirm'];
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
        $email = clean_email((string)($body['email'] ?? ''));
        if ($email === null) { fail('please enter a valid email address'); }
        $password = (string)($body['password'] ?? '');
        if (!valid_password($password)) { fail('the password needs at least 8 characters'); }
        $family = clean_name((string)($body['family'] ?? ''), 40);
        if ($family === '') { fail('please enter a family name (it\'s what the kids will see)'); }

        $hash = password_hash($password, PASSWORD_DEFAULT); // outside the lock — it's slow
        $result = with_accounts_lock(function () use ($email, $family, $hash) {
            $data = load_accounts();
            if (count($data['accounts']) >= MAX_ACCOUNTS) {
                return ['ok' => false, 'error' => 'sign-ups are full right now — please try again later'];
            }
            if (find_account($data, $email) !== null) {
                return ['ok' => false, 'error' => 'that email already has an account — try signing in instead'];
            }
            $id = 'a_' . bin2hex(random_bytes(6));
            $data['accounts'][] = [
                'id' => $id, 'email' => $email, 'family' => $family, 'pass_hash' => $hash,
                'createdAt' => time(), 'fail_count' => 0, 'lock_until' => 0,
            ];
            save_accounts($data);
            return ['ok' => true, 'id' => $id];
        });
        if (!($result['ok'] ?? false)) { respond($result, 400); }
        $token = issue_session($result['id']);
        respond(['ok' => true, 'auth' => $token,
                 'account' => ['id' => $result['id'], 'email' => $email, 'family' => $family]]);
    }

    case 'login': {
        throttle_check('login', 30, 3600);
        $email = clean_email((string)($body['email'] ?? ''));
        $password = (string)($body['password'] ?? '');
        if ($email === null || $password === '') {
            fail('wrong email or password', 401);
        }
        $result = with_accounts_lock(function () use ($email, $password) {
            $data = load_accounts();
            $i = find_account($data, $email);
            if ($i === null) {
                password_hash($password, PASSWORD_DEFAULT); // unknown email costs the same time as a wrong password
                return ['ok' => false, 'error' => 'wrong email or password'];
            }
            $a = $data['accounts'][$i];
            if (($a['lock_until'] ?? 0) > time()) {
                return ['ok' => false, 'error' => 'locked', 'waitSeconds' => $a['lock_until'] - time()];
            }
            if (!password_verify($password, $a['pass_hash'] ?? '')) {
                $a['fail_count'] = ($a['fail_count'] ?? 0) + 1;
                if ($a['fail_count'] >= LOGIN_MAX_FAILS) {
                    $a['lock_until'] = time() + LOGIN_LOCKOUT_SECONDS;
                    $a['fail_count'] = 0;
                }
                $data['accounts'][$i] = $a;
                save_accounts($data);
                return ['ok' => false, 'error' => 'wrong email or password'];
            }
            $a['fail_count'] = 0;
            $a['lock_until'] = 0;
            $data['accounts'][$i] = $a;
            save_accounts($data);
            return ['ok' => true, 'id' => $a['id'], 'family' => $a['family'] ?? ''];
        });
        if (!($result['ok'] ?? false)) { respond($result, 401); }
        $token = issue_session($result['id']);
        respond(['ok' => true, 'auth' => $token,
                 'account' => ['id' => $result['id'], 'email' => $email, 'family' => $result['family']]]);
    }

    case 'logout': {
        drop_session($body['auth'] ?? null);
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
        throttle_check('reset', 5, 3600);
        $email = clean_email((string)($body['email'] ?? ''));
        if ($email !== null) {
            $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
            $codeHash = password_hash($code, PASSWORD_DEFAULT);
            $found = with_accounts_lock(function () use ($email, $codeHash) {
                $data = load_accounts();
                $i = find_account($data, $email);
                if ($i === null) { return false; }
                $data['accounts'][$i]['reset'] = [
                    'hash' => $codeHash, 'exp' => time() + RESET_CODE_TTL, 'tries' => 0,
                ];
                save_accounts($data);
                return true;
            });
            if ($found) {
                $host = preg_replace('/[^a-z0-9.\-]/i', '', $_SERVER['HTTP_HOST'] ?? 'localhost');
                @mail($email, 'Spelgram 3000 — your password reset code',
                    "Hi!\n\nYour Spelgram 3000 reset code is: {$code}\n\n"
                    . "Enter it on the sign-in screen within 15 minutes to choose a new password.\n"
                    . "If you didn't ask for this, you can safely ignore this email.\n",
                    'From: no-reply@' . $host);
            }
        }
        // always the same answer — never reveal whether an email has an account
        respond(['ok' => true, 'sent' => true]);
    }

    case 'reset-confirm': {
        throttle_check('reset', 10, 3600);
        $email = clean_email((string)($body['email'] ?? ''));
        $code = trim((string)($body['code'] ?? ''));
        $password = (string)($body['password'] ?? '');
        if ($email === null || !preg_match('/^[0-9]{6}$/', $code)) {
            fail('that code isn\'t right — check the email and try again', 401);
        }
        if (!valid_password($password)) { fail('the new password needs at least 8 characters'); }
        $hash = password_hash($password, PASSWORD_DEFAULT);
        $result = with_accounts_lock(function () use ($email, $code, $hash) {
            $data = load_accounts();
            $i = find_account($data, $email);
            $reset = $i === null ? null : ($data['accounts'][$i]['reset'] ?? null);
            if (!is_array($reset) || ($reset['exp'] ?? 0) <= time()) {
                return ['ok' => false, 'error' => 'that code has expired — request a new one'];
            }
            if (($reset['tries'] ?? 0) >= RESET_MAX_TRIES) {
                unset($data['accounts'][$i]['reset']);
                save_accounts($data);
                return ['ok' => false, 'error' => 'too many tries — request a new code'];
            }
            if (!password_verify($code, $reset['hash'] ?? '')) {
                $data['accounts'][$i]['reset']['tries'] = ($reset['tries'] ?? 0) + 1;
                save_accounts($data);
                return ['ok' => false, 'error' => 'that code isn\'t right — check the email and try again'];
            }
            unset($data['accounts'][$i]['reset']);
            $data['accounts'][$i]['pass_hash'] = $hash;
            $data['accounts'][$i]['fail_count'] = 0;
            $data['accounts'][$i]['lock_until'] = 0;
            save_accounts($data);
            return ['ok' => true, 'id' => $data['accounts'][$i]['id'],
                    'family' => $data['accounts'][$i]['family'] ?? ''];
        });
        if (!($result['ok'] ?? false)) { respond($result, 401); }
        drop_account_sessions($result['id']); // a stolen password stops working everywhere
        $token = issue_session($result['id']);
        respond(['ok' => true, 'auth' => $token,
                 'account' => ['id' => $result['id'], 'email' => $email, 'family' => $result['family']]]);
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
        $step = (int)($body['step'] ?? 0);
        $total = (int)($body['total'] ?? 4);
        if ($step < 1 || $step > 4 || $total !== 4) { fail('bad step'); }
        $brackets = [1 => [5, 6], 2 => [7, 8], 3 => [9, 10], 4 => [11, 12]];
        $levels = $brackets[$step];

        // Section 1 (short lock): cooldown gate + config snapshot. The Claude HTTP call
        // must NOT run under this lock or it would block the parent PIN endpoints.
        $gate = with_config_lock(function (array $config) use ($body, $step) {
            $isParent = parent_token_valid($config, $body['parentToken'] ?? null);
            if (!$isParent) {
                $sinceStart = time() - (int)$config['last_kid_refresh'];
                if ($step === 1) {
                    if ($sinceStart < KID_REFRESH_COOLDOWN) {
                        return [null, ['blocked' => true,
                            'resp' => ['ok' => false, 'error' => 'cooldown',
                                       'waitSeconds' => KID_REFRESH_COOLDOWN - $sinceStart]]];
                    }
                    $config['last_kid_refresh'] = time();
                    return [$config, ['blocked' => false, 'snapshot' => $config]];
                }
                // steps 2-4 are only valid inside the brew window opened by step 1
                if ($sinceStart > 600) {
                    return [null, ['blocked' => true,
                        'resp' => ['ok' => false, 'error' => 'cooldown', 'waitSeconds' => 0]]];
                }
            }
            return [null, ['blocked' => false, 'snapshot' => $config]];
        });
        if ($gate['blocked']) { respond($gate['resp'], 429); }
        $snapshot = $gate['snapshot'];

        // Outside any lock: AI generation (long network call) + validation.
        $aiItems = [];
        if (is_string($snapshot['anthropic_key'] ?? null) && $snapshot['anthropic_key'] !== ''
            && count(load_extra_bank()) < MAX_EXTRA_ITEMS) {
            $known = known_words();
            $generated = claude_generate($levels, $snapshot, $known);
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
        $result = with_config_lock(function (array $config) use ($aiItems, $levels, $step) {
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
                return [null, ['ok' => false, 'error' => 'could not write extra bank']];
            }
            return [$config, ['ok' => true, 'added' => count($added), 'source' => $source, 'step' => $step]];
        });
        respond($result, ($result['ok'] ?? false) ? 200 : 429);
    }

    /* ---------------- parent zone ---------------- */

    case 'parent-status': {
        $config = load_config();
        respond([
            'ok' => true,
            'pinSet' => is_string($config['pin_hash'] ?? null),
            'aiConfigured' => is_string($config['anthropic_key'] ?? null) && $config['anthropic_key'] !== '',
            'model' => $config['ai_model'],
        ]);
    }

    case 'parent-setup': {
        $pin = (string)($body['pin'] ?? '');
        if (!valid_pin($pin)) { fail('the code must be 4 to 8 digits'); }
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
        $pin = (string)($body['pin'] ?? '');
        $result = with_config_lock(function (array $config) use ($pin) {
            if (!is_string($config['pin_hash'] ?? null)) {
                return [null, ['ok' => false, 'error' => 'no parent code set yet']];
            }
            if ($config['pin_lock_until'] > time()) {
                return [null, ['ok' => false, 'error' => 'locked',
                               'waitSeconds' => $config['pin_lock_until'] - time()]];
            }
            if (!password_verify($pin, $config['pin_hash'])) {
                $config['pin_fail_count'] = ($config['pin_fail_count'] ?? 0) + 1;
                if ($config['pin_fail_count'] >= PIN_MAX_FAILS) {
                    $config['pin_lock_until'] = time() + PIN_LOCKOUT_SECONDS;
                    $config['pin_fail_count'] = 0;
                }
                return [$config, ['ok' => false, 'error' => 'wrong code']];
            }
            $config['pin_fail_count'] = 0;
            $config['pin_lock_until'] = 0;
            $token = issue_parent_token($config);
            return [$config, ['ok' => true, 'token' => $token]];
        });
        respond($result, ($result['ok'] ?? false) ? 200 : 401);
    }

    case 'parent-logout': {
        $token = (string)($body['token'] ?? '');
        with_config_lock(function (array $config) use ($token) {
            unset($config['tokens'][$token]);
            prune_tokens($config);
            return [$config, null];
        });
        respond(['ok' => true]);
    }

    case 'parent-change-pin': {
        require_parent($body);
        $pin = (string)($body['newPin'] ?? '');
        if (!valid_pin($pin)) { fail('the code must be 4 to 8 digits'); }
        with_config_lock(function (array $config) use ($pin) {
            $config['pin_hash'] = password_hash($pin, PASSWORD_DEFAULT);
            return [$config, null];
        });
        respond(['ok' => true]);
    }

    case 'parent-set-key': {
        require_parent($body);
        $key = trim((string)($body['key'] ?? ''));
        $model = (string)($body['model'] ?? '');
        with_config_lock(function (array $config) use ($key, $model, $body) {
            if (array_key_exists('key', $body)) {
                $config['anthropic_key'] = $key === '' ? null : $key;
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
        $id = (string)($body['id'] ?? '');
        if (!valid_id($id)) { fail('bad id'); }
        $lock = fopen(registry_path() . '.lock', 'c');
        if ($lock) { flock($lock, LOCK_EX); }
        $registry = load_registry();
        $before = count($registry['profiles']);
        $registry['profiles'] = array_values(array_filter(
            $registry['profiles'], fn($p) => $p['id'] !== $id
        ));
        $found = count($registry['profiles']) < $before;
        if ($found) { save_registry($registry); }
        if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
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
        $name = clean_name((string)($body['name'] ?? ''));
        if ($name === '') {
            fail('name required');
        }
        $avatar = clean_avatar((string)($body['avatar'] ?? ''));

        $lock = fopen(registry_path() . '.lock', 'c');
        if ($lock) { flock($lock, LOCK_EX); }

        $registry = load_registry();
        if (count($registry['profiles']) >= MAX_PROFILES) {
            fail('too many profiles');
        }
        $id = 'p_' . bin2hex(random_bytes(6));
        $now = time();
        $registry['profiles'][] = ['id' => $id, 'name' => $name, 'avatar' => $avatar, 'createdAt' => $now, 'updatedAt' => $now];
        save_registry($registry);

        if ($lock) { flock($lock, LOCK_UN); fclose($lock); }

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
        $id = (string)($body['id'] ?? '');
        if (!valid_id($id)) {
            fail('bad id');
        }
        $lock = fopen(registry_path() . '.lock', 'c');
        if ($lock) { flock($lock, LOCK_EX); }
        $registry = load_registry();
        $found = false;
        foreach ($registry['profiles'] as &$p) {
            if ($p['id'] === $id) {
                if (isset($body['name'])) {
                    $name = clean_name((string)$body['name']);
                    if ($name !== '') { $p['name'] = $name; }
                }
                if (isset($body['avatar'])) {
                    $p['avatar'] = clean_avatar((string)$body['avatar']);
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
        if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
        $found ? respond(['ok' => true]) : fail('profile not found', 404);
    }

    case 'load': {
        $id = (string)($body['id'] ?? '');
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
        $id = (string)($body['id'] ?? '');
        if (!valid_id($id)) {
            fail('bad id');
        }
        if ($saveObject === null) {
            fail('save payload required');
        }
        $json = json_encode($saveObject, JSON_UNESCAPED_UNICODE);
        if ($json === false || strlen($json) > MAX_SAVE_BYTES) {
            fail('save too large');
        }

        // refuse stale writes: a late beacon or long-backgrounded tab must not
        // roll back days of newer progress made on another device
        $incomingT = isset($saveObject->updatedAt) && is_numeric($saveObject->updatedAt)
            ? (float)$saveObject->updatedAt : 0.0;
        $prevRaw = @file_get_contents(save_path($id));
        if ($prevRaw !== false) {
            $prev = json_decode($prevRaw, true);
            $storedT = is_array($prev) && isset($prev['updatedAt']) && is_numeric($prev['updatedAt'])
                ? (float)$prev['updatedAt'] : 0.0;
            if ($storedT > $incomingT) {
                respond(['ok' => false, 'error' => 'stale'], 409);
            }
        }

        // registry read-modify-write must hold the same lock as create/update,
        // or a racing create can be silently rolled back
        $lock = fopen(registry_path() . '.lock', 'c');
        if ($lock) { flock($lock, LOCK_EX); }
        $registry = load_registry();
        $exists = false;
        foreach ($registry['profiles'] as &$p) {
            if ($p['id'] === $id) { $exists = true; $p['updatedAt'] = time(); break; }
        }
        unset($p);
        if (!$exists) {
            if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
            fail('profile not found', 404);
        }
        if (!atomic_write(save_path($id), $json)) {
            if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
            fail('could not write save', 500);
        }
        save_registry($registry);
        if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
        respond(['ok' => true, 'updatedAt' => time()]);
    }

    default:
        fail('unknown action: ' . substr($action, 0, 32));
}
