#!/usr/bin/env node
/**
 * backfill-battle-notes.mjs — 대전 기록을 학습 이력·오답노트에 소급 적재한다 (1회성, 멱등).
 *
 * 배경: 대전 종료는 `matches` / `match_players` 만 남기고 `study_results` 는 남기지 않았다.
 * 그래서 대전만 한 사용자는 오답노트가 비어 있었다. 지금은 `db.saveMatch` 가 같은 트랜잭션에서
 * `study_results(round='battle')` 를 함께 쓰지만, **그 이전에 끝난 매치**는 이 스크립트로 메운다.
 *
 * 하는 일: 매치별로 `question_ids` 로 문항을 복원하고 참가자의 보관 답안(`match_players.answers`)을
 * `grader.gradeSet` 으로 재채점해 `study_results` 1행씩 넣는다. 채점 엔진이 순수 함수이므로
 * 그때의 답안에 대해 지금 규칙으로 다시 채점한 결과가 나온다(문항 데이터가 그 사이 수정됐다면 그 수정이 반영된다).
 *
 * 멱등성: 적재 행의 `taken_at` 은 **매치 종료 시각**(`matches.finished_at`)이다. 이미
 * (user, round='battle', taken_at=finished_at, question_ids 동일) 행이 있으면 새로 넣지 않는다.
 * `db.saveMatch` 도 같은 규약으로 쓰므로 신규 기록과도 겹치지 않는다. 몇 번 돌려도 안전하다.
 *
 * match_id: 신규 적재 행은 처음부터 매치 id 를 갖는다. 이미 있는 행 중 `match_id` 가 NULL 인 것은
 * 위와 같은 키로 매치를 찾아 UPDATE 로 채운다(오답노트를 대전 단위로 묶는 연결고리).
 * 이미 값이 있는 행은 건드리지 않으므로 이 단계도 몇 번 돌려도 안전하다.
 *
 * 실행:
 *   node scripts/backfill-battle-notes.mjs --dry-run     # 미리보기(쓰기 없음)
 *   node scripts/backfill-battle-notes.mjs               # 적재
 *   DATA_DIR=/tmp/copy node scripts/backfill-battle-notes.mjs   # 서버와 같은 DATA_DIR 규약
 *
 * DB 는 DATA_DIR(기본 repo `data/`), 회차 문항은 항상 repo `data/rounds/` 에서 읽는다 — 서버와 동일.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dbModule = require(path.join(ROOT, 'server', 'db.js'));
const rounds = require(path.join(ROOT, 'server', 'rounds.js'));
const { gradeSet } = require(path.join(ROOT, 'server', 'grader.js'));

const BATTLE_ROUND = dbModule.BATTLE_ROUND; // 'battle'
const STUDY_SCAN_LIMIT = 100000;            // 멱등 판정을 위해 유저별로 훑는 최대 기록 수
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('-n');

// ------------------------------------------------------------------- 유틸

/** JSON 배열 문자열 → 문자열 배열. 값이 없거나 깨졌으면 null. */
function parseIds(v) {
  if (typeof v !== 'string' || v === '') return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

/** answers 컬럼(JSON) → { questionId: string[] }. 깨졌으면 빈 맵(= 전 문항 오답으로 채점된다). */
function parseAnswers(v) {
  if (typeof v !== 'string' || v === '') return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** db.js 의 idsColumn 과 같은 표현 — 기존 행과 문자열 그대로 비교하기 위해 맞춘다. */
function idsColumn(ids) {
  return JSON.stringify(ids.map(String));
}

function wrongIdsOf(details) {
  const out = [];
  for (const d of details) if (d.correct === false) out.push(d.questionId);
  return out;
}

// ------------------------------------------------------------------- 본문

function main() {
  const db = dbModule.open({ dir: DATA_DIR });
  console.log('[backfill] DATA_DIR = ' + DATA_DIR + ' (어댑터: ' + db.kind + ')' + (DRY_RUN ? ' — DRY RUN' : ''));

  const summary = {
    matches: 0,
    matchesSkipped: 0,   // question_ids 로 문항을 하나도 복원하지 못한 매치
    players: 0,
    inserted: 0,
    linked: 0,           // 이미 있던 행에 match_id 만 채움
    duplicates: 0,       // 이미 같은 기록이 있고 match_id 도 있어 건너뜀
  };

  try {
    const matches = db.listMatches();
    // 유저별 기존 기록 캐시 — 같은 유저를 여러 매치에서 다시 조회하지 않는다.
    const seenByUser = new Map();

    /** (taken_at|question_ids) → 기존 battle 학습 기록 행. 같은 키가 여럿이면 최신 1건만 본다. */
    function existingRows(userId) {
      let map = seenByUser.get(userId);
      if (map) return map;
      map = new Map();
      for (const row of db.listStudyResults(userId, STUDY_SCAN_LIMIT)) {
        if (row.round !== BATTLE_ROUND) continue;
        const key = String(row.taken_at) + '|' + String(row.question_ids);
        if (!map.has(key)) map.set(key, row);
      }
      seenByUser.set(userId, map);
      return map;
    }

    for (const match of matches) {
      summary.matches++;
      const qids = parseIds(match.question_ids) || [];
      const questions = [];
      for (const qid of qids) {
        const q = rounds.getQuestion(qid);
        if (q) questions.push(q);
      }
      if (questions.length === 0) {
        summary.matchesSkipped++;
        console.warn('[backfill] 매치 #' + match.id + ' (' + match.room_name + ') 건너뜀 — ' +
          'question_ids 로 복원한 문항 0개 (' + qids.length + '개 요청)');
        continue;
      }
      if (questions.length !== qids.length) {
        console.warn('[backfill] 매치 #' + match.id + ': 문항 ' + qids.length + '개 중 ' +
          questions.length + '개만 현재 데이터에 있습니다 — 있는 것만 채점합니다.');
      }

      const resolvedIds = questions.map((q) => q.id);
      const idsJson = idsColumn(resolvedIds);
      const takenAt = match.finished_at;

      for (const player of db.listMatchPlayers(match.id)) {
        summary.players++;
        const rowsByKey = existingRows(player.user_id);
        const key = String(takenAt) + '|' + idsJson;
        const existing = rowsByKey.get(key);
        if (existing) {
          // 이미 있는 행 — 내용은 그대로 두고 비어 있는 match_id 만 채운다.
          if (existing.match_id != null) {
            summary.duplicates++;
            continue;
          }
          console.log('[backfill] 매치 #' + match.id + ' user#' + player.user_id +
            ' → 기존 기록 #' + existing.id + ' 에 match_id 연결' + (DRY_RUN ? ' [미적용]' : ''));
          if (!DRY_RUN) db.updateStudyMatchId(existing.id, match.id);
          existing.match_id = match.id; // 같은 실행 안에서 두 번 세지 않도록
          summary.linked++;
          continue;
        }

        const g = gradeSet(questions, parseAnswers(player.answers));
        const wrongIds = wrongIdsOf(g.details);
        console.log('[backfill] 매치 #' + match.id + ' user#' + player.user_id +
          ' → ' + g.correctCount + '/' + g.totalCount + ' (' + g.score + '점), 오답 ' + wrongIds.length + '문항' +
          (DRY_RUN ? ' [미적용]' : ''));
        if (!DRY_RUN) {
          db.saveStudyResult(player.user_id, BATTLE_ROUND, g.score, resolvedIds, wrongIds, takenAt, match.id);
        }
        // 같은 실행 안에서의 중복 삽입까지 막는다 (id 는 아직 모르지만 match_id 는 채워진 상태다)
        rowsByKey.set(key, { id: null, match_id: match.id });
        summary.inserted++;
      }
    }
  } finally {
    db.close();
  }

  console.log('');
  console.log('[backfill] 요약');
  console.log('  매치            : ' + summary.matches + '건 (문항 복원 실패로 건너뜀 ' + summary.matchesSkipped + '건)');
  console.log('  참가자 행       : ' + summary.players + '건');
  console.log('  이미 있어 건너뜀: ' + summary.duplicates + '건');
  console.log('  ' + (DRY_RUN ? 'match_id 연결 예정' : 'match_id 연결 완료') + ': ' + summary.linked + '건');
  console.log('  ' + (DRY_RUN ? '적재 예정      ' : '적재 완료      ') + ': ' + summary.inserted + '건 (round=' + BATTLE_ROUND + ')');
  if (DRY_RUN) console.log('  * --dry-run 이라 아무것도 쓰지 않았습니다.');
}

main();
