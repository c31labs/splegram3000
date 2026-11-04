/* Spelgram 3000 — engine: content registry, save data, adaptive sessions, speech, sound, confetti */
(function () {
  'use strict';

  /* ---------- content registry (data files call these) ---------- */
  const SPELGRAM = {
    spelling: [],
    grammar: [],
    byId: {},
    registerSpelling: function (bank, items) {
      const self = this;
      items.forEach(function (it) {
        if (self.byId[it.id]) return; /* never register the same item twice */
        it.kind = 'spelling'; it.bank = bank;
        self.byId[it.id] = it;
        self.spelling.push(it);
      });
    },
    registerGrammar: function (bank, items) {
      const self = this;
      items.forEach(function (it) {
        if (self.byId[it.id]) return;
        it.kind = 'grammar'; it.bank = bank;
        self.byId[it.id] = it;
        self.grammar.push(it);
      });
    },
    registerExtra: function (items) {
      const sp = [], gr = [];
      (items || []).forEach(function (it) {
        if (it && it.kind === 'grammar') gr.push(it); else if (it) sp.push(it);
      });
      if (sp.length) this.registerSpelling('extra', sp);
      if (gr.length) this.registerGrammar('extra', gr);
    },
  };
  window.SPELGRAM = SPELGRAM;
  function itemById(id) { return SPELGRAM.byId[id] || null; }

  /* ---------- utilities ---------- */
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function normalise(s) {
    return String(s || '').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
  }

  /* ---------- family account (sign-in) ---------- */
  const KEY_AUTH = 'spelgram3000-auth';

  /* The signed-in family account. The token is a server session; everything a
     family stores locally is namespaced by account id, so two families sharing
     a browser can never see each other's cached players or progress. */
  const Auth = {
    token: '', acctId: '', email: '', family: '',
    onExpired: null,
    load: function () {
      try {
        const a = JSON.parse(localStorage.getItem(KEY_AUTH) || 'null');
        if (a && a.token && a.acctId) {
          this.token = a.token; this.acctId = a.acctId;
          this.email = a.email || ''; this.family = a.family || '';
        }
      } catch (e) {}
    },
    persist: function () {
      try {
        if (this.token) {
          localStorage.setItem(KEY_AUTH, JSON.stringify({
            token: this.token, acctId: this.acctId, email: this.email, family: this.family,
          }));
        } else {
          localStorage.removeItem(KEY_AUTH);
        }
      } catch (e) {}
    },
    signedIn: function () { return !!this.token; },
    apply: function (res) {
      this.token = res.auth;
      this.acctId = res.account.id;
      this.email = res.account.email;
      this.family = res.account.family || '';
      this.persist();
    },
    /* these return the raw server response (not null on a clean error) so the
       sign-in screen can show the real message — "wrong email or password" etc. */
    /* register answers {ok, pending}: the account only exists once the emailed
       code is confirmed, so nothing is applied here */
    register: function (family, email, password) {
      const self = this;
      return Net.apiRaw('register', { family: family, email: email, password: password }, 15000)
        .then(function (res) { if (res && res.ok && res.auth && res.account) self.apply(res); return res; });
    },
    registerConfirm: function (email, code) {
      const self = this;
      return Net.apiRaw('register-confirm', { email: email, code: code }, 15000)
        .then(function (res) { if (res && res.ok && res.auth && res.account) self.apply(res); return res; });
    },
    login: function (email, password) {
      const self = this;
      return Net.apiRaw('login', { email: email, password: password }, 15000)
        .then(function (res) { if (res && res.ok) self.apply(res); return res; });
    },
    resetRequest: function (email) {
      return Net.apiRaw('reset-request', { email: email }, 15000);
    },
    resetConfirm: function (email, code, password) {
      const self = this;
      return Net.apiRaw('reset-confirm', { email: email, code: code, password: password }, 15000)
        .then(function (res) { if (res && res.ok) self.apply(res); return res; });
    },
    /* validate the stored token at boot: true = valid, false = rejected,
       null = server unreachable (keep the cached account for offline play) */
    check: function () {
      const self = this;
      if (!this.token) return Promise.resolve(false);
      return Net.apiRaw('me', {}, 6000).then(function (res) {
        if (!res) return null;
        if (res.ok) {
          self.email = res.account.email;
          self.family = res.account.family || '';
          self.persist();
          return true;
        }
        // The server no longer honours this token (signed out everywhere, or
        // expired): forget this family's cached players and progress too.
        self.wipeLocal(false);
        Profiles.signOut();
        self.clear();
        return false;
      });
    },
    signOut: function () {
      const token = this.token;
      this.clear();
      return token ? Net.api('logout', { auth: token }) : Promise.resolve(null);
    },
    clear: function () {
      this.token = ''; this.acctId = ''; this.email = ''; this.family = '';
      this.persist();
    },
    /* Remove this family's cached players and progress from the browser. With
       all=true (or when no account is signed in: device-only play) every app key
       goes, so nothing of anyone is left behind on a shared device. Must run
       while acctId is still set: the namespaced keys are derived from it. */
    wipeLocal: function (all) {
      const acct = this.acctId;
      const doomed = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || k.indexOf('spelgram3000-') !== 0) continue;
          if (all || !acct ||
              k === KEY_AUTH ||
              k === 'spelgram3000-current-' + acct ||
              k === 'spelgram3000-v2-profiles-local-' + acct ||
              k.indexOf('spelgram3000-v2-save-' + acct + '-') === 0) {
            doomed.push(k);
          }
        }
        if (all) doomed.push('spelgram-parent-token');
        doomed.forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) {}
      try { sessionStorage.removeItem('spelgram-parent-token'); } catch (e) {}
    },
    /* the server said "sign-in required" — the session expired or was revoked.
       No push is possible with a dead token, so the family's cached data goes
       and the in-memory player is dropped before the account is cleared. */
    expire: function () {
      if (!this.token) return;
      this.wipeLocal(false);
      Profiles.signOut();
      this.clear();
      if (this.onExpired) this.onExpired();
    },
  };
  Auth.load();

  /* ---------- profiles, save data & server sync ---------- */
  /* storage keys are namespaced per account; the legacy unsuffixed keys serve
     as the 'device' namespace for offline, never-signed-in play */
  function nsSuffix() { return Auth.acctId ? '-' + Auth.acctId : ''; }
  function keyCurrent() { return 'spelgram3000-current' + nsSuffix(); }
  function keySavePrefix() { return 'spelgram3000-v2-save' + nsSuffix() + '-'; }
  function keyLocalProfiles() { return 'spelgram3000-v2-profiles-local' + nsSuffix(); }
  const KEY_V1 = 'spelgram3000-v1';

  let save = null;
  let currentProfileId = null;
  /* sync is armed only after we successfully read this profile's server copy in
     this session — otherwise a blind push could overwrite real progress */
  let syncArmed = false;
  try { currentProfileId = localStorage.getItem(keyCurrent()) || null; } catch (e) {}

  function freshSave() {
    return {
      name: '', avatar: '🦄',
      xp: 0, correctTotal: 0, spellingCorrect: 0, grammarCorrect: 0,
      streak: 0, lastPlayedDay: '',
      levels: {},   /* "1": {stars, best, attempts, passed, failedOnce} */
      seen: {},     /* itemId: {n: timesSeen, t: lastSeenMs} */
      badges: [],
      sound: true,
      updatedAt: 0,
    };
  }
  function storageKey() { return keySavePrefix() + (currentProfileId || 'guest'); }
  function asPlainObject(v) {
    if (!v || typeof v !== 'object') return {};
    if (!Array.isArray(v)) return v;
    /* recover maps that were flattened to arrays (older server round-trips) */
    const obj = {};
    v.forEach(function (val, i) { if (val != null) obj[String(i)] = val; });
    return obj;
  }
  /* make blob the live in-memory save (localStorage is only a cache) */
  function hydrate(blob) {
    save = Object.assign(freshSave(), blob || {});
    save.levels = asPlainObject(save.levels);
    save.seen = asPlainObject(save.seen);
    if (!Array.isArray(save.badges)) save.badges = [];
    return save;
  }
  function loadSave() {
    if (save) return save;
    let blob = null;
    try {
      const raw = localStorage.getItem(storageKey());
      blob = raw ? JSON.parse(raw) : null;
    } catch (e) { blob = null; }
    return hydrate(blob);
  }
  function persist() {
    const s = loadSave();
    s.updatedAt = Date.now();
    try { localStorage.setItem(storageKey(), JSON.stringify(s)); } catch (e) {}
    Net.scheduleSync();
  }
  function resetSave() { save = freshSave(); persist(); }

  /* server API — the app works fine without it (device-only mode) */
  const Net = {
    online: false,
    syncTimer: null,
    isServerId: function (id) { return typeof id === 'string' && id.indexOf('p_') === 0; },
    api: function (action, payload, timeoutMs) {
      return this.apiRaw(action, payload, timeoutMs)
        .then(function (data) { return (data && data.ok) ? data : null; });
    },
    /* like api() but also returns the server's clean error responses (the
       sign-in screens need the real message); null = couldn't reach the server */
    apiRaw: function (action, payload, timeoutMs) {
      const ctrl = ('AbortController' in window) ? new AbortController() : null;
      const timer = ctrl && setTimeout(function () { ctrl.abort(); }, timeoutMs || 6000);
      return fetch('api.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        /* the family session token rides along on every call; an explicit
           auth in the payload (e.g. logout) wins over the ambient one */
        body: JSON.stringify(Object.assign(
          { action: action },
          Auth.token ? { auth: Auth.token } : {},
          payload || {}
        )),
        signal: ctrl ? ctrl.signal : undefined,
      }).then(function (res) { return res.json(); })
        .then(function (data) {
          if (data && !data.ok && data.error === 'sign-in required' && action !== 'me') {
            Auth.expire();
          }
          return data || null;
        })
        .catch(function () { return null; })
        .finally(function () { if (timer) clearTimeout(timer); });
    },
    boot: function () {
      const self = this;
      return this.api('ping', {}, 2500).then(function (res) {
        if (res) { self.online = true; return true; }
        /* one retry — a single slow response shouldn't lock the whole session offline */
        return new Promise(function (r) { setTimeout(r, 1200); })
          .then(function () { return self.api('ping', {}, 2500); })
          .then(function (res2) { self.online = !!res2; return self.online; });
      });
    },
    /* words unlocked by the Word Lab live on the server — merge them into the banks.
       Always try the fetch: api() fails safe to null, and a success proves the
       server is reachable even if an earlier call had flagged us offline. */
    loadExtraBank: function () {
      const self = this;
      return this.api('extra-bank').then(function (res) {
        if (!res || !res.items) return 0;
        self.online = true;
        SPELGRAM.registerExtra(res.items);
        return res.items.length;
      });
    },
    canSync: function () {
      return this.online && this.isServerId(currentProfileId) && syncArmed;
    },
    scheduleSync: function () {
      if (!this.canSync()) return;
      const self = this;
      clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(function () { self.pushNow(); }, 1500);
    },
    pushNow: function () {
      clearTimeout(this.syncTimer);
      if (!this.canSync() || !save) {
        return Promise.resolve(null);
      }
      return this.api('save', { id: currentProfileId, save: save });
    },
    flushBeacon: function () {
      if (!this.canSync() || !save) return;
      this.beacon('save', { id: currentProfileId, save: save });
    },
    /* fire-and-forget call for pagehide, where fetch may never leave the tab */
    beacon: function (action, payload) {
      try {
        navigator.sendBeacon('api.php', new Blob(
          [JSON.stringify(Object.assign(
            { action: action },
            Auth.token ? { auth: Auth.token } : {},
            payload || {}
          ))],
          { type: 'text/plain' }
        ));
      } catch (e) {}
    },
  };

  const Profiles = {
    localList: function () {
      try { return JSON.parse(localStorage.getItem(keyLocalProfiles()) || '[]'); } catch (e) { return []; }
    },
    saveLocalList: function (list) {
      try { localStorage.setItem(keyLocalProfiles(), JSON.stringify(list)); } catch (e) {}
    },
    peekSave: function (id) {
      try {
        const raw = localStorage.getItem(keySavePrefix() + id);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },
    dropSaveCache: function (id) {
      try { localStorage.removeItem(keySavePrefix() + id); } catch (e) {}
    },
    summaryOf: function (s) {
      if (!s) return { xp: 0, stars: 0, badges: 0 };
      let stars = 0;
      const levels = asPlainObject(s.levels);
      Object.keys(levels).forEach(function (k) { stars += Number(levels[k] && levels[k].stars) || 0; });
      return { xp: Number(s.xp) || 0, stars: stars, badges: Array.isArray(s.badges) ? s.badges.length : 0 };
    },
    /* profiles created while offline get real server profiles once we're back online */
    promoteLocals: function () {
      const self = this;
      if (!Net.online) return Promise.resolve();
      const locals = this.localList().filter(function (p) { return !Net.isServerId(p.id); });
      let chain = Promise.resolve();
      locals.forEach(function (p) {
        chain = chain.then(function () {
          const blob = self.peekSave(p.id);
          return Net.api('create', { name: p.name, avatar: p.avatar, save: blob || undefined })
            .then(function (res) {
              if (!res) return; /* still offline for this one — keep it local, try next boot */
              const newId = res.profile.id;
              if (blob) {
                try { localStorage.setItem(keySavePrefix() + newId, JSON.stringify(blob)); } catch (e) {}
              }
              try { localStorage.removeItem(keySavePrefix() + p.id); } catch (e) {}
              self.saveLocalList(self.localList().filter(function (q) { return q.id !== p.id; }));
              if (currentProfileId === p.id) {
                currentProfileId = newId;
                try { localStorage.setItem(keyCurrent(), newId); } catch (e) {}
              }
            });
        });
      });
      return chain;
    },
    list: function () {
      const self = this;
      if (Net.online) {
        return this.promoteLocals()
          .then(function () { return Net.api('profiles'); })
          .then(function (res) {
            if (!res) {
              Net.online = false;
              return self.list();
            }
            /* keep any locals that couldn't be promoted — never drop a profile */
            const locals = self.localList().filter(function (p) { return !Net.isServerId(p.id); });
            self.saveLocalList(res.profiles.map(function (p) {
              return { id: p.id, name: p.name, avatar: p.avatar };
            }).concat(locals));
            return res.profiles.concat(locals.map(function (p) {
              return Object.assign({}, p, { summary: self.summaryOf(self.peekSave(p.id)) });
            }));
          });
      }
      return Promise.resolve(this.localList().map(function (p) {
        return Object.assign({}, p, { summary: self.summaryOf(self.peekSave(p.id)) });
      }));
    },
    create: function (name, avatar, initialSave) {
      const self = this;
      function remember(profile) {
        const list = self.localList();
        list.push({ id: profile.id, name: profile.name, avatar: profile.avatar });
        self.saveLocalList(list);
        if (initialSave) {
          try { localStorage.setItem(keySavePrefix() + profile.id, JSON.stringify(initialSave)); } catch (e) {}
        }
        return profile;
      }
      if (Net.online) {
        return Net.api('create', { name: name, avatar: avatar, save: initialSave || undefined })
          .then(function (res) {
            if (res) return remember(res.profile);
            Net.online = false;
            return self.create(name, avatar, initialSave);
          });
      }
      const id = 'local_' + Math.random().toString(36).slice(2, 10);
      return Promise.resolve(remember({ id: id, name: name, avatar: avatar }));
    },
    update: function (id, name, avatar) {
      const list = this.localList();
      list.forEach(function (p) { if (p.id === id) { p.name = name; p.avatar = avatar; } });
      this.saveLocalList(list);
      if (Net.online && Net.isServerId(id)) {
        return Net.api('update', { id: id, name: name, avatar: avatar });
      }
      return Promise.resolve(null);
    },
    select: function (id) {
      const self = this;
      /* flush the previous player's pending progress before switching */
      return Net.pushNow().then(function () {
        syncArmed = false;
        currentProfileId = id;
        try { localStorage.setItem(keyCurrent(), id); } catch (e) {}
        save = null;
        if (!Net.online || !Net.isServerId(id)) return loadSave();
        return Net.api('load', { id: id }).then(function (res) {
          if (!res) {
            /* couldn't read the server copy — go device-only for this session so
               we can never blindly overwrite real progress on the server */
            Net.online = false;
            return loadSave();
          }
          syncArmed = true;
          const local = self.peekSave(id);
          const remote = res.save;
          if (remote && (!local || (remote.updatedAt || 0) >= (local.updatedAt || 0))) {
            hydrate(remote); /* server copy wins — keep it in memory, cache best-effort */
            try { localStorage.setItem(keySavePrefix() + id, JSON.stringify(remote)); } catch (e) {}
            return save;
          }
          if (local) {
            hydrate(local);
            if ((local.updatedAt || 0) > ((remote && remote.updatedAt) || 0)) {
              /* this device played offline — push the newer local copy up */
              Net.api('save', { id: id, save: save });
            }
            return save;
          }
          return loadSave();
        });
      });
    },
    /* re-check the server copy when a backgrounded tab comes back — returns true if the
       in-memory save was replaced by a newer server copy (caller should re-render) */
    resync: function () {
      const id = currentProfileId;
      if (!Net.canSync()) return Promise.resolve(false);
      return Net.api('load', { id: id }).then(function (res) {
        if (!res || id !== currentProfileId) return false;
        const localT = (save && save.updatedAt) || 0;
        const remote = res.save;
        if (remote && (remote.updatedAt || 0) > localT) {
          hydrate(remote);
          try { localStorage.setItem(keySavePrefix() + id, JSON.stringify(remote)); } catch (e) {}
          return true;
        }
        if (localT > ((remote && remote.updatedAt) || 0)) Net.pushNow();
        return false;
      });
    },
    currentId: function () { return currentProfileId; },
    signOut: function () {
      clearTimeout(Net.syncTimer);
      syncArmed = false;
      currentProfileId = null;
      save = null;
      try { localStorage.removeItem(keyCurrent()); } catch (e) {}
    },
    v1Save: function () {
      try {
        const raw = localStorage.getItem(KEY_V1);
        if (!raw) return null;
        const s = JSON.parse(raw);
        return (s && (s.xp > 0 || s.name)) ? s : null;
      } catch (e) { return null; }
    },
    clearV1: function () { try { localStorage.removeItem(KEY_V1); } catch (e) {} },
  };

  function dayKey(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function touchStreak() {
    const s = loadSave();
    const today = dayKey(new Date());
    if (s.lastPlayedDay === today) return;
    const yesterday = dayKey(new Date(Date.now() - 86400000));
    s.streak = (s.lastPlayedDay === yesterday) ? s.streak + 1 : 1;
    s.lastPlayedDay = today;
    persist();
  }

  /* ---------- ranks ---------- */
  const RANKS = [
    { xp: 0, name: 'Wordling', icon: '🌱' },
    { xp: 150, name: 'Letter Learner', icon: '✏️' },
    { xp: 400, name: 'Spell Caster', icon: '✨' },
    { xp: 800, name: 'Word Wizard', icon: '🪄' },
    { xp: 1400, name: 'Grammar Guardian', icon: '🛡️' },
    { xp: 2200, name: 'Spelling Sorcerer', icon: '🔮' },
    { xp: 3200, name: 'NAPLAN Legend', icon: '👑' },
  ];
  function rankFor(xp) { let r = RANKS[0]; RANKS.forEach(function (k) { if (xp >= k.xp) r = k; }); return r; }
  function nextRank(xp) { for (let i = 0; i < RANKS.length; i++) { if (xp < RANKS[i].xp) return RANKS[i]; } return null; }

  /* ---------- level map (curriculum guidance shown before each level) ---------- */
  const LEVELS = [
    { n: 1, title: 'Launch Pad', icon: '🚀',
      spelling: 'Plurals, blends & compound words',
      grammar: 'Capital letters, full stops & naming words',
      tips: [
        'Add -s to most words to make a plural; add -es after s, x, ch or sh (fox → foxes).',
        'Compound words join two small words: rain + bow = rainbow.',
        'Every sentence starts with a capital letter and ends with a full stop.',
      ] },
    { n: 2, title: 'Vowel Valley', icon: '🌈',
      spelling: 'Long vowel teams & first homophones',
      grammar: 'Pronouns, a or an, question marks',
      tips: [
        'Vowel teams like ai, ee, ea and oa make one long sound: beach, train, coach.',
        'Words ending in y usually change to -ies for plurals: baby → babies.',
        'Homophones sound the same but are spelled differently: two, too and to.',
        'Use an before a vowel sound: an echidna, an apple.',
      ] },
    { n: 3, title: 'Suffix City', icon: '🏙️',
      spelling: '-ing, -ed, -er & contractions',
      grammar: 'Past & present tense, commas in lists',
      tips: [
        'Short vowel + one consonant: double the consonant (run → running, stop → stopped).',
        'Magic e words drop the e before -ing (hope → hoping).',
        'An apostrophe shows missing letters: do not → don\'t.',
        'Commas separate items in a list: apples, pears and plums.',
      ] },
    { n: 4, title: 'Prefix Peaks', icon: '⛰️',
      spelling: 'un-, re-, dis-, mis- & -ful, -less, -ly',
      grammar: 'Joining words & adverbs',
      tips: [
        'Prefixes bolt onto the front without changing the base word: mis + spell = misspell.',
        'The suffix -ful always has one l: hopeful, careful.',
        'Joining words like because, although and while glue ideas together.',
        'Adverbs describe HOW something happens and often end in -ly.',
      ] },
    { n: 5, title: 'Shun Station', icon: '🚂',
      spelling: '-tion, -sion, soft c & g, silent letters',
      grammar: 'Apostrophes for owners, prepositions',
      tips: [
        'The "shun" sound is usually -tion (station, invention); -sion after l, n or r, or for a "zhun" sound (television).',
        'C sounds like s before e, i or y: city, centre, circle.',
        'Some letters hide silently: knee, wrist, island, answer.',
        'An apostrophe + s shows an owner: the dog\'s bowl. Plain plurals never get one.',
      ] },
    { n: 6, title: 'Homophone Harbour', icon: '⛵',
      spelling: 'Tricky twins & famous hard words',
      grammar: 'Speech marks & comparing words',
      tips: [
        'their = belonging to them, there = a place, they\'re = they are.',
        'it\'s = it is; its = belonging to it (no apostrophe).',
        'Speech marks hug the exact words spoken: "Let\'s go," said Mia.',
        'Compare with -er/-est or more/most — never both at once.',
      ] },
    { n: 7, title: 'Double Trouble', icon: '🎭',
      spelling: 'Double letters & sneaky vowels',
      grammar: 'Clauses & irregular verbs',
      tips: [
        'necessary: one collar, two socks — one c, two s\'s.',
        'Say words like a robot to hear hidden vowels: sep-a-rate, def-in-ite.',
        'A subordinate clause can\'t stand alone; a comma often follows it at the start.',
        'Irregular verbs change completely: go → went → gone, see → saw → seen.',
      ] },
    { n: 8, title: 'IE/EI Island', icon: '🏝️',
      spelling: 'ie or ei & -ous endings',
      grammar: 'Clear pronouns & tricky agreement',
      tips: [
        'i before e, except after c: believe, but receive. (Weird is weird!)',
        '-ous means "full of": famous, dangerous, curious.',
        'everyone, someone and each are singular: everyone IS here.',
        'Make sure every he, she, it or they clearly points to one person or thing.',
      ] },
    { n: 9, title: 'Root Realm', icon: '🌳',
      spelling: 'Greek & Latin roots + NAPLAN favourites',
      grammar: 'Maybe, must, should — modality',
      tips: [
        'Roots unlock meaning: tele = far, photo = light, aqua = water, port = carry.',
        'environment and government both hide an n: enviroNment, goverNment.',
        'Modal words show how sure we are: must (certain), should (advice), might (possible).',
      ] },
    { n: 10, title: 'Legend League', icon: '🏆',
      spelling: 'Champion words',
      grammar: 'Editor mode — fix anything',
      tips: [
        'The trickiest NAPLAN words live here. Slow down, chunk them, check them.',
        'embarrassed: really red, so double r AND double s.',
        'Read each sentence like an editor: check tense, apostrophes and punctuation one by one.',
      ] },
    { n: 11, title: "Scholar's Peak", icon: '🎓',
      spelling: 'Year 7: -cious, -tial & scholarly words',
      grammar: 'Active vs passive voice, colons & semicolons',
      tips: [
        'The "shus" sound is usually -cious (delicious) or -tious (ambitious); "shul" is -cial after a vowel (special) and -tial after a consonant (essential).',
        'Active voice: the doer comes first (The dog chased the ball). Passive: the action comes first (The ball was chased by the dog).',
        'A semicolon joins two complete sentences that belong together; a colon introduces a list or an explanation.',
      ] },
    { n: 12, title: 'Word Galaxy', icon: '🌌',
      spelling: 'Year 7 stretch: the ultimate words',
      grammar: 'Editor mastery — polish anything',
      tips: [
        'High-school-level words: chunk them into syllables and look for the roots you know.',
        'manoeuvre keeps the French oeu — say man-OEU-vre as you write it.',
        'Two complete sentences need a full stop, a semicolon, or a joining word — a comma alone is a comma splice.',
      ] },
  ];

  /* ---------- badges ---------- */
  const BADGES = [
    { id: 'first-level', name: 'First Steps', icon: '👟', desc: 'Pass your first level',
      when: function (s) { return Object.keys(s.levels).some(function (k) { return s.levels[k].passed; }); } },
    { id: 'perfect', name: 'Perfect 10', icon: '💯', desc: 'Score 10 out of 10',
      when: function (s, c) { return !!c && c.score === 10; } },
    { id: 'no-hints', name: 'All By Myself', icon: '🧠', desc: 'A perfect score with no hints',
      when: function (s, c) { return !!c && c.score === 10 && c.hintsUsed === 0; } },
    { id: 'comeback', name: 'Comeback Kid', icon: '🪃', desc: 'Pass a level after missing out',
      when: function (s, c) { return !!c && c.passed && c.hadFailedBefore; } },
    { id: 'word-50', name: 'Busy Bee', icon: '🐝', desc: '50 correct answers',
      when: function (s) { return s.correctTotal >= 50; } },
    { id: 'word-200', name: 'Bookworm', icon: '📚', desc: '200 correct answers',
      when: function (s) { return s.correctTotal >= 200; } },
    { id: 'spelling-100', name: 'Spelling Star', icon: '🔤', desc: '100 spelling words correct',
      when: function (s) { return s.spellingCorrect >= 100; } },
    { id: 'grammar-100', name: 'Comma Commander', icon: '✒️', desc: '100 grammar questions correct',
      when: function (s) { return s.grammarCorrect >= 100; } },
    { id: 'streak-3', name: 'On Fire', icon: '🔥', desc: 'Practise 3 days in a row',
      when: function (s) { return s.streak >= 3; } },
    { id: 'streak-7', name: 'Unstoppable', icon: '🌋', desc: 'Practise 7 days in a row',
      when: function (s) { return s.streak >= 7; } },
    { id: 'stars-15', name: 'Star Collector', icon: '🌟', desc: 'Collect 15 stars',
      when: function (s) { return totalStars(s) >= 15; } },
    { id: 'halfway', name: 'Halfway Hero', icon: '🗻', desc: 'Pass Level 5',
      when: function (s) { return !!(s.levels['5'] && s.levels['5'].passed); } },
    { id: 'champion', name: 'Spelgram Champion', icon: '👑', desc: 'Pass Level 10',
      when: function (s) { return !!(s.levels['10'] && s.levels['10'].passed); } },
    { id: 'galaxy', name: 'Galaxy Brain', icon: '🌌', desc: 'Conquer Level 12 — Year 7 mastery!',
      when: function (s) { return !!(s.levels['12'] && s.levels['12'].passed); } },
  ];

  function totalStars(s) {
    s = s || loadSave();
    let n = 0;
    Object.keys(s.levels).forEach(function (k) { n += s.levels[k].stars || 0; });
    return n;
  }
  function checkBadges(ctx) {
    const s = loadSave();
    const fresh = [];
    BADGES.forEach(function (b) {
      if (s.badges.indexOf(b.id) === -1 && b.when(s, ctx)) {
        s.badges.push(b.id);
        fresh.push(b);
      }
    });
    if (fresh.length) persist();
    return fresh;
  }

  /* ---------- adaptive sampling: always serve the least-seen items ---------- */
  function pickItems(kind, level, n) {
    const s = loadSave();
    const bank = kind === 'spelling' ? SPELGRAM.spelling : SPELGRAM.grammar;
    let pool = bank.filter(function (it) { return it.level === level; });
    if (pool.length < n * 2) {
      pool = pool.concat(bank.filter(function (it) { return Math.abs(it.level - level) === 1; }));
    }
    const scored = pool.map(function (it) {
      const info = s.seen[it.id] || { n: 0, t: 0 };
      /* times-seen dominates, then least-recently-seen, with random jitter to break ties */
      return { it: it, key: info.n * 1e13 + info.t + Math.random() * 5e8 };
    });
    scored.sort(function (a, b) { return a.key - b.key; });
    return scored.slice(0, n).map(function (x) { return x.it; });
  }

  /* ---------- question builders ---------- */
  function makeSpellingQuestion(item, format) {
    if (format === 'proofread') {
      const q = tryProofread(item);
      if (q) return q;
      format = 'mcspell';
    }
    if (format === 'mcspell') {
      const options = shuffle([item.word].concat((item.wrong || []).slice(0, 3)));
      return { type: 'mcspell', item: item, options: options, answer: options.indexOf(item.word) };
    }
    return { type: 'listen', item: item, answer: item.word };
  }

  const WORD_CORE = /^([^A-Za-z']*)([A-Za-z']+)([^A-Za-z']*)$/;
  function coreOf(token) {
    const m = token.match(WORD_CORE);
    return m ? m[2].toLowerCase() : '';
  }
  function tryProofread(item) {
    if (!item.wrong || !item.wrong.length) return null;
    const words = item.sentence.split(/\s+/);
    let ti = -1;
    for (let i = 0; i < words.length; i++) {
      if (coreOf(words[i]) === item.word.toLowerCase()) { ti = i; break; }
    }
    if (ti < 0) return null;
    const candidates = [];
    words.forEach(function (w, i) {
      const c = coreOf(w);
      if (i !== ti && c.length >= 3) candidates.push(i);
    });
    if (candidates.length < 3) return null;
    const wrongForm = pickRandom(item.wrong);
    const display = words.slice();
    display[ti] = words[ti].replace(WORD_CORE, function (_, pre, core, post) { return pre + wrongForm + post; });
    const clickable = shuffle(candidates).slice(0, 3).concat([ti]).sort(function (a, b) { return a - b; });
    return {
      type: 'proofread', item: item, words: display,
      clickable: clickable, targetIndex: ti, answer: item.word, wrongForm: wrongForm,
    };
  }

  function makeGrammarQuestion(item) {
    const order = shuffle(item.options.map(function (_, i) { return i; }));
    return {
      type: 'grammar', item: item,
      options: order.map(function (i) { return item.options[i]; }),
      answer: order.indexOf(item.answer),
    };
  }

  function buildSession(level) {
    const sp = pickItems('spelling', level, 6);
    const gr = pickItems('grammar', level, 4);
    const formats = shuffle(['listen', 'listen', 'mcspell', 'mcspell', 'proofread',
      pickRandom(['listen', 'mcspell', 'proofread'])]);
    const qs = sp.map(function (item, i) { return makeSpellingQuestion(item, formats[i % formats.length]); });
    gr.forEach(function (item) { qs.push(makeGrammarQuestion(item)); });
    return { level: level, questions: shuffle(qs) };
  }

  /* ---------- scoring ---------- */
  function recordAnswer(item, correct, hintUsed) {
    const s = loadSave();
    const info = s.seen[item.id] || { n: 0, t: 0, w: 0 };
    info.n += 1; info.t = Date.now();
    if (!correct) info.w = (info.w || 0) + 1;
    s.seen[item.id] = info;
    let gained = 0;
    if (correct) {
      gained = hintUsed ? 5 : 10;
      s.xp += gained;
      s.correctTotal += 1;
      if (item.kind === 'spelling') s.spellingCorrect += 1; else s.grammarCorrect += 1;
    }
    persist();
    return gained;
  }

  function finishLevel(level, score, hintsUsed) {
    const s = loadSave();
    const key = String(level);
    const lvl = s.levels[key] || { stars: 0, best: 0, attempts: 0, passed: false, failedOnce: false };
    const hadFailedBefore = lvl.failedOnce;
    const passed = score >= 7;
    const stars = score >= 10 ? 3 : score >= 9 ? 2 : score >= 7 ? 1 : 0;
    lvl.attempts += 1;
    lvl.best = Math.max(lvl.best, score);
    lvl.stars = Math.max(lvl.stars, stars);
    if (passed) lvl.passed = true; else lvl.failedOnce = true;
    s.levels[key] = lvl;
    let bonus = passed ? 50 : 10;
    if (score === 10) bonus += 50;
    s.xp += bonus;
    persist();
    const fresh = checkBadges({ score: score, passed: passed, hadFailedBefore: hadFailedBefore, hintsUsed: hintsUsed, level: level });
    return { stars: stars, passed: passed, bonus: bonus, newBadges: fresh, best: lvl.best };
  }

  function levelUnlocked(n) {
    if (n === 1) return true;
    const s = loadSave();
    const prev = s.levels[String(n - 1)];
    return !!(prev && prev.passed);
  }

  /* ---------- speech (Australian voice preferred) ---------- */
  const Speech = {
    voice: null,
    supported: ('speechSynthesis' in window),
    init: function () {
      if (!this.supported) return;
      const self = this;
      function pick() {
        const vs = window.speechSynthesis.getVoices();
        if (!vs.length) return;
        self.voice =
          vs.find(function (v) { return /en[-_]AU/i.test(v.lang); }) ||
          vs.find(function (v) { return /en[-_]GB/i.test(v.lang); }) ||
          vs.find(function (v) { return /^en/i.test(v.lang); }) || vs[0];
      }
      pick();
      window.speechSynthesis.onvoiceschanged = pick;
    },
    say: function (text, rate) {
      if (!this.supported) return false;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        if (this.voice) u.voice = this.voice;
        u.rate = rate || 0.85;
        u.pitch = 1.02;
        window.speechSynthesis.speak(u);
        return true;
      } catch (e) { return false; }
    },
  };

  /* ---------- sound effects (tiny synth, no files) ---------- */
  const SFX = {
    ctx: null,
    ensure: function () {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { try { this.ctx = new AC(); } catch (e) {} }
      }
      if (this.ctx && this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) {} }
      return this.ctx;
    },
    tone: function (freq, at, dur, type, vol) {
      const ctx = this.ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol || 0.18, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(at); o.stop(at + dur + 0.05);
    },
    play: function (name) {
      if (!loadSave().sound) return;
      const ctx = this.ensure();
      if (!ctx) return;
      try {
        const t = ctx.currentTime;
        if (name === 'correct') { this.tone(660, t, 0.12, 'sine'); this.tone(880, t + 0.1, 0.22, 'sine'); }
        else if (name === 'wrong') { this.tone(196, t, 0.25, 'triangle', 0.12); }
        else if (name === 'click') { this.tone(520, t, 0.05, 'sine', 0.06); }
        else if (name === 'fanfare') {
          const notes = [523, 659, 784, 1047];
          for (let i = 0; i < notes.length; i++) this.tone(notes[i], t + i * 0.13, 0.28, 'triangle', 0.14);
        }
        else if (name === 'badge') { this.tone(784, t, 0.1, 'sine'); this.tone(988, t + 0.09, 0.1, 'sine'); this.tone(1319, t + 0.18, 0.3, 'sine'); }
      } catch (e) {}
    },
  };

  /* ---------- confetti ---------- */
  const Confetti = {
    canvas: null, ctx: null, parts: [], running: false,
    COLOURS: ['#a78bfa', '#8b5cf6', '#f0abfc', '#fbbf24', '#34d399', '#f9a8d4', '#c4b5fd'],
    init: function (canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      const self = this;
      function fit() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
      fit();
      window.addEventListener('resize', fit);
    },
    burst: function (n, yFrac) {
      if (!this.ctx) return;
      const w = this.canvas.width;
      const y0 = this.canvas.height * (yFrac == null ? 0.35 : yFrac);
      for (let i = 0; i < n; i++) {
        this.parts.push({
          x: w * (0.2 + Math.random() * 0.6),
          y: y0 + (Math.random() - 0.5) * 60,
          vx: (Math.random() - 0.5) * 9,
          vy: -(4 + Math.random() * 7),
          s: 5 + Math.random() * 6,
          r: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 0.3,
          c: pickRandom(this.COLOURS),
          life: 90 + Math.random() * 60,
        });
      }
      if (!this.running) { this.running = true; this.loop(); }
    },
    loop: function () {
      const self = this;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.parts = this.parts.filter(function (p) { return p.life > 0 && p.y < self.canvas.height + 40; });
      this.parts.forEach(function (p) {
        p.x += p.vx; p.y += p.vy; p.vy += 0.22; p.r += p.vr; p.life -= 1;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 40));
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
        ctx.restore();
      });
      if (this.parts.length) {
        requestAnimationFrame(function () { self.loop(); });
      } else {
        this.running = false;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    },
  };

  /* ---------- public API ---------- */
  window.Spelgram = {
    data: SPELGRAM, itemById: itemById,
    LEVELS: LEVELS, RANKS: RANKS, BADGES: BADGES,
    shuffle: shuffle, normalise: normalise, pickRandom: pickRandom,
    loadSave: loadSave, persist: persist, resetSave: resetSave, touchStreak: touchStreak,
    rankFor: rankFor, nextRank: nextRank, totalStars: totalStars,
    buildSession: buildSession, recordAnswer: recordAnswer, finishLevel: finishLevel,
    levelUnlocked: levelUnlocked,
    Speech: Speech, SFX: SFX, Confetti: Confetti,
    Net: Net, Profiles: Profiles, Auth: Auth,
  };
})();
