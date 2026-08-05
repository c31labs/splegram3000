/* Spelgram 3000 — UI: screens, question rendering, feedback, gamification */
(function () {
  'use strict';

  const E = window.Spelgram;
  const $ = function (id) { return document.getElementById(id); };

  const PRAISE = ['Ripper!', 'You beauty!', 'Too easy!', 'Bonza!', 'Legend!', 'Nailed it!', 'Sensational!'];
  const ENCOURAGE = ['Not quite — let\'s learn it!', 'So close! Here\'s the trick:', 'Good try! Check this out:', 'No worries — now you\'ll know it!'];
  const MASCOT_LINES = [
    'G\'day! Ready to power up your spelling?',
    'Every word you learn makes you stronger! 💪',
    'Wizards check their work — and so do you!',
    'A little practice every day beats a lot once a year!',
    'Which level are we conquering today?',
  ];
  const AVATARS = ['🦄', '🐨', '🦋', '🐶', '🌟', '🧁', '🐢', '🦜'];

  /* ---------------- state ---------------- */
  let session = null;   /* {level, questions} */
  let qIndex = 0;
  let score = 0;
  let sessionXP = 0;
  let hintsUsed = 0;
  let wrongStreak = 0;
  let answered = false;
  let hintShown = false;
  let proofreadPick = -1; /* selected word index in proofread */
  let results = []; /* true/false per question */

  /* ---------------- screens ---------------- */
  const SCREENS = ['screen-profiles', 'screen-home', 'screen-play', 'screen-results', 'screen-trophies', 'screen-parent'];
  function show(id) {
    SCREENS.forEach(function (s) { $(s).hidden = (s !== id); });
    window.scrollTo(0, 0);
  }
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  /* ---------------- home ---------------- */
  function renderHome() {
    const s = E.loadSave();
    $('home-name').textContent = s.name || 'Player';
    $('home-avatar').textContent = s.avatar;
    $('streak-count').textContent = s.streak;
    $('home-stars').textContent = '⭐ ' + E.totalStars(s);
    const rank = E.rankFor(s.xp);
    const next = E.nextRank(s.xp);
    $('home-rank').textContent = rank.icon + ' ' + rank.name;
    const base = rank.xp;
    const target = next ? next.xp : Math.max(s.xp, base + 1);
    const frac = next ? (s.xp - base) / (target - base) : 1;
    $('home-xpfill').style.width = Math.round(frac * 100) + '%';
    $('home-xptext').textContent = next
      ? s.xp + ' XP · ' + (next.xp - s.xp) + ' to ' + next.icon + ' ' + next.name
      : s.xp + ' XP · Top rank!';
    $('mascot-line').textContent = E.pickRandom(MASCOT_LINES);
    renderMap();
  }

  function renderMap() {
    const s = E.loadSave();
    const map = $('level-map');
    map.innerHTML = '';
    E.LEVELS.forEach(function (lv) {
      const unlocked = E.levelUnlocked(lv.n);
      const prog = s.levels[String(lv.n)];
      const node = document.createElement('button');
      node.className = 'level-node' + (unlocked ? '' : ' locked') + (prog && prog.passed ? ' passed' : '');
      node.setAttribute('aria-label', 'Level ' + lv.n + ': ' + lv.title + (unlocked ? '' : ' (locked)'));
      const stars = prog ? prog.stars : 0;
      node.innerHTML =
        '<span class="ln-icon">' + (unlocked ? lv.icon : '🔒') + '</span>' +
        '<span class="ln-num">Level ' + lv.n + '</span>' +
        '<span class="ln-title">' + lv.title + '</span>' +
        '<span class="ln-stars">' +
          [1, 2, 3].map(function (i) { return '<i class="' + (i <= stars ? 'on' : '') + '">★</i>'; }).join('') +
        '</span>';
      if (unlocked) {
        node.addEventListener('click', function () { E.SFX.play('click'); openLevelIntro(lv); });
      }
      map.appendChild(node);
    });
  }

  /* ---------------- level intro (curriculum guidance) ---------------- */
  let pendingLevel = null;
  function openLevelIntro(lv) {
    pendingLevel = lv;
    $('li-icon').textContent = lv.icon;
    $('li-title').textContent = 'Level ' + lv.n + ' · ' + lv.title;
    $('li-focus').innerHTML = '🔤 ' + lv.spelling + '<br>✒️ ' + lv.grammar;
    $('li-tips').innerHTML = lv.tips.map(function (t) {
      return '<div class="tip">💡 ' + t + '</div>';
    }).join('');
    openModal('modal-level');
  }

  /* ---------------- session ---------------- */
  function startLevel(levelN) {
    session = E.buildSession(levelN);
    if (!session.questions.length) return;
    qIndex = 0; score = 0; sessionXP = 0; hintsUsed = 0; wrongStreak = 0;
    results = [];
    E.touchStreak();
    show('screen-play');
    renderQuestion();
  }

  function currentQ() { return session.questions[qIndex]; }

  function renderDots() {
    const dots = $('progress-dots');
    dots.innerHTML = '';
    session.questions.forEach(function (_, i) {
      const d = document.createElement('span');
      d.className = 'dot' +
        (i < results.length ? (results[i] ? ' good' : ' bad') : '') +
        (i === qIndex ? ' now' : '');
      dots.appendChild(d);
    });
  }

  function renderQuestion() {
    const q = currentQ();
    answered = false; hintShown = false; proofreadPick = -1;
    $('feedback').hidden = true;
    $('q-card').hidden = false;
    $('hintbox').hidden = true;
    $('btn-hint').hidden = false;
    $('btn-check').hidden = false;
    $('btn-check').disabled = true;
    $('session-xp').textContent = sessionXP;
    $('q-count').textContent = (qIndex + 1) + ' / ' + session.questions.length;
    $('q-tag').textContent = q.item.kind === 'spelling' ? '🔤 Spelling' : '✒️ Grammar';
    $('q-tag').className = 'q-tag ' + (q.item.kind === 'spelling' ? 'tag-sp' : 'tag-gr');
    renderDots();

    const body = $('q-body');
    body.innerHTML = '';

    if (q.type === 'listen') renderListen(q, body);
    else if (q.type === 'mcspell') renderMcSpell(q, body);
    else if (q.type === 'proofread') renderProofread(q, body);
    else renderGrammar(q, body);

    /* struggling? auto-show the hint as guidance */
    if (wrongStreak >= 2) revealHint(true);
  }

  /* ---- format renderers ---- */
  function blankSentence(sentence, word) {
    const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    return sentence.replace(re, '<span class="blank">_____</span>');
  }

  function renderListen(q, body) {
    body.innerHTML =
      '<p class="q-prompt">Listen and type the word</p>' +
      '<div class="listen-btns">' +
        '<button class="btn btn-speak" id="btn-say-word">🔊 Hear the word</button>' +
        '<button class="btn btn-ghost btn-sm" id="btn-say-sentence">💬 In a sentence</button>' +
        '<button class="btn btn-ghost btn-sm" id="btn-say-slow">🐢 Slowly</button>' +
      '</div>' +
      '<p class="q-sentence">' + blankSentence(q.item.sentence, q.item.word) + '</p>' +
      '<p class="q-clue">Clue: ' + q.item.definition + '</p>' +
      '<input type="text" id="answer-input" class="answer-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type the word here">';
    $('btn-say-word').addEventListener('click', function () { E.Speech.say(q.item.word); });
    $('btn-say-sentence').addEventListener('click', function () { E.Speech.say(q.item.sentence, 0.95); });
    $('btn-say-slow').addEventListener('click', function () { E.Speech.say(q.item.word, 0.55); });
    wireInput();
    if (!E.Speech.supported) {
      $('btn-say-word').disabled = true;
      $('btn-say-word').textContent = '🔇 No voice on this device';
    } else {
      setTimeout(function () { E.Speech.say(q.item.word); }, 350);
    }
  }

  function renderMcSpell(q, body) {
    body.innerHTML =
      '<p class="q-prompt">Which spelling is correct?</p>' +
      '<p class="q-sentence">' + blankSentence(q.item.sentence, q.item.word) + '</p>' +
      '<p class="q-clue">Clue: ' + q.item.definition + '</p>' +
      '<div class="options" id="options"></div>';
    renderOptions(q.options);
  }

  function renderProofread(q, body) {
    let html = '<p class="q-prompt">One word is spelled wrongly. Tap it, then fix it!</p><p class="q-sentence proofread-sentence">';
    q.words.forEach(function (w, i) {
      if (q.clickable.indexOf(i) !== -1) {
        html += '<button class="pr-word" data-i="' + i + '">' + w + '</button> ';
      } else {
        html += '<span>' + w + '</span> ';
      }
    });
    html += '</p><div id="pr-fix" hidden>' +
      '<p class="q-clue">Now type the correct spelling:</p>' +
      '<input type="text" id="answer-input" class="answer-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Correct spelling">' +
      '</div>';
    body.innerHTML = html;
    Array.prototype.forEach.call(body.querySelectorAll('.pr-word'), function (btn) {
      btn.addEventListener('click', function () {
        if (answered) return;
        E.SFX.play('click');
        Array.prototype.forEach.call(body.querySelectorAll('.pr-word'), function (b) { b.classList.remove('sel'); });
        btn.classList.add('sel');
        proofreadPick = parseInt(btn.getAttribute('data-i'), 10);
        $('pr-fix').hidden = false;
        const inp = $('answer-input');
        inp.focus();
        $('btn-check').disabled = inp.value.trim() === '';
      });
    });
    wireInput();
  }

  function renderGrammar(q, body) {
    const it = q.item;
    let html = '<p class="q-prompt">' + it.prompt + '</p>';
    if (it.sentence) {
      html += '<p class="q-sentence">' + it.sentence.replace('___', '<span class="blank">_____</span>') + '</p>';
    }
    html += '<div class="options' + (it.format === 'sentence-choice' ? ' options-stack' : '') + '" id="options"></div>';
    body.innerHTML = html;
    renderOptions(q.options);
  }

  let selectedOption = -1;
  function renderOptions(options) {
    selectedOption = -1;
    const wrap = $('options');
    options.forEach(function (opt, i) {
      const b = document.createElement('button');
      b.className = 'opt';
      b.textContent = opt;
      b.addEventListener('click', function () {
        if (answered) return;
        E.SFX.play('click');
        Array.prototype.forEach.call(wrap.children, function (c) { c.classList.remove('sel'); });
        b.classList.add('sel');
        selectedOption = i;
        $('btn-check').disabled = false;
      });
      wrap.appendChild(b);
    });
  }

  function wireInput() {
    const inp = $('answer-input');
    if (!inp) return;
    inp.addEventListener('input', function () {
      $('btn-check').disabled = inp.value.trim() === '' ||
        (currentQ().type === 'proofread' && proofreadPick === -1);
    });
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !$('btn-check').disabled && !answered) checkAnswer();
    });
    if (currentQ().type === 'listen') inp.focus();
  }

  /* ---------------- hint ---------------- */
  function revealHint(auto) {
    const q = currentQ();
    if (hintShown) return;
    hintShown = true;
    if (!auto) hintsUsed += 1;
    $('hint-text').textContent = q.item.hint + (auto ? ' (free hint — you\'ve got this!)' : '');
    $('hintbox').hidden = false;
    $('btn-hint').hidden = true;
  }

  /* ---------------- checking ---------------- */
  function checkAnswer() {
    if (answered) return;
    const q = currentQ();
    let correct = false;

    if (q.type === 'listen') {
      correct = E.normalise($('answer-input').value) === E.normalise(q.answer);
    } else if (q.type === 'proofread') {
      const typedOk = E.normalise($('answer-input').value) === E.normalise(q.answer);
      correct = (proofreadPick === q.targetIndex) && typedOk;
    } else {
      correct = selectedOption === q.answer;
    }

    answered = true;
    $('btn-check').hidden = true;
    $('btn-hint').hidden = true;
    results.push(correct);
    const hinted = hintShown && hintsUsed > 0;
    const gained = E.recordAnswer(q.item, correct, hinted);
    sessionXP += gained;
    if (correct) { score += 1; wrongStreak = 0; } else { wrongStreak += 1; }

    markOptions(q, correct);
    showFeedback(q, correct, gained);
  }

  function markOptions(q, correct) {
    const wrap = $('options');
    if (wrap && (q.type === 'mcspell' || q.type === 'grammar')) {
      Array.prototype.forEach.call(wrap.children, function (c, i) {
        c.disabled = true;
        if (i === q.answer) c.classList.add('right');
        else if (i === selectedOption && !correct) c.classList.add('wrongpick');
      });
    }
    if (q.type === 'proofread') {
      Array.prototype.forEach.call(document.querySelectorAll('.pr-word'), function (b) {
        b.disabled = true;
        if (parseInt(b.getAttribute('data-i'), 10) === q.targetIndex) b.classList.add('right');
      });
    }
    const inp = $('answer-input');
    if (inp) inp.disabled = true;
  }

  function showFeedback(q, correct, gained) {
    const head = $('feedback-head');
    const body = $('feedback-body');
    const it = q.item;

    if (correct) {
      E.SFX.play('correct');
      E.Confetti.burst(26, 0.45);
      head.textContent = '🎉 ' + E.pickRandom(PRAISE) + '  +' + gained + ' XP';
      head.className = 'feedback-head good';
      if (it.kind === 'spelling') {
        body.innerHTML = '<p><b class="word-glow">' + it.word + '</b> — ' + it.definition + '</p>' +
          '<p class="rule-chip">📏 ' + it.hint + '</p>';
      } else {
        body.innerHTML = '<p>' + it.explanation + '</p>';
      }
    } else {
      E.SFX.play('wrong');
      head.textContent = '💜 ' + E.pickRandom(ENCOURAGE);
      head.className = 'feedback-head bad';
      if (it.kind === 'spelling') {
        let extra = '';
        if (q.type === 'listen' || q.type === 'proofread') {
          const typed = $('answer-input') ? $('answer-input').value.trim() : '';
          if (typed && E.normalise(typed) !== E.normalise(it.word)) {
            extra = '<p class="you-wrote">You wrote: <s>' + escapeHtml(typed) + '</s></p>';
          }
        }
        body.innerHTML = extra +
          '<p>The correct spelling is <b class="word-glow">' + it.word + '</b> — ' + it.definition + '</p>' +
          '<p class="rule-chip">📏 ' + it.hint + '</p>' +
          '<p class="try-say">Try saying it: <b>' + syllableise(it.word) + '</b></p>';
      } else {
        body.innerHTML = '<p>The answer is <b class="word-glow">' + escapeHtml(it.options[it.answer]) + '</b></p>' +
          '<p class="rule-chip">📏 ' + it.explanation + '</p>';
      }
    }
    $('btn-next').textContent = (qIndex + 1 >= session.questions.length) ? 'See results 🏁' : 'Next ➜';
    $('feedback').hidden = false;
    renderDots();
    $('feedback').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function syllableise(word) {
    /* naive chunking for "say it in chunks" support */
    return word.replace(/([aeiouy]+[^aeiouy\s]*)/gi, '$1·').replace(/·$/, '').replace(/·'/g, "'");
  }

  function nextQuestion() {
    qIndex += 1;
    if (qIndex >= session.questions.length) endLevel();
    else renderQuestion();
  }

  /* ---------------- results ---------------- */
  function endLevel() {
    const total = session.questions.length;
    const res = E.finishLevel(session.level, score, hintsUsed);
    sessionXP += res.bonus;

    show('screen-results');
    const starsEls = document.querySelectorAll('#results-stars .rstar');
    Array.prototype.forEach.call(starsEls, function (el, i) {
      el.classList.remove('lit', 'pop');
      if (i < res.stars) {
        setTimeout(function () { el.classList.add('lit', 'pop'); E.SFX.play('badge'); }, 400 + i * 450);
      }
    });

    const lv = E.LEVELS[session.level - 1];
    const topLevel = E.LEVELS.length;
    if (res.passed) {
      E.SFX.play('fanfare');
      E.Confetti.burst(80, 0.3);
      setTimeout(function () { E.Confetti.burst(60, 0.2); }, 600);
      $('results-title').textContent = lv.icon + ' Level ' + session.level + ' complete!';
      $('results-sub').textContent = score === 10
        ? 'PERFECT! You\'re absolutely flying! 🚀'
        : 'You passed! ' + (session.level < topLevel ? 'Level ' + (session.level + 1) + ' is now unlocked!' : 'You\'ve conquered them all!');
      $('btn-continue').textContent = session.level < topLevel ? 'Next level ➜' : 'Back to map 🗺️';
    } else {
      $('results-title').textContent = '💪 So close!';
      $('results-sub').textContent = 'You need 7 to pass. Have another go — you\'ll get a brand-new set of questions!';
      $('btn-continue').textContent = 'Back to map 🗺️';
    }
    $('results-score').textContent = score + ' / ' + total;
    $('results-xp').textContent = '+' + sessionXP + ' XP';

    const bWrap = $('results-badges');
    bWrap.innerHTML = '';
    res.newBadges.forEach(function (b, i) {
      const el = document.createElement('div');
      el.className = 'badge-pop';
      el.innerHTML = '<span class="badge-pop-icon">' + b.icon + '</span><div><b>' + b.name + '</b><br><small>' + b.desc + '</small></div>';
      bWrap.appendChild(el);
      setTimeout(function () { el.classList.add('in'); E.SFX.play('badge'); }, 1500 + i * 500);
    });

    $('btn-continue').onclick = function () {
      E.SFX.play('click');
      if (res.passed && session.level < E.LEVELS.length) openLevelIntro(E.LEVELS[session.level]);
      show('screen-home');
      renderHome();
    };
  }

  /* ---------------- trophy room ---------------- */
  function renderTrophies() {
    const s = E.loadSave();
    const grid = $('badge-grid');
    grid.innerHTML = '';
    let earned = 0;
    E.BADGES.forEach(function (b) {
      const has = s.badges.indexOf(b.id) !== -1;
      if (has) earned += 1;
      const el = document.createElement('div');
      el.className = 'badge-card' + (has ? ' earned' : '');
      el.innerHTML = '<span class="badge-icon">' + (has ? b.icon : '🔒') + '</span>' +
        '<b>' + b.name + '</b><small>' + b.desc + '</small>';
      grid.appendChild(el);
    });
    $('trophy-count').textContent = earned + ' / ' + E.BADGES.length;
  }

  /* ---------------- profiles ---------------- */
  async function bootProfiles() {
    let profiles = await E.Profiles.list();

    /* upgrading from v1: adopt progress already on this device (unless a player
       with that name already exists — then leave the old save untouched) */
    const v1 = E.Profiles.v1Save();
    if (v1) {
      const v1name = v1.name || 'Player';
      const clash = profiles.find(function (p) { return p.name === v1name; });
      if (!clash) {
        v1.updatedAt = Date.now();
        const p = await E.Profiles.create(v1name, v1.avatar || '🦄', v1);
        E.Profiles.clearV1();
        await enterProfile(p);
        return;
      }
    }

    const cur = E.Profiles.currentId();
    const mine = profiles.find(function (p) { return p.id === cur; });
    if (mine) { await enterProfile(mine); return; }
    renderProfilePicker(profiles);
  }

  let enteringProfile = false;
  async function enterProfile(p) {
    if (enteringProfile) return;
    enteringProfile = true;
    try {
      await E.Profiles.select(p.id);
      const s = E.loadSave();
      /* only stamp brand-new saves — an untouched entry must not bump updatedAt,
         or this copy would wrongly win merges against real progress elsewhere */
      if (!s.name) {
        s.name = p.name || 'Player';
        if (p.avatar) s.avatar = p.avatar;
        E.persist();
      }
      renderHome();
      show('screen-home');
    } finally {
      enteringProfile = false;
    }
  }

  function renderProfilePicker(profiles) {
    const grid = $('profile-grid');
    grid.innerHTML = '';
    profiles.forEach(function (p) {
      const sum = p.summary || E.Profiles.summaryOf(E.Profiles.peekSave(p.id));
      const card = document.createElement('button');
      card.className = 'profile-card';
      card.innerHTML =
        '<span class="profile-avatar">' + p.avatar + '</span>' +
        '<b>' + escapeHtml(p.name) + '</b>' +
        '<small>⭐ ' + sum.stars + ' · ✨ ' + sum.xp + ' XP</small>';
      card.addEventListener('click', function () {
        E.SFX.play('click');
        /* freeze the whole picker so a second tap can't cross-load another profile */
        Array.prototype.forEach.call(grid.children, function (c) { c.disabled = true; });
        enterProfile(p);
      });
      grid.appendChild(card);
    });
    const add = document.createElement('button');
    add.className = 'profile-card profile-add';
    add.innerHTML = '<span class="profile-avatar">➕</span><b>New player</b><small>Join the fun!</small>';
    add.addEventListener('click', function () {
      E.SFX.play('click');
      openNameModal(false);
    });
    grid.appendChild(add);
    show('screen-profiles');
  }

  async function goToProfilePicker() {
    await E.Net.pushNow();
    E.Profiles.signOut();
    const grid = $('profile-grid');
    grid.innerHTML = '<p class="profiles-loading">Loading players…</p>';
    show('screen-profiles');
    renderProfilePicker(await E.Profiles.list());
  }

  /* ---------------- name modal (create or rename) ---------------- */
  let nameModalRename = false;
  function openNameModal(isRename) {
    nameModalRename = !!isRename;
    const s = isRename ? E.loadSave() : { name: '', avatar: AVATARS[0] };
    $('name-input').value = s.name || '';
    document.querySelector('#modal-name h2').textContent =
      isRename ? 'Change your name & buddy ✏️' : 'Welcome to Spelgram 3000! 🔮';
    $('btn-name-go').textContent = isRename ? 'Save ✔' : "Let's go! 🚀";
    const row = $('avatar-row');
    row.innerHTML = '';
    AVATARS.forEach(function (a) {
      const b = document.createElement('button');
      b.className = 'avatar-pick' + (a === s.avatar ? ' sel' : '');
      b.textContent = a;
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(row.children, function (c) { c.classList.remove('sel'); });
        b.classList.add('sel');
        E.SFX.play('click');
      });
      row.appendChild(b);
    });
    openModal('modal-name');
    if (!isRename) $('name-input').focus();
  }

  /* ---------------- Word Lab ---------------- */
  const BREW_MSGS = [
    'Catching wild words in the word net… 🦋',
    'Teaching new words their manners… 📚',
    'Stirring in tricky letters… 🥄',
    'Polishing the shiniest sentences… ✨',
    'Sorting words into the right levels… 🗂️',
    'Adding a pinch of grammar dust… 🧂',
  ];
  let brewing = false;

  async function openWordLab() {
    const status = await E.Net.api('refresh-status');
    $('wordlab-intro').hidden = false;
    $('wordlab-progress').hidden = true;
    $('wordlab-done').hidden = true;
    const brewBtn = $('btn-lab-brew');
    if (!status) {
      $('lab-stats').textContent = '📴 The Word Lab needs the internet — try again later!';
      brewBtn.disabled = true;
    } else if (status.waitSeconds > 0) {
      const h = Math.ceil(status.waitSeconds / 3600);
      $('lab-stats').textContent = '⏳ The cauldron is still recharging — come back in about ' +
        (h <= 1 ? 'an hour' : h + ' hours') + '!';
      brewBtn.disabled = true;
    } else if (status.exhausted) {
      $('lab-stats').textContent = '🧙 The word wizards are cooking up more — ask a grown-up to check the Parent zone!';
      brewBtn.disabled = true;
    } else {
      $('lab-stats').textContent = '✨ ' + status.extraCount + ' bonus words unlocked so far. Ready for more?';
      brewBtn.disabled = false;
    }
    openModal('modal-wordlab');
  }

  async function brew(parentToken) {
    if (brewing) return 0;
    brewing = true;
    $('wordlab-intro').hidden = true;
    $('wordlab-done').hidden = true;
    $('wordlab-progress').hidden = false;
    $('brew-fill').style.width = '4%';
    $('brew-pct').textContent = '0%';
    let added = 0, merged = 0, msgIdx = 0, failed = false;
    const msgTimer = setInterval(function () {
      msgIdx = (msgIdx + 1) % BREW_MSGS.length;
      $('brew-msg').textContent = BREW_MSGS[msgIdx];
    }, 2600);
    try {
      for (let step = 1; step <= 4; step++) {
        const payload = { step: step, total: 4 };
        if (parentToken) payload.parentToken = parentToken;
        /* each step takes at least a beat, so the cauldron feels properly magical */
        const results = await Promise.all([
          E.Net.api('refresh-step', payload, 120000),
          new Promise(function (r) { setTimeout(r, 1100); }),
        ]);
        const res = results[0];
        if (!res) {
          if (step === 1) failed = true;
        } else {
          added += res.added || 0;
        }
        const pct = Math.round((step / 4) * 100);
        $('brew-fill').style.width = pct + '%';
        $('brew-pct').textContent = pct + '%';
        if (failed) break;
      }
      if (added > 0) merged = await E.Net.loadExtraBank();
    } finally {
      clearInterval(msgTimer);
      brewing = false;
    }
    $('wordlab-progress').hidden = true;
    $('wordlab-done').hidden = false;
    if (added > 0) {
      E.SFX.play('fanfare');
      E.Confetti.burst(70, 0.3);
      $('lab-done-title').textContent = '🎉 Fresh words delivered!';
      $('lab-done-msg').textContent = added + ' brand-new questions just joined your levels. ' +
        (merged > 0 ? 'The game has reshuffled itself — go find them!'
                    : 'They\'ll appear the next time the game loads!');
    } else if (failed) {
      $('lab-done-title').textContent = '⏳ Not just yet!';
      $('lab-done-msg').textContent = 'The cauldron needs a rest. Come back a bit later!';
    } else {
      $('lab-done-title').textContent = '🧙 All brewed out!';
      $('lab-done-msg').textContent = 'Every word in the vault is already unlocked. Ask a grown-up to open the Parent zone for more magic.';
    }
    return added;
  }

  /* ---------------- parent zone: PIN pad ---------------- */
  /* The parent session lives in memory ONLY — never in storage. A reload, a new
     tab, or leaving the parent zone all drop it, so the code is asked for again.
     Kids must never inherit an open parent session on a shared device. */
  const Parent = {
    token: '',
    lock: function () {
      const old = this.token;
      this.token = '';
      if (old) E.Net.api('parent-logout', { token: old }); /* invalidate server-side too */
    },
  };
  let pinEntry = '', pinFirst = null, pinMode = 'login', pinOnSuccess = null;

  function renderPinDots() {
    const dots = $('pin-dots');
    dots.innerHTML = '';
    for (let i = 0; i < 8; i++) {
      if (i < pinEntry.length) { dots.innerHTML += '<span class="pd on">●</span>'; }
      else if (i < 4) { dots.innerHTML += '<span class="pd">○</span>'; }
    }
  }

  function openPinModal(mode, onSuccess) {
    pinMode = mode; pinOnSuccess = onSuccess;
    pinEntry = ''; pinFirst = null;
    $('pin-error').hidden = true;
    $('pin-title').textContent = mode === 'login' ? '🔒 Parent zone'
      : mode === 'change' ? '🔐 Change the parent code' : '🔐 Create a parent code';
    $('pin-sub').textContent = mode === 'login'
      ? 'Enter your parent code (4–8 digits).'
      : 'Choose a 4–8 digit code only grown-ups know.';
    renderPinDots();
    const pad = $('pin-pad');
    if (!pad.childElementCount) {
      ['1','2','3','4','5','6','7','8','9','⌫','0','✓'].forEach(function (k) {
        const b = document.createElement('button');
        b.className = 'pin-key' + (k === '✓' ? ' pin-ok' : '');
        b.textContent = k;
        b.addEventListener('click', function () { pinKey(k); });
        pad.appendChild(b);
      });
    }
    openModal('modal-pin');
  }

  async function pinKey(k) {
    E.SFX.play('click');
    $('pin-error').hidden = true;
    if (k === '⌫') { pinEntry = pinEntry.slice(0, -1); renderPinDots(); return; }
    if (k !== '✓') {
      if (pinEntry.length < 8) pinEntry += k;
      renderPinDots();
      return;
    }
    if (pinEntry.length < 4) { showPinError('The code needs at least 4 digits.'); return; }
    if (pinMode === 'login') {
      const res = await E.Net.api('parent-login', { pin: pinEntry });
      if (res && res.token) {
        Parent.token = res.token;
        closeModal('modal-pin');
        if (pinOnSuccess) pinOnSuccess();
      } else {
        showPinError('That code isn\'t right. Try again.');
        pinEntry = ''; renderPinDots();
      }
      return;
    }
    /* setup / change: ask twice */
    if (pinFirst === null) {
      pinFirst = pinEntry; pinEntry = '';
      $('pin-sub').textContent = 'Type the same code again to confirm.';
      renderPinDots();
      return;
    }
    if (pinFirst !== pinEntry) {
      showPinError('The codes didn\'t match — start again.');
      pinFirst = null; pinEntry = '';
      $('pin-sub').textContent = 'Choose a 4–8 digit code only grown-ups know.';
      renderPinDots();
      return;
    }
    const action = pinMode === 'setup' ? 'parent-setup' : 'parent-change-pin';
    const payload = pinMode === 'setup' ? { pin: pinEntry } : { token: Parent.token, newPin: pinEntry };
    const res = await E.Net.api(action, payload);
    if (res) {
      if (res.token) Parent.token = res.token;
      closeModal('modal-pin');
      if (pinOnSuccess) pinOnSuccess();
    } else {
      showPinError('Something went wrong — try again.');
      pinFirst = null; pinEntry = ''; renderPinDots();
    }
  }

  function showPinError(msg) {
    $('pin-error').textContent = msg;
    $('pin-error').hidden = false;
  }

  /* re-verify the parent token before an authenticated action; re-login if expired.
     (parent-set-key with only a token is a side-effect-free probe on the server) */
  async function withValidParentToken(then) {
    if (Parent.token) {
      const probe = await E.Net.api('parent-set-key', { token: Parent.token });
      if (probe) { then(); return; }
      Parent.token = '';
    }
    openPinModal('login', then);
  }

  /* ---------------- parent zone: dashboard ---------------- */
  async function openParentZone() {
    if (!E.Net.online) {
      window.alert('The Parent zone needs the internet connection to your website.');
      return;
    }
    const status = await E.Net.api('parent-status');
    if (!status) { window.alert('Could not reach the server.'); return; }
    const enter = function () { showParentZone(); };
    if (!status.pinSet) { openPinModal('setup', enter); return; }
    withValidParentToken(enter);
  }

  async function showParentZone() {
    show('screen-parent');
    $('parent-content').innerHTML = '<p class="parent-loading">Loading family stats…</p>';
    const status = await E.Net.api('refresh-status');
    $('parent-lab-note').textContent = status
      ? (status.extraCount + ' bonus items unlocked · ' + status.reservoirLeft + ' still in the vault' +
         (status.aiConfigured ? ' · AI generation ON (' : ' · AI generation off (') +
         (status.aiConfigured ? 'magic key set)' : 'no magic key)'))
      : '';
    const pstat = await E.Net.api('parent-status');
    $('magic-key-state').textContent = pstat && pstat.aiConfigured
      ? '✅ Key configured — Word Lab writes brand-new questions with AI'
      : 'No key set — Word Lab unlocks from the built-in vault';

    const profiles = await E.Profiles.list();
    const cards = [];
    for (const p of profiles) {
      let save = null;
      if (E.Net.isServerId(p.id)) {
        const res = await E.Net.api('load', { id: p.id });
        save = res && res.save;
      } else {
        save = E.Profiles.peekSave(p.id);
      }
      cards.push(renderChildCard(p, save));
    }
    $('parent-content').innerHTML = cards.join('') ||
      '<p class="parent-loading">No players yet — create one on the "Who\'s playing?" screen.</p>';

    /* wire per-child action buttons */
    Array.prototype.forEach.call(document.querySelectorAll('[data-pact]'), function (btn) {
      btn.addEventListener('click', function () {
        handleParentAction(btn.getAttribute('data-pact'), btn.getAttribute('data-pid'), btn.getAttribute('data-pname'));
      });
    });
  }

  function renderChildCard(p, save) {
    const sum = E.Profiles.summaryOf(save);
    const seen = (save && save.seen) || {};
    let attempts = 0, wrongs = 0;
    const trouble = [];
    const strands = {};
    Object.keys(seen).forEach(function (id) {
      const info = seen[id] || {};
      const n = info.n || 0, w = info.w || 0;
      attempts += n; wrongs += w;
      const item = E.itemById(id);
      if (!item) return;
      if (w > 0 && item.kind === 'spelling') {
        trouble.push({ word: item.word, pattern: item.pattern, level: item.level, w: w, n: n });
      }
      if (item.kind === 'grammar') {
        const st = strands[item.strand] || { w: 0, n: 0 };
        st.w += w; st.n += n;
        strands[item.strand] = st;
      }
    });
    trouble.sort(function (a, b) { return b.w - a.w || b.n - a.n; });
    const troubleRows = trouble.slice(0, 12).map(function (t) {
      return '<tr><td><b>' + escapeHtml(t.word) + '</b></td><td>' + escapeHtml(t.pattern || '') +
        '</td><td>L' + t.level + '</td><td>' + t.w + ' of ' + t.n + ' wrong</td></tr>';
    }).join('');
    const strandRows = Object.keys(strands)
      .map(function (k) { return { k: k, w: strands[k].w, n: strands[k].n }; })
      .filter(function (s) { return s.w > 0; })
      .sort(function (a, b) { return b.w - a.w; })
      .slice(0, 5)
      .map(function (s) { return '<li>' + escapeHtml(s.k) + ' — ' + s.w + ' of ' + s.n + ' wrong</li>'; })
      .join('');
    const acc = attempts > 0 ? Math.round(((attempts - wrongs) / attempts) * 100) : null;
    const rank = E.rankFor((save && save.xp) || 0);

    return '<div class="card parent-child">' +
      '<div class="pc-head"><span class="pc-avatar">' + p.avatar + '</span>' +
      '<div><b>' + escapeHtml(p.name) + '</b><br><small>' + rank.icon + ' ' + rank.name + '</small></div>' +
      '<div class="pc-nums">✨ ' + sum.xp + ' XP · ⭐ ' + sum.stars + ' · 🏅 ' + sum.badges +
      (acc !== null ? ' · 🎯 ' + acc + '% correct (' + attempts + ' answers)' : ' · no answers yet') +
      ((save && save.streak) ? ' · 🔥 ' + save.streak + '-day streak' : '') + '</div></div>' +
      (troubleRows
        ? '<h4>Words to practise</h4><table class="trouble-table"><tbody>' + troubleRows + '</tbody></table>'
        : '<p class="parent-note">No trouble words yet — nothing answered wrong. 🎉</p>') +
      (strandRows ? '<h4>Grammar to revisit</h4><ul class="strand-list">' + strandRows + '</ul>' : '') +
      '<div class="pc-actions no-print">' +
      '<button class="btn btn-ghost btn-sm" data-pact="rename" data-pid="' + p.id + '" data-pname="' + escapeHtml(p.name) + '">✏️ Rename</button>' +
      '<button class="btn btn-ghost btn-sm" data-pact="reset" data-pid="' + p.id + '" data-pname="' + escapeHtml(p.name) + '">🔄 Reset progress</button>' +
      '<button class="btn btn-danger btn-sm" data-pact="delete" data-pid="' + p.id + '" data-pname="' + escapeHtml(p.name) + '">🗑️ Delete player</button>' +
      '</div></div>';
  }

  async function handleParentAction(act, id, name) {
    if (act === 'rename') {
      const newName = window.prompt('New name for ' + name + ':', name);
      if (!newName || !newName.trim()) return;
      const profiles = await E.Profiles.list();
      const p = profiles.find(function (q) { return q.id === id; });
      await E.Profiles.update(id, newName.trim(), (p && p.avatar) || '🦄');
      if (E.Net.isServerId(id)) {
        const res = await E.Net.api('load', { id: id });
        if (res && res.save) {
          res.save.name = newName.trim();
          res.save.updatedAt = Math.max((res.save.updatedAt || 0) + 1, Date.now());
          await E.Net.api('save', { id: id, save: res.save });
        }
      }
      /* the renamed profile may be the one currently loaded in memory — re-hydrate,
         or the stale in-memory save would sync the old name straight back */
      if (E.Profiles.currentId() === id) { await E.Profiles.select(id); }
      showParentZone();
    } else if (act === 'reset') {
      if (!window.confirm('Reset ALL progress for ' + name + '? XP, stars and badges will go back to zero.')) return;
      if (E.Net.isServerId(id)) {
        const res = await E.Net.api('load', { id: id });
        const fresh = { name: name, avatar: (res && res.save && res.save.avatar) || '🦄',
          xp: 0, correctTotal: 0, spellingCorrect: 0, grammarCorrect: 0, streak: 0, lastPlayedDay: '',
          levels: {}, seen: {}, badges: [], sound: true,
          updatedAt: Math.max(((res && res.save && res.save.updatedAt) || 0) + 1, Date.now()) };
        await E.Net.api('save', { id: id, save: fresh });
      }
      try { localStorage.removeItem('spelgram3000-v2-save-' + id); } catch (e) {}
      if (E.Profiles.currentId() === id) { await E.Profiles.select(id); }
      showParentZone();
    } else if (act === 'delete') {
      if (!window.confirm('Delete player ' + name + ' and ALL their progress? This cannot be undone.')) return;
      if (!window.confirm('Really sure? ' + name + '\'s XP, stars and badges will be gone forever.')) return;
      if (E.Net.isServerId(id)) {
        const res = await E.Net.api('parent-delete-profile', { token: Parent.token, id: id });
        if (!res) { window.alert('Could not delete — your parent session may have expired. Go back and re-enter the code.'); return; }
      }
      E.Profiles.saveLocalList(E.Profiles.localList().filter(function (q) { return q.id !== id; }));
      try { localStorage.removeItem('spelgram3000-v2-save-' + id); } catch (e) {}
      if (E.Profiles.currentId() === id) E.Profiles.signOut();
      showParentZone();
    }
  }

  /* ---------------- wiring ---------------- */
  async function init() {
    E.Speech.init();
    E.Confetti.init($('confetti-canvas'));

    /* data sanity */
    if (!E.data.spelling.length || !E.data.grammar.length) {
      document.body.innerHTML =
        '<div style="font-family:sans-serif;color:#fff;text-align:center;padding:3rem 1.5rem">' +
        '<h1>🔮 Spelgram 3000</h1><p>Word banks are still loading or missing.<br>' +
        'Make sure the <b>data/</b> folder was uploaded next to index.html.</p></div>';
      return;
    }

    $('btn-hint').addEventListener('click', function () { E.SFX.play('click'); revealHint(false); });
    $('btn-check').addEventListener('click', checkAnswer);
    $('btn-next').addEventListener('click', function () { E.SFX.play('click'); nextQuestion(); });
    $('btn-quit').addEventListener('click', function () {
      E.SFX.play('click');
      show('screen-home'); renderHome();
    });
    $('btn-retry').addEventListener('click', function () {
      E.SFX.play('click');
      startLevel(session.level);
    });
    $('btn-trophies').addEventListener('click', function () {
      E.SFX.play('click'); renderTrophies(); show('screen-trophies');
    });
    $('btn-trophies-back').addEventListener('click', function () {
      E.SFX.play('click'); show('screen-home'); renderHome();
    });

    /* Word Lab */
    $('btn-wordlab').addEventListener('click', function () {
      E.SFX.play('click'); openWordLab();
    });
    $('btn-lab-close').addEventListener('click', function () { closeModal('modal-wordlab'); });
    $('btn-lab-brew').addEventListener('click', function () { brew(null); });
    $('btn-lab-done').addEventListener('click', function () {
      closeModal('modal-wordlab');
      renderHome();
    });

    /* Parent zone */
    $('btn-parent-zone').addEventListener('click', function () { openParentZone(); });
    $('btn-settings-parent').addEventListener('click', function () {
      closeModal('modal-settings'); openParentZone();
    });
    $('btn-pin-cancel').addEventListener('click', function () { closeModal('modal-pin'); });
    $('btn-parent-back').addEventListener('click', function () {
      E.SFX.play('click');
      Parent.lock(); /* leaving the zone ends the parent session */
      if (E.Profiles.currentId()) { show('screen-home'); renderHome(); }
      else { goToProfilePicker(); }
    });
    $('btn-parent-print').addEventListener('click', function () { window.print(); });
    $('btn-parent-refresh').addEventListener('click', function () {
      withValidParentToken(async function () {
        openModal('modal-wordlab');
        await brew(Parent.token);
        showParentZone();
      });
    });
    $('btn-parent-changepin').addEventListener('click', function () {
      withValidParentToken(function () {
        openPinModal('change', function () { window.alert('Parent code updated.'); });
      });
    });
    $('btn-key-save').addEventListener('click', async function () {
      const key = $('magic-key-input').value.trim();
      if (!key) { window.alert('Paste an Anthropic API key first (from console.anthropic.com).'); return; }
      const res = await E.Net.api('parent-set-key', { token: Parent.token, key: key });
      $('magic-key-input').value = '';
      if (res) { showParentZone(); } else { window.alert('Could not save — re-enter the parent code and try again.'); }
    });
    $('btn-key-clear').addEventListener('click', async function () {
      if (!window.confirm('Remove the AI key? The Word Lab will go back to the built-in vault.')) return;
      const res = await E.Net.api('parent-set-key', { token: Parent.token, key: '' });
      if (res) { showParentZone(); }
    });

    $('btn-level-cancel').addEventListener('click', function () { closeModal('modal-level'); });
    $('btn-level-start').addEventListener('click', function () {
      E.SFX.play('click');
      closeModal('modal-level');
      if (pendingLevel) startLevel(pendingLevel.n);
    });

    /* settings */
    $('btn-settings').addEventListener('click', function () {
      const s = E.loadSave();
      $('toggle-sound').textContent = s.sound ? 'On 🔊' : 'Off 🔇';
      openModal('modal-settings');
    });
    $('btn-settings-close').addEventListener('click', function () { closeModal('modal-settings'); });
    $('toggle-sound').addEventListener('click', function () {
      const s = E.loadSave();
      s.sound = !s.sound; E.persist();
      $('toggle-sound').textContent = s.sound ? 'On 🔊' : 'Off 🔇';
      E.SFX.play('click');
    });
    $('btn-rename').addEventListener('click', function () {
      closeModal('modal-settings'); openNameModal(true);
    });
    $('btn-switch').addEventListener('click', function () {
      E.SFX.play('click');
      closeModal('modal-settings');
      goToProfilePicker();
    });
    $('btn-reset').addEventListener('click', function () {
      if (window.confirm('Really start over? All XP, stars and badges will be lost.')) {
        const s = E.loadSave();
        const name = s.name, avatar = s.avatar;
        E.resetSave();
        const fresh = E.loadSave();
        fresh.name = name; fresh.avatar = avatar;
        E.persist();
        closeModal('modal-settings');
        renderHome();
      }
    });

    /* name modal (create a new player, or rename the current one) */
    $('btn-name-go').addEventListener('click', async function () {
      const name = $('name-input').value.trim();
      if (!name) { $('name-input').focus(); return; }
      const sel = document.querySelector('#avatar-row .avatar-pick.sel');
      const avatar = sel ? sel.textContent : '🦄';
      $('btn-name-go').disabled = true;
      try {
        if (nameModalRename) {
          const s = E.loadSave();
          s.name = name; s.avatar = avatar;
          E.persist();
          await E.Profiles.update(E.Profiles.currentId(), name, avatar);
          closeModal('modal-name');
          renderHome();
        } else {
          const p = await E.Profiles.create(name, avatar, null);
          closeModal('modal-name');
          E.SFX.play('fanfare');
          E.Confetti.burst(40, 0.35);
          await enterProfile(p);
        }
      } finally {
        $('btn-name-go').disabled = false;
      }
    });
    $('name-input').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') $('btn-name-go').click();
    });

    /* make sure the last few answers reach the server when the tab closes,
       and pick up newer progress from other devices when the tab comes back */
    window.addEventListener('pagehide', function () { E.Net.flushBeacon(); Parent.token = ''; });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { E.Net.flushBeacon(); return; }
      E.Profiles.resync().then(function (replaced) {
        if (replaced && !$('screen-home').hidden) renderHome();
      });
    });

    /* purge any parent token left in storage by an older build — the session is
       memory-only now, and a lingering one must never grant access */
    try {
      sessionStorage.removeItem('spelgram-parent-token');
      localStorage.removeItem('spelgram-parent-token');
    } catch (e) {}

    /* boot: find out who's playing */
    show('screen-profiles');
    await E.Net.boot();
    $('profiles-offline').hidden = E.Net.online;
    await E.Net.loadExtraBank();
    await bootProfiles();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
