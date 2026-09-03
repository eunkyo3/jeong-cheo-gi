'use strict';
/**
 * battlelock.js — "이 문항은 지금 이 사용자의 대전에 걸려 있는가".
 *
 * 정답 표기(`display`)와 해설을 내보내는 경로는 **전부** 이걸 통과해야 한다. 한 곳이라도
 * 빠지면 그 경로가 대전 중 정답 오라클이 된다 — 실제로 그렇게 뚫렸다(Phase 3 재검토):
 * 채점 라우트에는 잠금이 있었는데 `GET /api/me/wrong/explain` 에는 없어서, 예전에 학습 모드로
 * 한 번 채점해 둔 회차로 대전을 시작하면 그 회차 전 문항의 정답을 대전 중에 받아낼 수 있었다.
 *
 * 그래서 판정은 **여기 한 곳**에만 있다. 라우트가 각자 자기 사본을 들고 있으면 다음 경로가
 * 추가될 때 또 어긋난다.
 *
 * 판정 근거는 `ctx.battleIo.activeBattleQuestionIds(userId)` 다(battle-io 소관) —
 * `playing` 상태이고 그 사용자가 **아직 제출하지 않은** 방의 문항 id 집합이거나 null.
 *
 * `battle-io` 가 붙지 않은 기동(소켓 없이 띄운 경우)이나 조회 실패는 **막지 않는다**.
 * 이건 부가 방어벽이고, 정답 유출의 1차 방어선은 로그인·세트 토큰·채점 이력 검사다.
 */

/**
 * create(ctx) → { activeIds, blocks }
 * @param {{battleIo?:object, logErr?:function}} ctx 라우트가 받는 그 ctx 를 그대로 넘기면 된다.
 */
function create(ctx) {
  const logErr = ctx && typeof ctx.logErr === 'function' ? ctx.logErr : function () {};

  /**
   * 지금 이 사용자의 대전에 걸린 문항 id 집합. 잠긴 게 없거나 알 수 없으면 **null**.
   * 절대 던지지 않는다 — 조회가 깨져도 라우트는 제 일을 해야 한다.
   * @returns {Set<string>|null}
   */
  function activeIds(userId) {
    const io = ctx && ctx.battleIo;
    if (!io || typeof io.activeBattleQuestionIds !== 'function') return null;
    let active = null;
    try {
      active = io.activeBattleQuestionIds(userId);
    } catch (e) {
      logErr('대전 문항 조회 실패', '#' + userId, '-', e.message);
      return null;
    }
    if (!active || typeof active.has !== 'function' || active.size === 0) return null;
    return active;
  }

  /** 요청한 문항 중 **하나라도** 대전에 걸려 있는가. 채점처럼 집합을 통째로 거절하는 경로용. */
  function blocks(userId, questionIds) {
    const active = activeIds(userId);
    if (!active) return false;
    for (const qid of questionIds) if (active.has(qid)) return true;
    return false;
  }

  return { activeIds: activeIds, blocks: blocks };
}

module.exports = { create: create };
