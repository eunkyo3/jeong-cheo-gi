'use strict';
/**
 * ranking.js — 전적 집계.
 *
 * db 어댑터는 raw row 만 반환한다(집계·정렬 없음). 이 파일이 그 raw row 위에서
 * 순수 JS 로 집계한다. I/O 는 db 어댑터 호출뿐이며 그 외 부수효과는 없다.
 *
 * 규칙 (SCHEMA.md / PROTOCOL.md — 동결):
 *   - 매치당 1등 +3점, 그 외 참가 +1점.
 *   - 무승부 매치(`winner_user_id` NULL)는 1등 없이 전원 +1점.
 *   - 표시 컬럼: 순위 · 닉네임 · 승 · 무 · 패(= 참가 − 승 − 무) · 승점.
 *   - 정렬: 승점 desc → 승수 desc → 닉네임 asc.
 */

const WIN_POINTS = 3;
const PARTICIPATION_POINTS = 1;

/**
 * 닉네임 정렬 비교자. 한글 정렬을 위해 ko 로케일을 쓰되,
 * 로케일 데이터가 없는 런타임에서도 결정적으로 동작하도록 코드포인트 비교로 폴백한다.
 */
function compareNickname(a, b) {
  const x = a == null ? '' : String(a);
  const y = b == null ? '' : String(b);
  try {
    const c = x.localeCompare(y, 'ko');
    if (c !== 0) return c;
  } catch {
    /* localeCompare 실패 시 아래 코드포인트 비교로 폴백 */
  }
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

/**
 * 사용자별 누계 슬롯. listUsers() 에 없는 user_id 가 match_players 에 있어도
 * (수동 편집·마이그레이션 잔재) 집계가 깨지지 않도록 지연 생성한다.
 */
function slotFor(byUser, userId, nicknames) {
  let s = byUser.get(userId);
  if (!s) {
    s = {
      userId,
      nickname: nicknames.has(userId) ? nicknames.get(userId) : '사용자#' + userId,
      wins: 0,
      draws: 0,
      losses: 0,
      points: 0,
      played: 0,
    };
    byUser.set(userId, s);
  }
  return s;
}

/**
 * computeRanking(db) → [{rank,userId,nickname,wins,draws,losses,points,played}]
 *
 * 매치가 한 건도 없으면 전 사용자가 0전 0점으로 나열된다(빈 배열이 아니다).
 * 사용자도 매치도 없으면 빈 배열.
 */
function computeRanking(db) {
  const users = db.listUsers() || [];
  const matches = db.listMatches() || [];
  const players = db.listMatchPlayers() || [];

  const nicknames = new Map();
  for (const u of users) nicknames.set(u.id, u.nickname);

  // 사용자는 전원 등재한다 — 대전 이력이 없어도 0전 0점으로 표에 나와야 한다.
  const byUser = new Map();
  for (const u of users) slotFor(byUser, u.id, nicknames);

  // 매치별 참가자 목록. (match_id, user_id) 중복 행은 방어적으로 제거한다
  // (sqlite 는 PK 로 막지만 json 어댑터는 막지 않는다).
  const roster = new Map();
  for (const p of players) {
    let set = roster.get(p.match_id);
    if (!set) { set = new Set(); roster.set(p.match_id, set); }
    set.add(p.user_id);
  }

  for (const m of matches) {
    const participants = roster.get(m.id);
    if (!participants || participants.size === 0) continue; // 참가자 없는 매치는 집계 대상 아님

    const winnerId = m.winner_user_id == null ? null : m.winner_user_id;
    // winner_user_id 가 그 매치의 참가자가 아니면(데이터 손상) 1등 가산 없이 참가만 인정한다.
    const hasWinner = winnerId != null && participants.has(winnerId);
    const isDraw = winnerId == null;

    for (const userId of participants) {
      const s = slotFor(byUser, userId, nicknames);
      s.played += 1;
      if (hasWinner && userId === winnerId) {
        s.wins += 1;
        s.points += WIN_POINTS;
      } else {
        if (isDraw) s.draws += 1;
        s.points += PARTICIPATION_POINTS;
      }
    }
  }

  const rows = Array.from(byUser.values());
  for (const r of rows) r.losses = r.played - r.wins - r.draws; // 패 = 참가 − 승 − 무

  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return compareNickname(a.nickname, b.nickname);
  });

  // 동순위: 승점·승수가 같으면 같은 순위를 부여하고 그만큼 다음 순위를 건너뛴다(1,2,2,4).
  // 닉네임은 표시 순서를 정하는 tiebreaker 일 뿐 순위를 가르지 않는다.
  let rank = 0;
  let prev = null;
  rows.forEach((r, i) => {
    if (prev === null || prev.points !== r.points || prev.wins !== r.wins) rank = i + 1;
    r.rank = rank;
    prev = r;
  });

  return rows.map(r => ({
    rank: r.rank,
    userId: r.userId,
    nickname: r.nickname,
    wins: r.wins,
    draws: r.draws,
    losses: r.losses,
    points: r.points,
    played: r.played,
  }));
}

module.exports = { computeRanking, WIN_POINTS, PARTICIPATION_POINTS };
