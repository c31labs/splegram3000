<?php
/**
 * Spelgram 3000 — API smoke test.
 *
 * Copies the app into a temporary folder, points it at a temporary data
 * directory through spelgram-local.php (so the working copy is never touched),
 * starts PHP's built-in server on 127.0.0.1:8741 and pokes the public
 * endpoints. Exit code 0 means every check passed.
 *
 *   php tests/smoke.php
 */

declare(strict_types=1);

const PHP_BIN = '/opt/homebrew/bin/php';
const HOST = '127.0.0.1';
const PORT = 8741;

$repo = dirname(__DIR__);
$tmp = rtrim(sys_get_temp_dir(), '/') . '/spelgram-smoke-' . bin2hex(random_bytes(4));
$dataDir = $tmp . '/data-store';
$server = null;
$failures = 0;

function out(string $line): void { fwrite(STDOUT, $line . "\n"); }

function check(string $what, bool $ok, string $detail = ''): void {
    global $failures;
    if (!$ok) { $failures++; }
    out(($ok ? 'PASS' : 'FAIL') . '  ' . $what . ($detail !== '' && !$ok ? '  (' . $detail . ')' : ''));
}

function copy_tree(string $from, string $to): void {
    if (!is_dir($to) && !mkdir($to, 0755, true)) { throw new RuntimeException('cannot create ' . $to); }
    foreach (scandir($from) ?: [] as $entry) {
        if ($entry === '.' || $entry === '..') { continue; }
        $src = $from . '/' . $entry;
        $dst = $to . '/' . $entry;
        if (is_dir($src)) { copy_tree($src, $dst); } else { copy($src, $dst); }
    }
}

function remove_tree(string $dir): void {
    if (!is_dir($dir)) { return; }
    foreach (scandir($dir) ?: [] as $entry) {
        if ($entry === '.' || $entry === '..') { continue; }
        $path = $dir . '/' . $entry;
        is_dir($path) && !is_link($path) ? remove_tree($path) : @unlink($path);
    }
    @rmdir($dir);
}

/** [status, rawBody, decodedJsonOrNull] */
function http(string $method, string $path, ?string $body = null): array {
    $ctx = stream_context_create(['http' => [
        'method' => $method,
        'header' => "Content-Type: application/json\r\n",
        'content' => $body ?? '',
        'ignore_errors' => true,
        'timeout' => 30,
    ]]);
    $raw = @file_get_contents('http://' . HOST . ':' . PORT . $path, false, $ctx);
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) { $status = (int)$m[1]; }
    }
    return [$status, is_string($raw) ? $raw : '', is_string($raw) ? json_decode($raw, true) : null];
}

function post(array $payload): array {
    return http('POST', '/api.php', json_encode($payload));
}

function stop_server(): void {
    global $server, $tmp;
    if (is_resource($server)) {
        $st = proc_get_status($server);
        if ($st['running']) { proc_terminate($server, 15); }
        for ($i = 0; $i < 20 && proc_get_status($server)['running']; $i++) { usleep(100000); }
        if (proc_get_status($server)['running']) { proc_terminate($server, 9); }
        proc_close($server);
        $server = null;
    }
    remove_tree($tmp);
}
register_shutdown_function('stop_server');

/* ---------- a throwaway copy of the app with its own data folder ---------- */

mkdir($tmp, 0755, true);
foreach (['index.html', 'api.php'] as $f) { copy($repo . '/' . $f, $tmp . '/' . $f); }
foreach (['css', 'js', 'data'] as $d) { copy_tree($repo . '/' . $d, $tmp . '/' . $d); }
file_put_contents($tmp . '/spelgram-local.php',
    "<?php\nreturn ['data_dir' => " . var_export($dataDir, true) . "];\n");

$log = $tmp . '/server.log';
$server = proc_open(
    [PHP_BIN, '-S', HOST . ':' . PORT, '-t', $tmp],
    [0 => ['file', '/dev/null', 'r'], 1 => ['file', $log, 'a'], 2 => ['file', $log, 'a']],
    $pipes
);
if (!is_resource($server)) { out('could not start the PHP server'); exit(1); }

$up = false;
for ($i = 0; $i < 50; $i++) {
    [$status, , $json] = http('GET', '/api.php?action=ping');
    if ($status === 200 && ($json['ok'] ?? false) === true) { $up = true; break; }
    usleep(100000);
}
if (!$up) { out('server did not answer ping within 5 s'); out((string)@file_get_contents($log)); exit(1); }

/* ---------- checks ---------- */

[$status, $raw, $json] = http('GET', '/api.php?action=ping');
check('GET ping answers 200 ok', $status === 200 && ($json['app'] ?? '') === 'spelgram3000', $raw);

check('data folder from spelgram-local.php is used', is_dir($dataDir) && is_file($dataDir . '/.htaccess'));
check('.htaccess carries the Require line',
    strpos((string)@file_get_contents($dataDir . '/.htaccess'), 'Require all denied') !== false);
check('working copy gained no accounts file', !is_file($repo . '/server-data/accounts.json'));

$email = 'smoke-' . bin2hex(random_bytes(3)) . '@example.com';
$good = ['action' => 'register', 'email' => $email, 'password' => 'Correct-Horse-9', 'family' => 'Smoke'];

[$status, $raw1, $json] = post($good);
check('register answers pending', $status === 200 && $json === ['ok' => true, 'pending' => true], $raw1);

[$status, $raw2, $json] = post($good);
check('register again answers byte-identical pending', $status === 200 && $raw2 === $raw1, $raw2);

[$status, $raw3, $json] = post(['action' => 'register', 'email' => $email, 'password' => 'Second-Horse-9', 'family' => 'Smoke Two']);
$pending = null;
foreach (json_decode((string)file_get_contents($dataDir . '/accounts.json'), true)['accounts'] ?? [] as $a) {
    if (($a['email'] ?? '') === $email) { $pending = $a; }
}
check('pending account belongs to the latest requester', $status === 200 && $raw3 === $raw1
    && is_array($pending) && ($pending['confirmed'] ?? null) === false
    && password_verify('Second-Horse-9', $pending['pass_hash'] ?? '') && ($pending['family'] ?? '') === 'Smoke Two', $raw3);

[$status, $raw, $json] = post(['action' => 'register', 'email' => 'x-' . $email, 'password' => 'password123', 'family' => 'Smoke']);
check('register refuses a common password', $status === 400 && ($json['ok'] ?? null) === false, $raw);

[$status, $raw, $json] = post(['action' => 'register', 'email' => ['not', 'a', 'string'], 'password' => 'Correct-Horse-9', 'family' => 'Smoke']);
check('array-typed field is a clean 400, not a warning', $status === 400 && ($json['error'] ?? '') === 'please enter a valid email address', $raw);

[$status, $raw, $json] = post(['action' => 'register-confirm', 'email' => $email, 'code' => '000000']);
$okConfirm = $status === 401 && ($json['error'] ?? '') === "that code isn't right or has expired";
[$status2, $raw2, $json2] = post(['action' => 'register-confirm', 'email' => 'nobody-' . $email, 'code' => '000000']);
check('register-confirm wrong code is the uniform error', $okConfirm, $raw);
check('register-confirm unknown email is the same answer', $status2 === $status && $raw2 === $raw, $raw2);

[$status, $raw, $json] = post(['action' => 'login', 'email' => 'nobody-' . $email, 'password' => 'Correct-Horse-9']);
check('login unknown email is 401 wrong email or password', $status === 401 && ($json['error'] ?? '') === 'wrong email or password', $raw);
[$status2, $raw2] = post(['action' => 'login', 'email' => $email, 'password' => 'Wrong-Horse-9']);
check('login wrong password is the same status and body', $status2 === $status && $raw2 === $raw, $raw2);
[$status3, $raw3] = post(['action' => 'login', 'email' => $email, 'password' => 'Correct-Horse-9']);
check('login before confirmation is refused the same way', $status3 === $status && $raw3 === $raw, $raw3);

$big = json_encode(['action' => 'ping', 'pad' => str_repeat('x', 524288)]);
[$status, $raw] = http('POST', '/api.php', $big);
check('body over 512 KB is rejected with 413', $status === 413, $status . ' ' . $raw);

[$status, $raw] = http('GET', '/api.php?action=login');
check('GET of a non-ping action is 405', $status === 405, $status . ' ' . $raw);

[$status, $raw, $json] = http('POST', '/api.php', '{}');
check('POST without action is 400 missing action', $status === 400 && ($json['error'] ?? '') === 'missing action', $raw);

[$status, $raw, $json] = post(['action' => 'profiles']);
check('signed-out account action is 401', $status === 401 && ($json['error'] ?? '') === 'sign-in required', $raw);

[$status, $raw, $json] = post(['action' => 'reset-request', 'email' => $email]);
check('reset-request answers sent', $status === 200 && ($json['sent'] ?? false) === true, $raw);

[$status, $raw, $json] = post(['action' => 'reset-confirm', 'email' => $email, 'code' => '000000', 'password' => 'Another-Horse-9']);
check('reset-confirm wrong code is the uniform error', $status === 401 && ($json['error'] ?? '') === "that code isn't right or has expired", $raw);

/* ---------- signed-in flow, on an account seeded as already confirmed ---------- */

$seedEmail = 'seeded-' . bin2hex(random_bytes(3)) . '@example.com';
$seedPw = 'Seeded-Horse-9';
$accounts = json_decode((string)file_get_contents($dataDir . '/accounts.json'), true);
$accounts['accounts'][] = [
    'id' => 'a_' . bin2hex(random_bytes(6)), 'email' => $seedEmail, 'family' => 'Seeded',
    'pass_hash' => password_hash($seedPw, PASSWORD_DEFAULT), 'createdAt' => time(), 'confirmed' => true,
];
file_put_contents($dataDir . '/accounts.json', json_encode($accounts));

[$status, $raw, $json] = post(['action' => 'login', 'email' => $seedEmail, 'password' => $seedPw]);
$auth = (string)($json['auth'] ?? '');
check('login on a confirmed account returns a token', $status === 200 && $auth !== '' && ($json['account']['family'] ?? '') === 'Seeded', $raw);
[$status, $raw, $json] = post(['action' => 'login', 'email' => $seedEmail, 'password' => $seedPw]);
$auth2 = (string)($json['auth'] ?? '');
check('a second device signs in too', $status === 200 && $auth2 !== '' && $auth2 !== $auth, $raw);

[$status, $raw, $json] = post(['action' => 'me', 'auth' => $auth]);
check('me reports the account', $status === 200 && ($json['account']['email'] ?? '') === $seedEmail, $raw);

[$status, $raw, $json] = post(['action' => 'create', 'auth' => $auth, 'name' => 'Kid', 'avatar' => '🦊']);
$pid = (string)($json['profile']['id'] ?? '');
check('create profile', $status === 200 && preg_match('/^p_[a-f0-9]{12}$/', $pid) === 1, $raw);

$farFuture = (time() + 86400) * 1000;
[$status, $raw, $json] = post(['action' => 'save', 'auth' => $auth, 'id' => $pid, 'save' => ['xp' => 5, 'updatedAt' => $farFuture, 'levels' => new stdClass()]]);
check('save accepted', $status === 200 && ($json['ok'] ?? false) === true, $raw);
[$status, $raw, $json] = post(['action' => 'load', 'auth' => $auth, 'id' => $pid]);
$storedT = (float)($json['save']['updatedAt'] ?? 0);
check('load returns the save with updatedAt clamped to now+5min', $status === 200 && $storedT < $farFuture && $storedT <= (time() + 301) * 1000, $raw);
check('empty JS object survives the round trip as {}', strpos($raw, '"levels":{}') !== false, $raw);
[$status, $raw, $json] = post(['action' => 'save', 'auth' => $auth, 'id' => $pid, 'save' => ['xp' => 1, 'updatedAt' => 1000]]);
check('stale save is refused with 409', $status === 409 && ($json['error'] ?? '') === 'stale', $raw);

[$status, $raw, $json] = post(['action' => 'parent-setup', 'auth' => $auth, 'pin' => '1234']);
check('parent-setup refuses a 4-digit code', $status === 400, $raw);
[$status, $raw, $json] = post(['action' => 'parent-setup', 'auth' => $auth, 'pin' => '246810']);
$ptoken = (string)($json['token'] ?? '');
check('parent-setup with 6 digits returns a parent token', $status === 200 && $ptoken !== '', $raw);
$cfg = json_decode((string)file_get_contents(glob($dataDir . '/accounts/a_*/config.json')[0]), true);
check('parent token is stored hashed', !isset($cfg['tokens'][$ptoken]) && isset($cfg['tokens'][hash('sha256', $ptoken)]), json_encode($cfg['tokens'] ?? null));

[$status, $raw, $json] = post(['action' => 'parent-login', 'auth' => $auth, 'pin' => '000000']);
check('parent-login wrong code', $status === 401 && ($json['error'] ?? '') === 'wrong code', $raw);
[$status, $raw, $json] = post(['action' => 'parent-status', 'auth' => $auth]);
check('parent-status has keyProblem false', $status === 200 && ($json['keyProblem'] ?? null) === false && ($json['pinSet'] ?? null) === true, $raw);

[$status, $raw, $json] = post(['action' => 'parent-change-pin', 'auth' => $auth, 'parentToken' => $ptoken, 'current' => '999999', 'pin' => '135791']);
check('parent-change-pin needs the current code', $status === 401, $raw);
[$status, $raw, $json] = post(['action' => 'parent-change-pin', 'auth' => $auth, 'parentToken' => $ptoken, 'current' => '246810', 'pin' => '135791']);
check('parent-change-pin with the current code', $status === 200 && ($json['ok'] ?? false) === true, $raw);
[$status, $raw, $json] = post(['action' => 'parent-login', 'auth' => $auth, 'pin' => '135791']);
check('parent-login with the new code', $status === 200 && ($json['token'] ?? '') !== '', $raw);
$ptoken = (string)$json['token'];

[$status, $raw, $json] = post(['action' => 'parent-set-key', 'auth' => $auth, 'token' => $ptoken, 'key' => 'short']);
check('parent-set-key refuses a malformed key', $status === 400, $raw);
[$status, $raw, $json] = post(['action' => 'parent-set-key', 'auth' => $auth, 'token' => $ptoken]);
check('parent-set-key probe without key is side-effect free', $status === 200 && ($json['aiConfigured'] ?? null) === false, $raw);

[$status, $raw, $json] = post(['action' => 'refresh-step', 'auth' => $auth, 'parentToken' => $ptoken, 'step' => 1, 'total' => 4]);
check('refresh-step 1 draws from the reservoir', $status === 200 && ($json['source'] ?? '') === 'reservoir' && ($json['added'] ?? 0) > 0, $raw);
[$status, $raw, $json] = post(['action' => 'refresh-step', 'auth' => $auth, 'parentToken' => $ptoken, 'step' => 2, 'total' => 4]);
check('refresh-step 2 runs', $status === 200 && ($json['step'] ?? 0) === 2, $raw);
[$status, $raw, $json] = post(['action' => 'refresh-step', 'auth' => $auth, 'parentToken' => $ptoken, 'step' => 2, 'total' => 4]);
check('repeating a step is refused', $status === 409 && ($json['error'] ?? '') === 'that step has already run', $raw);

[$status, $raw, $json] = post(['action' => 'parent-reset-pin', 'auth' => $auth, 'password' => 'Wrong-Horse-9', 'pin' => '777777']);
check('parent-reset-pin needs the family password', $status === 401, $raw);
[$status, $raw, $json] = post(['action' => 'parent-reset-pin', 'auth' => $auth, 'password' => $seedPw, 'pin' => '777777']);
check('parent-reset-pin with the family password', $status === 200, $raw);
[$status, $raw, $json] = post(['action' => 'parent-login', 'auth' => $auth, 'pin' => '777777']);
check('the reset code opens the zone', $status === 200 && ($json['token'] ?? '') !== '', $raw);

[$status, $raw, $json] = post(['action' => 'change-password', 'auth' => $auth, 'current' => 'nope-nope-9', 'new' => 'Fresh-Horse-9']);
check('change-password needs the current password', $status === 401, $raw);
[$status, $raw, $json] = post(['action' => 'change-password', 'auth' => $auth, 'current' => $seedPw, 'new' => 'Fresh-Horse-9']);
check('change-password', $status === 200 && ($json['ok'] ?? false) === true, $raw);
[$status, $raw, $json] = post(['action' => 'me', 'auth' => $auth2]);
check('the other device was signed out', $status === 401, $raw);
[$status, $raw, $json] = post(['action' => 'me', 'auth' => $auth]);
check('the current device stays signed in', $status === 200, $raw);

// a stolen session token must not make the password guessable at bcrypt speed
for ($i = 0; $i < 8; $i++) {
    post(['action' => 'change-password', 'auth' => $auth, 'current' => 'guess-' . $i . '-aaaa', 'new' => 'Other-Horse-9']);
}
[$status, $raw, $json] = post(['action' => 'change-password', 'auth' => $auth, 'current' => 'Fresh-Horse-9', 'new' => 'Other-Horse-9']);
check('after 8 wrong guesses even the right password is refused', $status === 401, $status . ' ' . $raw);

[$status, $raw, $json] = post(['action' => 'logout-all', 'auth' => $auth]);
check('logout-all', $status === 200 && ($json['ok'] ?? false) === true, $raw);
[$status, $raw, $json] = post(['action' => 'me', 'auth' => $auth]);
check('no session survives logout-all', $status === 401, $raw);

$serverLog = (string)@file_get_contents($log);
check('no PHP warnings or notices reached the server log', !preg_match('/PHP (Warning|Notice|Deprecated|Fatal)/', $serverLog), substr($serverLog, 0, 400));

out('');
out($failures === 0 ? 'all checks passed' : $failures . ' check(s) failed');
exit($failures === 0 ? 0 : 1);
