'use strict';
/**
 * admin.js — 관리자 페이지(/admin.html) 화면.
 *
 * 무빌드 IIFE. 다른 화면 모듈(window.JPK 등)에 기대지 않는다 — 이 파일 하나로 완결이다.
 *
 * 규칙
 *   - 서버에서 온 값은 **전부 textContent** 로만 넣는다. innerHTML 은 쓰지 않는다.
 *   - 401 이 돌아오면 어디서든 곧바로 로그인 화면으로 되돌린다(쿠키 만료 12시간).
 *   - 표는 .tbl-scroll 안에 있어 좁은 화면에서 표만 가로로 스크롤된다.
 */

(function () {
  var LIMIT = 20;

  // 탭별 조회 상태. offset 은 페이저가, q/userId 는 도구줄이 바꾼다.
  var view = {
    tab: 'overview',
    users: { offset: 0, q: '' },
    matches: { offset: 0 },
    study: { offset: 0, userId: '' },
    reports: { offset: 0 },
  };

  // ------------------------------------------------------------- DOM 도구

  function $(id) { return document.getElementById(id); }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  /** 값이 비었으면 em dash 로 흐리게. 문자열은 언제나 textContent 로 들어간다. */
  function cell(row, value, cls) {
    var td = document.createElement('td');
    if (cls) td.className = cls;
    if (value == null || value === '') {
      td.textContent = '—';
      td.classList.add('admin-blank');
    } else {
      td.textContent = String(value);
    }
    row.appendChild(td);
    return td;
  }

  function emptyRow(tbody, cols, text) {
    var tr = el('tr', 'admin-empty-row');
    var td = el('td', null, text);
    td.colSpan = cols;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** ISO 문자열 또는 epoch ms → 'YYYY-MM-DD HH:MM'. 해석 불가면 원본 그대로. */
  function fmtTime(v) {
    if (v == null || v === '') return null;
    var d = typeof v === 'number' ? new Date(v) : new Date(String(v));
    if (isNaN(d.getTime())) return String(v);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtNum(n) {
    return typeof n === 'number' && isFinite(n) ? n.toLocaleString('ko-KR') : null;
  }

  /** 초 → '1일 2시간 3분' 꼴. */
  function fmtUptime(s) {
    var n = Number(s);
    if (!isFinite(n) || n < 0) return null;
    var d = Math.floor(n / 86400);
    var h = Math.floor((n % 86400) / 3600);
    var m = Math.floor((n % 3600) / 60);
    var out = [];
    if (d) out.push(d + '일');
    if (h) out.push(h + '시간');
    out.push(m + '분');
    return out.join(' ');
  }

  // ---------------------------------------------------------------- 통신

  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json; charset=utf-8';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (resp) {
      return resp.text().then(function (text) {
        var json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { /* JSON 이 아닐 수 있다 */ }
        return { status: resp.status, json: json };
      });
    });
  }

  function errorOf(r, fallback) {
    return r && r.json && typeof r.json.error === 'string' ? r.json.error : fallback;
  }

  // ------------------------------------------------------------ 화면 전환

  function showLogin(message) {
    $('bootNote').hidden = true;
    $('dashPane').hidden = true;
    $('loginPane').hidden = false;
    $('refreshBtn').hidden = true;
    $('logoutBtn').hidden = true;
    $('loginError').textContent = message || '';
    var idInput = $('adminId');
    if (idInput && !idInput.value) idInput.focus();
  }

  function showDash() {
    $('bootNote').hidden = true;
    $('loginPane').hidden = true;
    $('dashPane').hidden = false;
    $('refreshBtn').hidden = false;
    $('logoutBtn').hidden = false;
    $('loginError').textContent = '';
  }

  function paneError(msg) {
    $('paneError').textContent = msg || '';
  }

  /** 어떤 조회에서든 401 이면 로그인 화면으로. true 를 돌려주면 호출자는 중단한다. */
  function bounced(r) {
    if (r.status !== 401) return false;
    showLogin('세션이 만료되었습니다. 다시 로그인해 주세요.');
    return true;
  }

  // ---------------------------------------------------------------- 페이저

  function renderPager(name, total, offset, limit, onGo) {
    var box = document.querySelector('.admin-pager[data-pager="' + name + '"]');
    if (!box) return;
    clear(box);

    var prev = el('button', null, '이전');
    prev.type = 'button';
    prev.disabled = offset <= 0;
    prev.addEventListener('click', function () { onGo(Math.max(0, offset - limit)); });

    var next = el('button', null, '다음');
    next.type = 'button';
    next.disabled = offset + limit >= total;
    next.addEventListener('click', function () { onGo(offset + limit); });

    var from = total === 0 ? 0 : offset + 1;
    var to = Math.min(offset + limit, total);
    var range = el('span', 'admin-range',
      total === 0 ? '결과 없음' : from + '–' + to + ' / 총 ' + total.toLocaleString('ko-KR') + '건');

    box.appendChild(prev);
    box.appendChild(next);
    box.appendChild(range);
  }

  // ----------------------------------------------------------------- 개요

  function statCard(label, value) {
    var box = el('div', 'admin-stat');
    box.appendChild(el('span', 'admin-stat-label', label));
    box.appendChild(el('span', 'admin-stat-value', value == null ? '—' : String(value)));
    return box;
  }

  function fact(dl, key, value) {
    dl.appendChild(el('dt', null, key));
    var dd = el('dd', null, value == null || value === '' ? '—' : String(value));
    if (value == null || value === '') dd.classList.add('admin-blank');
    dl.appendChild(dd);
  }

  function loadOverview() {
    return api('GET', '/api/admin/stats').then(function (r) {
      if (bounced(r)) return;
      if (r.status !== 200 || !r.json) {
        paneError(errorOf(r, '통계를 불러오지 못했습니다.'));
        return;
      }
      paneError('');
      var s = r.json;
      var cards = $('statCards');
      clear(cards);
      cards.appendChild(statCard('사용자', fmtNum(s.db.users)));
      cards.appendChild(statCard('대전', fmtNum(s.db.matches)));
      cards.appendChild(statCard('학습 기록', fmtNum(s.db.studyResults)));
      cards.appendChild(statCard('진행 중 방', s.battle.activeRooms == null ? '준비 중' : fmtNum(s.battle.activeRooms)));
      cards.appendChild(statCard('회차', fmtNum(s.content.rounds)));
      cards.appendChild(statCard('문항', fmtNum(s.content.questions)));

      var dl = $('statFacts');
      clear(dl);
      fact(dl, 'DB 어댑터', s.db.adapter + (s.db.available ? '' : ' (관리자 조회 준비 중)'));
      fact(dl, '대전 참가 기록', fmtNum(s.db.matchPlayers));
      fact(dl, '서버 가동', fmtUptime(s.server.processUptimeS));
      fact(dl, '기동 시각', fmtTime(s.server.startedAt));
      fact(dl, 'Node', s.server.node);
      fact(dl, 'PID', s.server.pid);
    });
  }

  // --------------------------------------------------------------- 사용자

  function loadUsers() {
    var q = view.users.q;
    var url = '/api/admin/users?limit=' + LIMIT + '&offset=' + view.users.offset +
      (q ? '&q=' + encodeURIComponent(q) : '');
    return api('GET', url).then(function (r) {
      if (bounced(r)) return;
      var tb = $('tb-users');
      clear(tb);
      if (r.status !== 200 || !r.json) {
        paneError(errorOf(r, '사용자 목록을 불러오지 못했습니다.'));
        emptyRow(tb, 6, '불러오지 못했습니다.');
        return;
      }
      paneError(r.json.pending ? r.json.note : '');
      var items = r.json.items || [];
      if (!items.length) {
        emptyRow(tb, 6, q ? '검색 결과가 없습니다.' : '사용자가 없습니다.');
      } else {
        items.forEach(function (u) {
          var tr = document.createElement('tr');
          cell(tr, u.id, 'admin-num');
          cell(tr, u.nickname);
          cell(tr, fmtTime(u.created_at), 'admin-when');
          cell(tr, fmtNum(u.match_count), 'admin-num');
          cell(tr, fmtTime(u.last_study_at), 'admin-when');
          var td = document.createElement('td');
          var btn = el('button', null, '보기');
          btn.type = 'button';
          btn.className = 'admin-badge';
          btn.addEventListener('click', function () {
            view.study.userId = String(u.id);
            view.study.offset = 0;
            $('studyUser').value = String(u.id);
            selectTab('study');
          });
          td.appendChild(btn);
          tr.appendChild(td);
          tb.appendChild(tr);
        });
      }
      renderPager('users', r.json.total || 0, view.users.offset, LIMIT, function (off) {
        view.users.offset = off;
        loadUsers();
      });
    });
  }

  // ----------------------------------------------------------------- 대전

  function playersCell(tr, players) {
    var td = document.createElement('td');
    var list = players || [];
    if (!list.length) {
      td.textContent = '—';
      td.classList.add('admin-blank');
      tr.appendChild(td);
      return;
    }
    var ul = el('ul', 'admin-players');
    list.forEach(function (p) {
      var li = document.createElement('li');
      li.appendChild(document.createTextNode(
        (p.nickname == null ? '(탈퇴 #' + p.user_id + ')' : String(p.nickname)) +
        ' · ' + (p.score == null ? p.correct_count + '문항' : p.score + '점') + ' '));
      if (p.winner) li.appendChild(el('span', 'admin-badge win', '승'));
      ul.appendChild(li);
    });
    td.appendChild(ul);
    tr.appendChild(td);
  }

  function loadMatches() {
    var url = '/api/admin/matches?limit=' + LIMIT + '&offset=' + view.matches.offset;
    return api('GET', url).then(function (r) {
      if (bounced(r)) return;
      var tb = $('tb-matches');
      clear(tb);
      if (r.status !== 200 || !r.json) {
        paneError(errorOf(r, '대전 목록을 불러오지 못했습니다.'));
        emptyRow(tb, 6, '불러오지 못했습니다.');
        return;
      }
      paneError(r.json.pending ? r.json.note : '');
      var items = r.json.items || [];
      if (!items.length) {
        emptyRow(tb, 6, '끝난 대전이 없습니다.');
      } else {
        items.forEach(function (m) {
          var tr = document.createElement('tr');
          cell(tr, m.id, 'admin-num');
          cell(tr, m.room_name, 'admin-wrap');
          cell(tr, m.mode === 'random' ? '랜덤' : '회차');
          cell(tr, fmtNum(m.question_count), 'admin-num');
          cell(tr, fmtTime(m.finished_at), 'admin-when');
          playersCell(tr, m.players);
          tb.appendChild(tr);
        });
      }
      renderPager('matches', r.json.total || 0, view.matches.offset, LIMIT, function (off) {
        view.matches.offset = off;
        loadMatches();
      });
    });
  }

  // ------------------------------------------------------------ 학습 기록

  var ROUND_LABEL = { practice: '모의고사', wrong: '오답노트', battle: '대전' };

  function loadStudy() {
    var uid = view.study.userId;
    var url = '/api/admin/study?limit=' + LIMIT + '&offset=' + view.study.offset +
      (uid ? '&userId=' + encodeURIComponent(uid) : '');
    return api('GET', url).then(function (r) {
      if (bounced(r)) return;
      var tb = $('tb-study');
      clear(tb);
      if (r.status !== 200 || !r.json) {
        paneError(errorOf(r, '학습 기록을 불러오지 못했습니다.'));
        emptyRow(tb, 7, '불러오지 못했습니다.');
        return;
      }
      paneError(r.json.pending ? r.json.note : '');
      var items = r.json.items || [];
      if (!items.length) {
        emptyRow(tb, 7, '학습 기록이 없습니다.');
      } else {
        items.forEach(function (s) {
          var tr = document.createElement('tr');
          cell(tr, s.id, 'admin-num');
          cell(tr, s.nickname == null ? '(탈퇴 #' + s.user_id + ')' : s.nickname);
          cell(tr, ROUND_LABEL[s.round] || s.round);
          cell(tr, s.score == null ? null : s.score + '점', 'admin-num');
          cell(tr, fmtNum(s.question_count), 'admin-num');
          cell(tr, fmtNum(s.wrong_count), 'admin-num');
          cell(tr, fmtTime(s.taken_at), 'admin-when');
          tb.appendChild(tr);
        });
      }
      renderPager('study', r.json.total || 0, view.study.offset, LIMIT, function (off) {
        view.study.offset = off;
        loadStudy();
      });
    });
  }

  // ----------------------------------------------------------------- 신고

  function answerText(v) {
    if (Array.isArray(v)) return v.join(' / ');
    return v == null ? '' : String(v);
  }

  function loadReports() {
    var url = '/api/admin/reports?limit=' + LIMIT + '&offset=' + view.reports.offset;
    return api('GET', url).then(function (r) {
      if (bounced(r)) return;
      var tb = $('tb-reports');
      clear(tb);
      if (r.status !== 200 || !r.json) {
        paneError(errorOf(r, '신고 목록을 불러오지 못했습니다.'));
        emptyRow(tb, 5, '불러오지 못했습니다.');
        return;
      }
      paneError(r.json.pending ? r.json.note : '');
      var items = r.json.items || [];
      if (!items.length) {
        emptyRow(tb, 5, '신고가 없습니다.');
      } else {
        items.forEach(function (it) {
          var tr = document.createElement('tr');
          cell(tr, fmtTime(it.at), 'admin-when');
          cell(tr, it.questionId);
          cell(tr, it.byUserId == null ? '비로그인' : '#' + it.byUserId);
          cell(tr, answerText(it.myAnswer), 'admin-wrap');
          cell(tr, it.comment, 'admin-wrap');
          tb.appendChild(tr);
        });
      }
      renderPager('reports', r.json.total || 0, view.reports.offset, LIMIT, function (off) {
        view.reports.offset = off;
        loadReports();
      });
    });
  }

  // ----------------------------------------------------------- 진행 중 방

  var ROOM_STATE = {
    waiting: '대기', countdown: '카운트다운', playing: '진행 중',
    finished: '종료', abandoned: '버려짐',
  };

  function loadRooms() {
    return api('GET', '/api/admin/rooms').then(function (r) {
      if (bounced(r)) return;
      var tb = $('tb-rooms');
      clear(tb);
      if (r.status !== 200 || !r.json) {
        paneError(errorOf(r, '방 목록을 불러오지 못했습니다.'));
        emptyRow(tb, 6, '불러오지 못했습니다.');
        return;
      }
      paneError('');
      $('roomsHint').textContent = r.json.pending
        ? r.json.note
        : '대전 방은 서버 메모리에만 있습니다. 서버를 다시 띄우면 목록이 비워집니다.';
      var items = r.json.items || [];
      if (!items.length) {
        emptyRow(tb, 6, r.json.pending ? '준비 중입니다.' : '열린 방이 없습니다.');
        return;
      }
      items.forEach(function (m) {
        var tr = document.createElement('tr');
        cell(tr, m.id);
        cell(tr, m.name, 'admin-wrap');
        var td = document.createElement('td');
        td.appendChild(el('span', 'admin-badge live', ROOM_STATE[m.state] || m.state || '?'));
        tr.appendChild(td);
        cell(tr, m.hostUserId == null ? null : '#' + m.hostUserId);
        cell(tr, fmtNum(m.players), 'admin-num');
        cell(tr, fmtTime(m.createdAt), 'admin-when');
        tb.appendChild(tr);
      });
    });
  }

  // ------------------------------------------------------------------ 탭

  var LOADERS = {
    overview: loadOverview,
    users: loadUsers,
    matches: loadMatches,
    study: loadStudy,
    reports: loadReports,
    rooms: loadRooms,
  };

  function selectTab(name) {
    if (!LOADERS[name]) return;
    view.tab = name;
    var tabs = document.querySelectorAll('.admin-tab');
    for (var i = 0; i < tabs.length; i += 1) {
      var on = tabs[i].getAttribute('data-tab') === name;
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var panes = document.querySelectorAll('.admin-pane');
    for (var j = 0; j < panes.length; j += 1) {
      panes[j].hidden = panes[j].id !== 'pane-' + name;
    }
    paneError('');
    LOADERS[name]();
  }

  // ---------------------------------------------------------------- 배선

  function bind() {
    $('loginForm').addEventListener('submit', function (e) {
      e.preventDefault(); // Enter 로도 여기 온다
      var btn = $('loginBtn');
      btn.disabled = true;
      $('loginError').textContent = '';
      api('POST', '/api/admin/login', { id: $('adminId').value, password: $('adminPw').value })
        .then(function (r) {
          btn.disabled = false;
          if (r.status === 200 && r.json && r.json.ok) {
            $('adminPw').value = '';
            showDash();
            selectTab('overview');
            return;
          }
          $('loginError').textContent = errorOf(r, '로그인에 실패했습니다.');
          $('adminPw').focus();
        })
        .catch(function () {
          btn.disabled = false;
          $('loginError').textContent = '서버에 연결하지 못했습니다.';
        });
    });

    $('logoutBtn').addEventListener('click', function () {
      api('POST', '/api/admin/logout').then(function () {
        $('adminPw').value = '';
        showLogin('로그아웃했습니다.');
      });
    });

    $('refreshBtn').addEventListener('click', function () {
      var fn = LOADERS[view.tab];
      if (fn) fn();
    });

    var tabs = document.querySelectorAll('.admin-tab');
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].addEventListener('click', function (e) {
        selectTab(e.currentTarget.getAttribute('data-tab'));
      });
    }

    $('userSearchForm').addEventListener('submit', function (e) {
      e.preventDefault();
      view.users.q = $('userSearch').value.trim();
      view.users.offset = 0;
      loadUsers();
    });

    $('userSearchClear').addEventListener('click', function () {
      $('userSearch').value = '';
      view.users.q = '';
      view.users.offset = 0;
      loadUsers();
    });

    $('studyFilterForm').addEventListener('submit', function (e) {
      e.preventDefault();
      view.study.userId = $('studyUser').value.trim();
      view.study.offset = 0;
      loadStudy();
    });

    $('studyFilterClear').addEventListener('click', function () {
      $('studyUser').value = '';
      view.study.userId = '';
      view.study.offset = 0;
      loadStudy();
    });
  }

  function boot() {
    bind();
    api('GET', '/api/admin/me').then(function (r) {
      if (r.status === 200 && r.json && r.json.ok) {
        showDash();
        selectTab('overview');
      } else {
        showLogin('');
      }
    }).catch(function () {
      showLogin('서버에 연결하지 못했습니다.');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
