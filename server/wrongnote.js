'use strict';
/**
 * wrongnote.js — 학습 이력·오답노트 집계 (순수 로직 + db 바인딩).
 *
 * 원래 index.js 안에 있던 집계 함수들을 그대로 옮긴 것이고 동작은 바뀌지 않았다.
 *
 * 두 층으로 나뉜다.
 *   ① **순수 함수** — 이미 읽어 둔 행 배열만 보고 계산한다. `module.exports` 에 그대로 있다.
 *   ② **db 바인딩** — 실제 조회가 필요한 것들. `create({ db, logErr })` 로 만들어 쓴다.
 *      조회 실패는 전부 빈 결과로 다룬다(이력·오답노트는 부가 기능 — 500 을 내지 않는다).
 *
 * `create()` 가 돌려주는 객체에는 ①의 순수 함수도 같이 실려 있다 — 라우트가 한 객체만 들고 다니면 된다.
 */

const rounds = require('./rounds.js');
const dbModule = require('./db.js');

const HISTORY_SCAN_LIMIT = 1000;  // 집계를 위해 훑는 최대 기록 수

// ------------------------------------------------------------- ① 순수 함수

/** study_results 의 id 컬럼(JSON 문자열) → 배열. 값이 없거나 깨졌으면 null(= 문항 단위 정보 없음). */
function parseIdColumn(v) {
  if (typeof v !== 'string' || v === '') return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

/**
 * 현재 오답 문항 id 집합.
 * 문항별로 **가장 최근 판정**만 본다: 최신 기록부터 훑다가 그 문항을 처음 만나는 순간 결론이 나고
 * (wrong_ids 에 있으면 오답, question_ids 에만 있으면 해제) 그보다 오래된 기록은 무시한다.
 * question_ids 가 없는 예전 기록은 문항 단위 판정이 불가능하므로 건너뛴다.
 * 이미 읽어 둔 기록(최신 먼저)을 그대로 받는다 — 한 요청 안에서 이력을 여러 번 읽지 않기 위해서다.
 */
function wrongSetFromRows(rows) {
  const decided = new Set();
  const wrong = new Set();
  for (const row of rows) {
    const qids = parseIdColumn(row.question_ids);
    if (!qids) continue;
    const wrongSet = new Set(parseIdColumn(row.wrong_ids) || []);
    for (const qid of qids) {
      if (decided.has(qid)) continue;
      decided.add(qid);
      if (wrongSet.has(qid)) wrong.add(qid);
    }
  }
  return wrong;
}

/**
 * 오답 집합 → 회차 순(rounds 정렬) → 문항 순으로 정렬된 id 배열.
 * 지금 데이터에 없는 문항 id 는 빠진다(회차 파일이 바뀌어도 오답노트가 깨지지 않는다).
 */
function orderedWrongIds(wrong) {
  const ordered = [];
  for (const meta of rounds.listRounds()) {
    const round = rounds.getRound(meta.round);
    if (!round) continue;
    for (const q of round.questions) if (wrong.has(q.id)) ordered.push(q.id);
  }
  return ordered;
}

/**
 * 대전 학습 기록을 match_id 로 색인한다(매치 1건당 1행).
 * match_id 가 NULL 인 예전 행은 어느 대전인지 알 수 없으므로 빠진다 —
 * `scripts/backfill-battle-notes.mjs` 가 그런 행을 소급해 채운다.
 */
function battleStudyByMatch(rows) {
  const map = new Map();
  for (const row of rows) {
    if (row.round !== dbModule.BATTLE_ROUND) continue;
    if (row.match_id == null) continue;
    const mid = Number(row.match_id);
    if (map.has(mid)) continue; // 최신 먼저 — 처음 만난 행이 그 매치의 기록이다
    map.set(mid, row);
  }
  return map;
}

/** 나(userId) 기준 승/패/무. winner_user_id 가 NULL 이면 무승부다(SCHEMA "승자 판정 체인"). */
function matchResultOf(match, userId) {
  if (match.winner_user_id == null) return 'draw';
  return Number(match.winner_user_id) === Number(userId) ? 'win' : 'lose';
}

/**
 * 대전 한 건의 머리말 정보(문항 내용 없이).
 * `/api/me/wrong/summary` 의 byBattle 항목과 `/api/me/wrong?match=` 의 battle 블록이
 * 같은 모양을 쓰도록 한 곳에서 만든다. 상대의 보관 답안은 애초에 조회하지 않는다.
 */
function battleInfo(match, userId, studyRow) {
  const players = match.players || [];
  const me = players.find(function (p) { return Number(p.user_id) === Number(userId); }) || null;
  return {
    matchId: Number(match.id),
    roomName: match.room_name,
    finishedAt: match.finished_at,
    mode: match.mode,
    roundIds: parseIdColumn(match.round_ids) || [],
    questionCount: (parseIdColumn(match.question_ids) || []).length,
    me: {
      correctCount: me ? me.correct_count : null,
      score: studyRow ? studyRow.score : null,
    },
    opponents: players
      .filter(function (p) { return Number(p.user_id) !== Number(userId); })
      .map(function (p) {
        return { nickname: p.nickname == null ? '(알 수 없음)' : p.nickname, correctCount: p.correct_count };
      }),
    result: matchResultOf(match, userId),
  };
}

// ----------------------------------------------------------- ② db 바인딩

/**
 * db 를 물고 있는 조회기 묶음을 만든다.
 * @param {{db:object, logErr?:function}} ctx
 */
function create(ctx) {
  const db = ctx.db;
  const logErr = typeof ctx.logErr === 'function' ? ctx.logErr : function () {};

  /** 최신 먼저 정렬된 학습 기록. 조회 실패는 빈 이력으로 다룬다(이력은 부가 기능 — 500 을 내지 않는다). */
  function studyRows(userId) {
    try {
      return db.listStudyResults(userId, HISTORY_SCAN_LIMIT);
    } catch (e) {
      logErr('study 이력 조회 실패', '#' + userId, '-', e.message);
      return [];
    }
  }

  /**
   * 사용자가 **채점 기록을 가진** 문항 id 집합.
   * `wrongSetFromRows` 의 decided 집합과 **똑같은 규칙**이다(정오는 보지 않고 출제 여부만 본다):
   * question_ids 가 있는 기록만 세고, 없는 예전 기록은 문항 단위 판정이 불가능하므로 건너뛴다.
   *
   * `/api/me/wrong/explain` 의 권한 검사에 쓴다 — "이미 한 번 채점받은 문항"이라는 뜻이므로
   * 그 문항의 정답·해설을 다시 보여 줘도 채점 전 노출이 아니다(PROTOCOL.md C5 예외).
   */
  function gradedIdsOf(userId) {
    const decided = new Set();
    for (const row of studyRows(userId)) {
      const qids = parseIdColumn(row.question_ids);
      if (!qids) continue;
      for (const qid of qids) decided.add(qid);
    }
    return decided;
  }

  /** 현재 오답 문항 id 목록(회차 순). */
  function currentWrongIds(userId) {
    return orderedWrongIds(wrongSetFromRows(studyRows(userId)));
  }

  /** 내가 참가한 매치 목록. 조회 실패는 빈 목록으로 다룬다(이력과 같은 규칙 — 500 을 내지 않는다). */
  function matchRows(userId) {
    try {
      return db.listMatchesByUser(userId);
    } catch (e) {
      logErr('대전 목록 조회 실패', '#' + userId, '-', e.message);
      return [];
    }
  }

  return {
    HISTORY_SCAN_LIMIT: HISTORY_SCAN_LIMIT,
    // ① 순수 — 라우트가 한 객체만 들고 다니도록 같이 싣는다
    parseIdColumn: parseIdColumn,
    wrongSetFromRows: wrongSetFromRows,
    orderedWrongIds: orderedWrongIds,
    battleStudyByMatch: battleStudyByMatch,
    matchResultOf: matchResultOf,
    battleInfo: battleInfo,
    // ② db 바인딩
    studyRows: studyRows,
    gradedIdsOf: gradedIdsOf,
    currentWrongIds: currentWrongIds,
    matchRows: matchRows,
  };
}

module.exports = {
  HISTORY_SCAN_LIMIT: HISTORY_SCAN_LIMIT,
  parseIdColumn: parseIdColumn,
  wrongSetFromRows: wrongSetFromRows,
  orderedWrongIds: orderedWrongIds,
  battleStudyByMatch: battleStudyByMatch,
  matchResultOf: matchResultOf,
  battleInfo: battleInfo,
  create: create,
};
