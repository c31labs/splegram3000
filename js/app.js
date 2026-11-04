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
  const SCREENS = ['screen-auth', 'screen-profiles', 'screen-home', 'screen-play', 'screen-results', 'screen-trophies', 'screen-parent'];
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
  /* the word is blanked in the raw sentence, then each side is escaped: item text
     can come from the server (Word Lab), so nothing of it reaches innerHTML raw */
  function blankSentence(sentence, word) {
    const text = String(sentence || '');
    const re = new RegExp('\\b' + String(word || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    const m = text.match(re);
    if (!m) return escapeHtml(text);
    return escapeHtml(text.slice(0, m.index)) + '<span class="blank">_____</span>' +
      escapeHtml(text.slice(m.index + m[0].length));
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
      '<p class="q-clue">Clue: ' + escapeHtml(q.item.definition) + '</p>' +
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
      '<p class="q-clue">Clue: ' + escapeHtml(q.item.definition) + '</p>' +
      '<div class="options" id="options"></div>';
    renderOptions(q.options);
  }

  function renderProofread(q, body) {
    let html = '<p class="q-prompt">One word is spelled wrongly. Tap it, then fix it!</p><p class="q-sentence proofread-sentence">';
    q.words.forEach(function (w, i) {
      if (q.clickable.indexOf(i) !== -1) {
        html += '<button class="pr-word" data-i="' + (Number(i) || 0) + '">' + escapeHtml(w) + '</button> ';
      } else {
        html += '<span>' + escapeHtml(w) + '</span> ';
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
    let html = '<p class="q-prompt">' + escapeHtml(it.prompt) + '</p>';
    if (it.sentence) {
      html += '<p class="q-sentence">' + escapeHtml(it.sentence).replace('___', '<span class="blank">_____</span>') + '</p>';
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
        body.innerHTML = '<p><b class="word-glow">' + escapeHtml(it.word) + '</b> — ' + escapeHtml(it.definition) + '</p>' +
          '<p class="rule-chip">📏 ' + escapeHtml(it.hint) + '</p>';
      } else {
        body.innerHTML = '<p>' + escapeHtml(it.explanation) + '</p>';
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
          '<p>The correct spelling is <b class="word-glow">' + escapeHtml(it.word) + '</b> — ' + escapeHtml(it.definition) + '</p>' +
          '<p class="rule-chip">📏 ' + escapeHtml(it.hint) + '</p>' +
          '<p class="try-say">Try saying it: <b>' + escapeHtml(syllableise(it.word)) + '</b></p>';
      } else {
        body.innerHTML = '<p>The answer is <b class="word-glow">' + escapeHtml(it.options[it.answer]) + '</b></p>' +
          '<p class="rule-chip">📏 ' + escapeHtml(it.explanation) + '</p>';
      }
    }
    $('btn-next').textContent = (qIndex + 1 >= session.questions.length) ? 'See results 🏁' : 'Next ➜';
    $('feedback').hidden = false;
    renderDots();
    $('feedback').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function syllableise(word) {
    /* naive chunking for "say it in chunks" support */
    return String(word || '').replace(/([aeiouy]+[^aeiouy\s]*)/gi, '$1·').replace(/·$/, '').replace(/·'/g, "'");
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
      /* p.summary comes straight from the server, so coerce it here as well */
      const sum = p.summary || E.Profiles.summaryOf(E.Profiles.peekSave(p.id));
      const card = document.createElement('button');
      card.className = 'profile-card';
      card.innerHTML =
        '<span class="profile-avatar">' + escapeHtml(p.avatar) + '</span>' +
        '<b>' + escapeHtml(p.name) + '</b>' +
        '<small>⭐ ' + (Number(sum.stars) || 0) + ' · ✨ ' + (Number(sum.xp) || 0) + ' XP</small>';
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
    let added = 0, merged = 0, msgIdx = 0, failed = false, stopMsg = '';
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
          E.Net.apiRaw('refresh-step', payload, 120000),
          new Promise(function (r) { setTimeout(r, 1100); }),
        ]);
        const res = results[0];
        if (!res || !res.ok) {
          /* any refusal stops the brew; the server's reason picks the message */
          failed = true;
          stopMsg = brewStopMessage(res && res.error);
        } else {
          added += Number(res.added) || 0;
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
                    : 'They\'ll appear the next time the game loads!') +
        (failed ? ' ' + stopMsg : ''); /* a later step was refused: say why */
    } else if (failed) {
      $('lab-done-title').textContent = '⏳ Not just yet!';
      $('lab-done-msg').textContent = stopMsg;
    } else {
      $('lab-done-title').textContent = '🧙 All brewed out!';
      $('lab-done-msg').textContent = 'Every word in the vault is already unlocked. Ask a grown-up to open the Parent zone for more magic.';
    }
    return added;
  }

  /* why the cauldron stopped, in words a child can read */
  function brewStopMessage(error) {
    if (error === 'busy') return 'The cauldron is already brewing for someone else. Try again in a few minutes.';
    if (error === 'daily-limit') return 'The cauldron has done all it can for today. Come back tomorrow for more!';
    if (error === 'that step has already run') return 'That batch has already been brewed. Close the Word Lab and open it again to see what is new.';
    return 'The cauldron needs a rest. Come back a bit later!';
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
    /* same thing from pagehide, where a fetch may never leave the tab */
    lockBeacon: function () {
      const old = this.token;
      this.token = '';
      if (old) E.Net.beacon('parent-logout', { token: old });
    },
  };
  /* new codes are 6 to 8 digits; sign-in still accepts the older 4-digit ones */
  const PIN_MIN_NEW = 6, PIN_MIN_LOGIN = 4, PIN_MAX = 8;
  const PIN_DIGITS = /^[0-9]{6,8}$/;
  let pinEntry = '', pinFirst = null, pinCurrent = null, pinMode = 'login', pinOnSuccess = null;

  function pinStage() {
    /* 'current' = asking for the existing code; 'new' = choosing one; 'login' */
    if (pinMode === 'login') return 'login';
    if (pinMode === 'change' && pinCurrent === null) return 'current';
    return 'new';
  }

  function renderPinDots() {
    const dots = $('pin-dots');
    const min = pinStage() === 'new' ? PIN_MIN_NEW : PIN_MIN_LOGIN;
    dots.innerHTML = '';
    for (let i = 0; i < PIN_MAX; i++) {
      if (i < pinEntry.length) { dots.innerHTML += '<span class="pd on">●</span>'; }
      else if (i < min) { dots.innerHTML += '<span class="pd">○</span>'; }
    }
  }

  function pinChooseText() { return 'Choose a 6 to 8 digit code only grown-ups know.'; }

  function openPinModal(mode, onSuccess) {
    pinMode = mode; pinOnSuccess = onSuccess;
    pinEntry = ''; pinFirst = null; pinCurrent = null;
    $('pin-error').hidden = true;
    $('pin-title').textContent = mode === 'login' ? '🔒 Parent zone'
      : mode === 'change' ? '🔐 Change the parent code' : '🔐 Create a parent code';
    $('pin-sub').textContent = mode === 'login' ? 'Enter your parent code.'
      : mode === 'change' ? 'First, enter your current parent code.'
      : pinChooseText();
    showPinReset(false); /* also shows the "forgot" link in login mode only */
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
      if (pinEntry.length < PIN_MAX) pinEntry += k;
      renderPinDots();
      return;
    }
    const stage = pinStage();
    if (stage === 'new' && pinEntry.length < PIN_MIN_NEW) { showPinError('A new code needs at least 6 digits.'); return; }
    if (stage !== 'new' && pinEntry.length < PIN_MIN_LOGIN) { showPinError('The code needs at least 4 digits.'); return; }
    if (stage === 'login') {
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
    /* change: the current code comes first, then the new one twice */
    if (stage === 'current') {
      pinCurrent = pinEntry; pinEntry = '';
      $('pin-sub').textContent = pinChooseText();
      renderPinDots();
      return;
    }
    if (pinFirst === null) {
      pinFirst = pinEntry; pinEntry = '';
      $('pin-sub').textContent = 'Type the same code again to confirm.';
      renderPinDots();
      return;
    }
    if (pinFirst !== pinEntry) {
      showPinError('The codes didn\'t match. Start again.');
      pinFirst = null; pinEntry = '';
      $('pin-sub').textContent = pinChooseText();
      renderPinDots();
      return;
    }
    const action = pinMode === 'setup' ? 'parent-setup' : 'parent-change-pin';
    const payload = pinMode === 'setup' ? { pin: pinEntry } : { token: Parent.token, current: pinCurrent, pin: pinEntry };
    const res = await E.Net.apiRaw(action, payload);
    if (res && res.ok) {
      if (res.token) Parent.token = res.token;
      closeModal('modal-pin');
      if (pinOnSuccess) pinOnSuccess();
    } else if (pinMode === 'change' && res && !res.ok) {
      /* most likely the current code was wrong; begin again from that step */
      showPinError('That did not work. Check your current code and try again.');
      pinFirst = null; pinEntry = ''; pinCurrent = null;
      $('pin-sub').textContent = 'First, enter your current parent code.';
      renderPinDots();
    } else {
      showPinError('Something went wrong. Try again.');
      pinFirst = null; pinEntry = ''; renderPinDots();
    }
  }

  function showPinError(msg) {
    $('pin-error').textContent = msg;
    $('pin-error').hidden = false;
  }

  /* forgotten code: the family password proves it is a grown-up, then a new code is set */
  function showPinReset(on) {
    $('pin-entry').hidden = on;
    $('pin-reset').hidden = !on;
    $('btn-pin-forgot').hidden = on || pinMode !== 'login';
    $('pin-error').hidden = true;
    if (on) {
      $('pin-title').textContent = '🔐 Reset the parent code';
      $('pin-sub').textContent = 'Enter the family password and choose a new 6 to 8 digit code.';
      $('pin-reset-password').value = '';
      $('pin-reset-code').value = '';
      $('pin-reset-password').focus();
    }
  }

  async function submitPinReset() {
    const password = $('pin-reset-password').value;
    const pin = $('pin-reset-code').value.trim();
    if (!password) { showPinError('Enter the family password first.'); return; }
    if (!PIN_DIGITS.test(pin)) { showPinError('The new code must be 6 to 8 digits.'); return; }
    const btn = $('btn-pin-reset-go');
    btn.disabled = true;
    try {
      const res = await E.Net.apiRaw('parent-reset-pin', { password: password, pin: pin });
      $('pin-reset-password').value = '';
      $('pin-reset-code').value = '';
      if (!res) { showPinError('Could not reach the server. Try again in a moment.'); return; }
      if (!res.ok) { showPinError('That did not work. Check the family password and try again.'); return; }
      if (res.token) {
        Parent.token = res.token;
        closeModal('modal-pin');
        if (pinOnSuccess) pinOnSuccess();
        return;
      }
      /* back to the pad with the new code */
      pinEntry = '';
      showPinReset(false);
      $('pin-title').textContent = '🔒 Parent zone';
      $('pin-sub').textContent = 'Your new code is set. Enter it to continue.';
      renderPinDots();
    } finally {
      btn.disabled = false;
    }
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
      ? (pstat.keyProblem
          ? '⚠️ Key configured, but the last generation failed with the saved key. It may be invalid or out of credit.'
          : '✅ Key configured — Word Lab writes brand-new questions with AI')
      : 'No key set — Word Lab unlocks from the built-in vault';
    $('account-line').textContent = 'Signed in as ' + (E.Auth.email || 'this family') +
      (E.Auth.family ? ' (' + E.Auth.family + ')' : '') + '.';
    $('pw-error').hidden = true;
    $('pw-ok').hidden = true;

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
      /* the save comes from the server: coerce before anything is added or rendered */
      const n = Number(info.n) || 0, w = Number(info.w) || 0;
      attempts += n; wrongs += w;
      const item = E.itemById(id);
      if (!item) return;
      if (w > 0 && item.kind === 'spelling') {
        trouble.push({ word: item.word, pattern: item.pattern, level: Number(item.level) || 0, w: w, n: n });
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
    const rank = E.rankFor(Number(save && save.xp) || 0);
    const streak = Number(save && save.streak) || 0;
    const pid = escapeHtml(p.id), pname = escapeHtml(p.name);

    return '<div class="card parent-child">' +
      '<div class="pc-head"><span class="pc-avatar">' + escapeHtml(p.avatar) + '</span>' +
      '<div><b>' + pname + '</b><br><small>' + rank.icon + ' ' + rank.name + '</small></div>' +
      '<div class="pc-nums">✨ ' + (Number(sum.xp) || 0) + ' XP · ⭐ ' + (Number(sum.stars) || 0) + ' · 🏅 ' + (Number(sum.badges) || 0) +
      (acc !== null ? ' · 🎯 ' + acc + '% correct (' + attempts + ' answers)' : ' · no answers yet') +
      (streak ? ' · 🔥 ' + streak + '-day streak' : '') + '</div></div>' +
      (troubleRows
        ? '<h4>Words to practise</h4><table class="trouble-table"><tbody>' + troubleRows + '</tbody></table>'
        : '<p class="parent-note">No trouble words yet — nothing answered wrong. 🎉</p>') +
      (strandRows ? '<h4>Grammar to revisit</h4><ul class="strand-list">' + strandRows + '</ul>' : '') +
      '<div class="pc-actions no-print">' +
      '<button class="btn btn-ghost btn-sm" data-pact="rename" data-pid="' + pid + '" data-pname="' + pname + '">✏️ Rename</button>' +
      '<button class="btn btn-ghost btn-sm" data-pact="reset" data-pid="' + pid + '" data-pname="' + pname + '">🔄 Reset progress</button>' +
      '<button class="btn btn-danger btn-sm" data-pact="delete" data-pid="' + pid + '" data-pname="' + pname + '">🗑️ Delete player</button>' +
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
      E.Profiles.dropSaveCache(id);
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
      E.Profiles.dropSaveCache(id);
      if (E.Profiles.currentId() === id) E.Profiles.signOut();
      showParentZone();
    }
  }

  /* ---------------- family sign-in screen ---------------- */
  let authMode = 'login'; /* login | register | confirm | forgot | reset */

  const AUTH_MODES = {
    login: {
      title: 'Family sign-in', btn: 'Sign in',
      sub: 'Welcome back! Sign in to see your family\'s players.',
      fields: { family: false, email: true, code: false, password: true },
      toggle: 'New here? Create your family account',
    },
    register: {
      title: 'Create your family account', btn: 'Create account 🚀',
      sub: 'One free account per family — then every child gets their own player.',
      fields: { family: true, email: true, code: false, password: true },
      toggle: 'Already have an account? Sign in',
    },
    /* after register: the server never says whether the address was new */
    confirm: {
      title: 'Check your email', btn: 'Confirm code',
      sub: 'If this is a new address, we have emailed a code; if you already have an account, we have emailed you a reminder to sign in.',
      fields: { family: false, email: true, code: true, password: false },
      codeLabel: 'Code from the email',
      toggle: 'Back to sign-in',
    },
    forgot: {
      title: 'Reset your password', btn: 'Email me a code',
      sub: 'Tell us your account email and we\'ll send a 6-digit reset code.',
      fields: { family: false, email: true, code: false, password: false },
      toggle: 'Back to sign-in',
    },
    reset: {
      title: 'Choose a new password', btn: 'Set new password',
      sub: 'Enter the 6-digit code from the email and pick a new password.',
      fields: { family: false, email: true, code: true, password: true },
      codeLabel: 'Reset code (check your email)',
      toggle: 'Back to sign-in',
    },
  };

  function setAuthMode(mode) {
    authMode = mode;
    const m = AUTH_MODES[mode];
    $('auth-title').textContent = m.title;
    $('auth-sub').textContent = m.sub;
    $('btn-auth-go').textContent = m.btn;
    $('auth-family-wrap').hidden = !m.fields.family;
    $('auth-email-wrap').hidden = !m.fields.email;
    $('auth-code-wrap').hidden = !m.fields.code;
    $('auth-code-label').textContent = m.codeLabel || 'Reset code (check your email)';
    $('auth-password-wrap').hidden = !m.fields.password;
    $('auth-password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    $('auth-password').placeholder = mode === 'login' ? 'Your password' : 'At least 8 characters';
    $('btn-auth-toggle').textContent = m.toggle;
    $('btn-auth-forgot').hidden = mode !== 'login';
    $('auth-error').hidden = true;
  }

  function showAuthScreen(mode, errorMsg) {
    setAuthMode(mode || 'login');
    $('auth-offline').hidden = E.Net.online;
    $('btn-auth-go').disabled = false;
    if (errorMsg) showAuthError(errorMsg);
    show('screen-auth');
  }

  function showAuthError(msg) {
    $('auth-error').textContent = msg;
    $('auth-error').hidden = false;
  }

  async function submitAuth() {
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    $('auth-error').hidden = true;
    if (!email || email.indexOf('@') === -1) {
      showAuthError('Please enter your email address.');
      return;
    }
    if (authMode !== 'forgot' && authMode !== 'confirm' && password.length < 8) {
      showAuthError('The password needs at least 8 characters.');
      return;
    }

    const btn = $('btn-auth-go');
    btn.disabled = true;
    try {
      let res = null;
      if (authMode === 'login') {
        res = await E.Auth.login(email, password);
      } else if (authMode === 'register') {
        const family = $('auth-family').value.trim();
        if (!family) {
          showAuthError('Please enter a family name — it\'s what the kids will see.');
          return;
        }
        res = await E.Auth.register(family, email, password);
        if (res && res.ok && res.pending) {
          /* the account is only created once the emailed code comes back */
          $('auth-password').value = '';
          $('auth-code').value = '';
          setAuthMode('confirm');
          $('auth-code').focus();
          return;
        }
      } else if (authMode === 'confirm') {
        const code = $('auth-code').value.trim();
        if (!/^[0-9]{6}$/.test(code)) {
          showAuthError('The code is the 6 digits from the email.');
          return;
        }
        res = await E.Auth.registerConfirm(email, code);
      } else if (authMode === 'forgot') {
        res = await E.Auth.resetRequest(email);
        if (res && res.ok) {
          setAuthMode('reset');
          $('auth-sub').textContent = 'If ' + email + ' has an account, a 6-digit code is on its way. Enter it below with your new password.';
          return;
        }
      } else { /* reset */
        const code = $('auth-code').value.trim();
        if (!/^[0-9]{6}$/.test(code)) {
          showAuthError('The reset code is the 6 digits from the email.');
          return;
        }
        res = await E.Auth.resetConfirm(email, code, password);
      }

      if (res && res.ok && E.Auth.signedIn()) {
        $('auth-password').value = '';
        $('auth-code').value = '';
        await enterFamily();
        return;
      }
      if (!res) {
        showAuthError('Could not reach the server — check your connection and try again.');
        $('auth-offline').hidden = false;
      } else if (authMode !== 'forgot') {
        showAuthError(res.error || 'Something went wrong — please try again.');
      }
    } finally {
      btn.disabled = false;
    }
  }

  /* signed in (or restored from cache) — load this family's world */
  async function enterFamily() {
    $('family-label').textContent = '👪 ' + (E.Auth.family || E.Auth.email);
    $('family-line').hidden = false;
    show('screen-profiles');
    $('profile-grid').innerHTML = '<p class="profiles-loading">Loading players…</p>';
    $('profiles-offline').hidden = E.Net.online;
    await E.Net.loadExtraBank();
    await bootProfiles();
  }

  /* no account, no connection — the game still works, saved on this device only */
  async function enterDeviceMode() {
    $('family-line').hidden = true;
    show('screen-profiles');
    $('profiles-offline').hidden = false;
    await bootProfiles();
  }

  /* Push the current player's progress before signing out. Returns false if the
     parent chose to stay signed in rather than lose progress the server could
     not be given. pushNow() answers null both for "nothing to push" and for a
     failed push, so a push only counts as failed when one was actually needed. */
  async function pushBeforeSignOut() {
    const needed = E.Net.canSync();
    const pushed = await E.Net.pushNow();
    if (needed && !pushed) {
      return window.confirm('The latest progress on this device could not be saved to the server. Sign out anyway and lose it?');
    }
    return true;
  }

  /* clear this family's cached players and progress from the browser (all app
     keys in device-only play), then drop the in-memory player */
  function wipeThisFamily() {
    E.Auth.wipeLocal(!E.Auth.signedIn());
    E.Profiles.signOut();
  }

  async function signOutFamily() {
    if (!window.confirm('Sign out of the family account on this device? Players and progress cached in this browser will be removed.')) return;
    if (!(await pushBeforeSignOut())) return;
    wipeThisFamily();
    await E.Auth.signOut();
    window.location.reload(); /* clean slate — reboot into the sign-in screen */
  }

  /* "Sign out everywhere": every session on every device, including this one */
  async function signOutEverywhere() {
    if (!window.confirm('Sign out of the family account on every device and browser, including this one?')) return;
    if (!(await pushBeforeSignOut())) return;
    const res = await E.Net.apiRaw('logout-all', {});
    if (!res || !res.ok) {
      window.alert('Could not sign out everywhere. Check your connection and try again.');
      return;
    }
    Parent.token = ''; /* the family session is gone, so the parent one is too */
    wipeThisFamily();
    E.Auth.clear();
    window.location.reload();
  }

  /* wipe every app key in this browser, signed in or not */
  function forgetDevice() {
    if (!window.confirm('Forget this device? Every player and all progress stored in this browser will be removed. Progress already saved to a family account stays on the server.')) return;
    E.Auth.wipeLocal(true);
    E.Profiles.signOut();
    E.Auth.clear();
    window.location.reload();
  }

  async function changePassword() {
    const current = $('pw-current').value;
    const next = $('pw-new').value;
    const again = $('pw-new2').value;
    const err = $('pw-error'), ok = $('pw-ok');
    err.hidden = true; ok.hidden = true;
    const say = function (el, msg) { el.textContent = msg; el.hidden = false; };
    if (!current) { say(err, 'Enter your current password first.'); return; }
    if (next.length < 8) { say(err, 'The new password needs at least 8 characters.'); return; }
    if (next !== again) { say(err, 'The new passwords do not match.'); return; }
    if (next === current) { say(err, 'Choose a password that is different from the current one.'); return; }
    const btn = $('btn-pw-change');
    btn.disabled = true;
    try {
      const res = await E.Net.apiRaw('change-password', { current: current, new: next });
      if (!res) { say(err, 'Could not reach the server. Try again in a moment.'); return; }
      if (!res.ok) { say(err, res.error || 'That did not work. Check your current password and try again.'); return; }
      if (res.auth && res.account) E.Auth.apply(res); /* in case the server issued a fresh session */
      $('pw-current').value = ''; $('pw-new').value = ''; $('pw-new2').value = '';
      say(ok, 'Password changed.');
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------- wiring ---------------- */
  async function init() {
    E.Speech.init();
    E.Confetti.init($('confetti-canvas'));

    /* data sanity */
    if (!E.data.spelling.length || !E.data.grammar.length) {
      document.body.innerHTML =
        '<div class="data-missing">' +
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
    $('btn-pin-forgot').addEventListener('click', function () { showPinReset(true); });
    $('btn-pin-reset-go').addEventListener('click', function () { submitPinReset(); });
    ['pin-reset-password', 'pin-reset-code'].forEach(function (id) {
      $(id).addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !$('btn-pin-reset-go').disabled) submitPinReset();
      });
    });
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
    $('btn-pw-change').addEventListener('click', function () { changePassword(); });
    ['pw-current', 'pw-new', 'pw-new2'].forEach(function (id) {
      $(id).addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !$('btn-pw-change').disabled) changePassword();
      });
    });
    $('btn-logout-all').addEventListener('click', function () { signOutEverywhere(); });

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
    window.addEventListener('pagehide', function () { E.Net.flushBeacon(); Parent.lockBeacon(); });
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

    /* family sign-in */
    $('btn-auth-go').addEventListener('click', function () { submitAuth(); });
    ['auth-family', 'auth-email', 'auth-code', 'auth-password'].forEach(function (id) {
      $(id).addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !$('btn-auth-go').disabled) submitAuth();
      });
    });
    $('btn-auth-toggle').addEventListener('click', function () {
      setAuthMode(authMode === 'login' ? 'register' : 'login');
    });
    $('btn-auth-forgot').addEventListener('click', function () { setAuthMode('forgot'); });
    $('btn-auth-retry').addEventListener('click', async function () {
      await E.Net.boot();
      $('auth-offline').hidden = E.Net.online;
      if (E.Net.online && E.Auth.signedIn()) {
        const valid = await E.Auth.check();
        if (valid !== false) { enterFamily(); }
      }
    });
    $('btn-auth-device').addEventListener('click', function () { enterDeviceMode(); });
    $('btn-auth-forget-device').addEventListener('click', function () { forgetDevice(); });
    $('btn-signout').addEventListener('click', function () { signOutFamily(); });
    E.Auth.onExpired = function () {
      showAuthScreen('login', 'Your sign-in expired — please sign in again.');
    };

    /* boot: sign the family in, then find out who's playing */
    show('screen-profiles'); /* shows "Loading players…" while we ping the server */
    await E.Net.boot();
    if (E.Net.online) {
      const valid = await E.Auth.check();
      if (valid === true || (valid === null && E.Auth.signedIn())) {
        await enterFamily();
      } else {
        showAuthScreen('login');
      }
    } else if (E.Auth.signedIn()) {
      /* signed in earlier on this device — play from the local cache for now */
      await enterFamily();
    } else {
      showAuthScreen('login');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
