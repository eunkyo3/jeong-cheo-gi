'use strict';
/**
 * logger.js — 서버 공용 로거.
 *
 * 한 사건 = 한 줄. 타임스탬프는 로컬 시각 HH:MM:SS (index.js 가 쓰던 형식 그대로다).
 * 서버 모듈은 `console.log`/`console.error` 를 직접 부르지 않고 여기를 거친다 —
 * 형식이 한 곳에만 있어야 나중에 파일 로깅·레벨 조정이 한 줄로 끝난다.
 *
 *   log(...)      정보 → stdout
 *   logErr(...)   오류 → stderr
 *   logDebug(...) 상세 → stdout, **LOG_LEVEL=debug 일 때만**
 *
 * `logDebug` 는 매 호출마다 env 를 읽는다(기동 후 바꿔도 먹는다). 문자열 조립은
 * 레벨 검사 **뒤에** 하므로 꺼져 있을 때의 비용은 비교 한 번이다.
 *
 * battle-io.js 처럼 `ctx` 로 로거를 받는 모듈은 index.js 가 이 세 함수를 그대로 실어 준다.
 */

/** 로컬 시각 HH:MM:SS. */
function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

/** LOG_LEVEL=debug 인가. 대소문자·공백은 무시한다. */
function isDebug() {
  return String(process.env.LOG_LEVEL || '').trim().toLowerCase() === 'debug';
}

function log(...parts) {
  console.log('[' + stamp() + '] ' + parts.join(' '));
}

function logErr(...parts) {
  console.error('[' + stamp() + '] ' + parts.join(' '));
}

/** 상세 로그. LOG_LEVEL=debug 가 아니면 아무 일도 하지 않는다. */
function logDebug(...parts) {
  if (!isDebug()) return;
  console.log('[' + stamp() + '] ' + parts.join(' '));
}

module.exports = {
  log: log,
  logErr: logErr,
  logDebug: logDebug,
  isDebug: isDebug,
};
