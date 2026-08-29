/**
 * grader.test.mjs — 동결 채점 엔진(server/grader.js) 단위/회귀 테스트
 *
 * 실행: npm test  (= node --test tests/)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  gradeQuestion,
  gradeSet,
  normalizeValue,
  fieldAccepts,
  runValidator,
  ipToInt,
  NORMALIZE_MODES,
  VALIDATOR_TYPES,
} = require(path.join(ROOT, 'server', 'grader.js'));

// ------------------------------------------------------------------ 헬퍼

/** ordered 단일/다중 필드 문항을 만든다. */
function orderedQ(fields, id = 'T#1') {
  return {
    id,
    num: 1,
    prompt: '',
    bodyHtml: '',
    bodyText: '',
    sourceImages: [],
    answerMode: 'ordered',
    fields,
    display: 'display',
  };
}

/** unordered 문항을 만든다. */
function unorderedQ(fields, id = 'T#2') {
  return { ...orderedQ(fields, id), answerMode: 'unordered' };
}

function field(accept, normalize = 'default', extra = {}) {
  return {
    label: '답',
    accept,
    normalize,
    validator: null,
    sampleAnswer: accept[0] ?? '',
    ...extra,
  };
}

// ------------------------------------------------------------ 상수 계약

test('NORMALIZE_MODES / VALIDATOR_TYPES 는 동결 카탈로그를 그대로 노출한다', () => {
  assert.deepEqual([...NORMALIZE_MODES].sort(), ['default', 'keepSpace', 'sql']);
  // 카탈로그 확장 이력: ip-in-subnet (Phase 0) → keywords (2026-08-29, 서술형 8문항, 원칙 3 절차)
  assert.deepEqual(VALIDATOR_TYPES, ['ip-in-subnet', 'keywords']);
});

// ------------------------------------------------------ normalize: default

test('normalize default: 대소문자 무시', () => {
  assert.equal(normalizeValue('default', 'OSPF'), normalizeValue('default', 'ospf'));
  assert.equal(normalizeValue('default', 'Abstract Factory'), 'abstractfactory');
});

test('normalize default: 전(全) 공백 제거 (내부 공백 포함)', () => {
  assert.equal(normalizeValue('default', '  제 3 정규형  '), '제3정규형');
  assert.equal(normalizeValue('default', '\t동치\n분할 '), '동치분할');
});

test('normalize default: 후행 구두점 제거', () => {
  assert.equal(normalizeValue('default', '해시.'), '해시');
  assert.equal(normalizeValue('default', '해시,;:'), '해시');
  assert.equal(normalizeValue('default', '"해시"'), '"해시');
  // 후행만 제거한다 — 선행/중간 구두점은 남는다
  assert.equal(normalizeValue('default', '6.5ms'), '6.5ms');
});

test('normalize default: NFC 정규화 (분해형 한글 == 완성형 한글)', () => {
  const nfd = '\u1100\u1161'; // 초성 U+1100 + 중성 U+1161 — 분해형(NFD)
  const nfc = '\uAC00'; // U+AC00 — 완성형(NFC)
  assert.notEqual(nfd, nfc, '테스트 입력이 실제로 분해형이어야 한다');
  assert.equal(normalizeValue('default', nfd), normalizeValue('default', nfc));
  assert.equal(normalizeValue('default', nfd), nfc);

  // 채점 경로에서도 동일해야 한다
  const q = orderedQ([field(['가'])]);
  assert.equal(gradeQuestion(q, [nfd]).correct, true);
});

test('normalize default: 빈 입력은 무조건 오답', () => {
  const q = orderedQ([field(['ㄱ'])]);
  assert.equal(gradeQuestion(q, ['']).correct, false);
  assert.equal(gradeQuestion(q, ['   ']).correct, false);
  assert.equal(gradeQuestion(q, []).correct, false);
  assert.equal(gradeQuestion(q, [null]).correct, false);
});

// ---------------------------------------------------- normalize: keepSpace

test('normalize keepSpace: 내부 공백은 보존되고 유의미하다', () => {
  assert.equal(normalizeValue('keepSpace', 'a  b'), 'a  b');
  const f = field(['10a20b'], 'keepSpace');
  assert.equal(fieldAccepts(f, '10a20b'), true);
  assert.equal(fieldAccepts(f, '10 a 20 b'), false);
  assert.equal(fieldAccepts(f, '10a 20b'), false);
});

test('normalize keepSpace: 앞뒤 공백은 trim 된다', () => {
  assert.equal(normalizeValue('keepSpace', '  10a20b\n'), '10a20b');
  assert.equal(fieldAccepts(field(['10a20b'], 'keepSpace'), '  10a20b  '), true);
});

test('normalize keepSpace: 대소문자 구분 — accept 에 두 변형을 모두 나열해야 통과', () => {
  const strict = field(['CNNLRPYT'], 'keepSpace');
  assert.equal(fieldAccepts(strict, 'CNNLRPYT'), true);
  assert.equal(fieldAccepts(strict, 'cnnlrpyt'), false);

  const both = field(['CNNLRPYT', 'cnnlrpyt'], 'keepSpace');
  assert.equal(fieldAccepts(both, 'CNNLRPYT'), true);
  assert.equal(fieldAccepts(both, 'cnnlrpyt'), true);
  assert.equal(fieldAccepts(both, 'CnnLrpyt'), false);
});

// --------------------------------------------------------- normalize: sql

test('normalize sql: 연속 공백은 1칸으로 압축된다', () => {
  assert.equal(normalizeValue('sql', 'select  *   from\t학생'), 'select * from 학생');
  const f = field(['SELECT * FROM 학생'], 'sql');
  assert.equal(fieldAccepts(f, 'select   *    from     학생'), true);
  // 공백 자체가 사라지지는 않는다
  assert.equal(fieldAccepts(f, 'select*from학생'), false);
});

test('normalize sql: 후행 세미콜론/마침표/공백 제거', () => {
  assert.equal(normalizeValue('sql', 'select * from t;'), 'select * from t');
  assert.equal(normalizeValue('sql', 'select * from t . ; '), 'select * from t');
  assert.equal(normalizeValue('sql', 'select * from t;;'), 'select * from t');
});

test('normalize sql: 대소문자 무시', () => {
  const f = field(['SELECT * FROM 학생'], 'sql');
  assert.equal(fieldAccepts(f, 'SeLeCt * FrOm 학생;'), true);
});

// ------------------------------------------------------------- ordered

test('ordered: 필드 i ↔ answers[i] 매칭, 전부 맞아야 정답 (부분점수 없음)', () => {
  const q = orderedQ([field(['50']), field(['50']), field(['2']), field(['8'])]);
  const ok = gradeQuestion(q, ['50', '50', '2', '8']);
  assert.equal(ok.correct, true);
  assert.equal(ok.fieldResults.length, 4);
  assert.ok(ok.fieldResults.every((r) => r.correct));

  const bad = gradeQuestion(q, ['50', '50', '2', '9']);
  assert.equal(bad.correct, false, '한 필드만 틀려도 문항 전체가 오답');
  assert.deepEqual(bad.fieldResults.map((r) => r.correct), [true, true, true, false]);
});

test('ordered: 순서가 바뀌면 오답 (unordered 와 대비)', () => {
  const q = orderedQ([field(['구문']), field(['의미']), field(['순서'])]);
  assert.equal(gradeQuestion(q, ['구문', '의미', '순서']).correct, true);
  assert.equal(gradeQuestion(q, ['순서', '구문', '의미']).correct, false);
});

test('ordered: 결과에 questionId / label / given / display 가 실려 나온다', () => {
  const q = orderedQ([field(['ㄱ'])], 'X#7');
  const r = gradeQuestion(q, [' ㄱ ']);
  assert.equal(r.questionId, 'X#7');
  assert.equal(r.display, 'display');
  assert.equal(r.fieldResults[0].label, '답');
  assert.equal(r.fieldResults[0].given, ' ㄱ ', 'given 은 원문 그대로 돌려준다');
  assert.equal(r.fieldResults[0].fieldIndex, 0);
});

test('필드가 없는 문항은 오답 처리되고 예외를 던지지 않는다', () => {
  const r = gradeQuestion({ id: 'E#1', fields: [], answerMode: 'ordered', display: 'd' }, []);
  assert.equal(r.correct, false);
  assert.deepEqual(r.fieldResults, []);
});

// ----------------------------------------------------------- unordered

test('unordered: 역순으로 입력해도 전부 정답', () => {
  const q = unorderedQ([
    field(['구문', 'syntax']),
    field(['의미', 'semantics']),
    field(['순서', 'timing']),
  ]);
  const r = gradeQuestion(q, ['순서', '의미', '구문']);
  assert.equal(r.correct, true);
  assert.ok(r.fieldResults.every((x) => x.correct));
});

test('unordered: 중복 입력 규칙 — accept 가 겹쳐도 같은 답으로 두 칸을 채울 수 없다', () => {
  // 두 필드의 accept 집합이 완전히 겹친다
  const q = unorderedQ([field(['가용성', 'availability']), field(['가용성', 'availability'])]);
  const dup = gradeQuestion(q, ['가용성', '가용성']);
  assert.equal(dup.correct, false, '정규화 후 중복 제거 → 입력 수(1) < 필드 수(2)');

  // 표기만 다르고 정규화 결과가 같아도 중복이다
  assert.equal(gradeQuestion(q, ['가용성', ' 가 용 성 ']).correct, false);

  // 서로 다른 표현이면 통과한다
  assert.equal(gradeQuestion(q, ['가용성', 'availability']).correct, true);
});

test('unordered: 빈 슬롯이 하나라도 있으면 오답', () => {
  const q = unorderedQ([
    field(['구문', 'syntax']),
    field(['의미', 'semantics']),
    field(['순서', 'timing']),
  ]);
  assert.equal(gradeQuestion(q, ['구문', '의미', '']).correct, false);
  assert.equal(gradeQuestion(q, ['구문', '   ', '순서']).correct, false);
  assert.equal(gradeQuestion(q, ['구문', '의미']).correct, false);
});

test('unordered: 3필드 정답 집합을 뒤섞어 입력해도 정답', () => {
  const q = unorderedQ([
    field(['기밀성', 'confidentiality']),
    field(['무결성', 'integrity']),
    field(['가용성', 'availability']),
  ]);
  for (const input of [
    ['가용성', '기밀성', '무결성'],
    ['무결성', '가용성', '기밀성'],
    ['integrity', '가용성', 'confidentiality'],
  ]) {
    assert.equal(gradeQuestion(q, input).correct, true, `실패: ${JSON.stringify(input)}`);
  }
  // 하나가 틀리면 오답
  assert.equal(gradeQuestion(q, ['가용성', '기밀성', '부인방지']).correct, false);
});

test('unordered: 오답 표시는 사용자가 입력한 슬롯 기준으로 돌아온다', () => {
  const q = unorderedQ([
    field(['구문', 'syntax']),
    field(['의미', 'semantics']),
    field(['순서', 'timing']),
  ]);
  const r = gradeQuestion(q, ['순서', '헛소리', '구문']);
  assert.equal(r.correct, false);
  assert.deepEqual(r.fieldResults.map((x) => x.correct), [true, false, true]);
  assert.equal(r.fieldResults[1].given, '헛소리');
});

// ------------------------------------------------- validator: ip-in-subnet

test('ipToInt: 형식 파싱과 프리픽스 추출', () => {
  assert.deepEqual(ipToInt('192.168.35.72'), { val: 3232244552, prefix: null });
  assert.equal(ipToInt('192.168.35.72/24').prefix, 24);
  assert.equal(ipToInt('192.168.35'), null);
  assert.equal(ipToInt('192.168.35.256'), null, '옥텟 > 255');
  assert.equal(ipToInt('192.168.35.72/33'), null, '프리픽스 > 32');
  assert.equal(ipToInt('abc'), null);
});

test('ip-in-subnet 경계 벡터 (2026-2 Q10 (2): 192.168.35.0/24, exclude 192.168.35.3)', () => {
  const spec = { type: 'ip-in-subnet', cidr: '192.168.35.0/24', exclude: ['192.168.35.3'] };
  assert.equal(runValidator(spec, '192.168.35.0'), false, '네트워크 주소는 오답');
  assert.equal(runValidator(spec, '192.168.35.255'), false, '브로드캐스트 주소는 오답');
  assert.equal(runValidator(spec, '192.168.35.3'), false, '이미 제시된(exclude) 주소는 오답');
  assert.equal(runValidator(spec, '192.168.35.72'), true, '유효 호스트');
  assert.equal(runValidator(spec, '192.168.35.1'), true, '첫 호스트');
  assert.equal(runValidator(spec, '192.168.35.254'), true, '마지막 호스트');
  assert.equal(runValidator(spec, '192.168.35.72/24'), true, '프리픽스 일치');
  assert.equal(runValidator(spec, '192.168.35.72/25'), false, '프리픽스 불일치');
  assert.equal(runValidator(spec, '192.168.36.72'), false, '다른 네트워크');
  assert.equal(runValidator(spec, '192.168.35'), false, '형식 오류');
  assert.equal(runValidator(spec, '192.168.35.256'), false, '옥텟 > 255');
  assert.equal(runValidator(spec, ''), false);
});

test('ip-in-subnet 경계 벡터 (2026-2 Q10 (4): 129.200.8.0/22, exclude 129.200.10.72)', () => {
  const spec = { type: 'ip-in-subnet', cidr: '129.200.8.0/22', exclude: ['129.200.10.72'] };
  assert.equal(runValidator(spec, '129.200.8.0'), false, '네트워크 주소');
  assert.equal(runValidator(spec, '129.200.11.255'), false, '브로드캐스트 주소');
  assert.equal(runValidator(spec, '129.200.10.72'), false, 'exclude');
  assert.equal(runValidator(spec, '129.200.8.249'), true);
  assert.equal(runValidator(spec, '129.200.11.254'), true, '/22 대역 끝쪽 유효 호스트');
  assert.equal(runValidator(spec, '129.200.12.1'), false, '대역 밖');
  assert.equal(runValidator(spec, '129.200.8.249/22'), true);
  assert.equal(runValidator(spec, '129.200.8.249/24'), false, '프리픽스 불일치');
});

test('ip-in-subnet 경계 벡터 (2026-2 Q10 (5): 192.168.36.0/24, exclude 192.168.36.16)', () => {
  const spec = { type: 'ip-in-subnet', cidr: '192.168.36.0/24', exclude: ['192.168.36.16'] };
  assert.equal(runValidator(spec, '192.168.36.0'), false);
  assert.equal(runValidator(spec, '192.168.36.255'), false);
  assert.equal(runValidator(spec, '192.168.36.16'), false);
  assert.equal(runValidator(spec, '192.168.36.249'), true);
  assert.equal(runValidator(spec, '192.168.36.249/24'), true);
  assert.equal(runValidator(spec, '192.168.36.249/25'), false);
});

test('알 수 없는 validator.type / normalize 는 예외를 던진다', () => {
  assert.throws(() => runValidator({ type: 'nope' }, '1.2.3.4'), /unknown validator type/);
  assert.throws(() => normalizeValue('nope', 'x'), /unknown normalize mode/);
});

test('validator 배타 규칙: accept 를 무시하고 normalize 도 적용하지 않는다 (원문 trim 만)', () => {
  const f = {
    label: '(2)',
    // 배타 규칙 위반 데이터를 일부러 넣어도 채점은 validator 만 본다
    accept: ['아무말', '192.168.99.99'],
    normalize: 'default',
    validator: { type: 'ip-in-subnet', cidr: '192.168.35.0/24', exclude: ['192.168.35.3'] },
    sampleAnswer: '192.168.35.72',
  };
  assert.equal(fieldAccepts(f, '아무말'), false, 'accept 는 무시된다');
  assert.equal(fieldAccepts(f, '192.168.99.99'), false, 'accept 는 무시된다');
  assert.equal(fieldAccepts(f, '192.168.35.72'), true);
  assert.equal(fieldAccepts(f, '  192.168.35.72  '), true, '앞뒤 공백은 trim 된다');
  assert.equal(fieldAccepts(f, '192. 168.35.72'), false, '내부 공백은 제거되지 않는다 (normalize 미적용)');
  assert.equal(fieldAccepts(f, '192.168.35.72.'), false, '후행 구두점도 제거되지 않는다');
});

// ------------------------------------------------------------- gradeSet

test('gradeSet: 점수 = round(correct/total*100), 문항 수 무관', () => {
  const qs = [];
  for (let i = 1; i <= 7; i++) qs.push(orderedQ([field([String(i)])], `S#${i}`));
  const answers = { 'S#1': ['1'], 'S#2': ['2'], 'S#3': ['3'], 'S#4': ['x'], 'S#5': ['x'], 'S#6': ['x'], 'S#7': ['x'] };
  const r = gradeSet(qs, answers);
  assert.equal(r.totalCount, 7);
  assert.equal(r.correctCount, 3);
  assert.equal(r.score, 43, 'round(3/7*100) = 43');
  assert.equal(r.details.length, 7);
});

test('gradeSet: 20문항 만점 / 전멸', () => {
  const qs = [];
  const all = {};
  for (let i = 1; i <= 20; i++) {
    qs.push(orderedQ([field([String(i)])], `S#${i}`));
    all[`S#${i}`] = [String(i)];
  }
  assert.equal(gradeSet(qs, all).score, 100);
  assert.equal(gradeSet(qs, {}).score, 0);
});

test('gradeSet: 빈 문항 목록은 score 0, 예외 없음', () => {
  const r = gradeSet([], {});
  assert.equal(r.totalCount, 0);
  assert.equal(r.correctCount, 0);
  assert.equal(r.score, 0);
  assert.deepEqual(r.details, []);
});

test('gradeSet: answersMap 이 null/누락이어도 안전하다', () => {
  const qs = [orderedQ([field(['1'])], 'S#1')];
  assert.equal(gradeSet(qs, null).score, 0);
  assert.equal(gradeSet(qs, undefined).correctCount, 0);
});

// -------------------------------------------------- 실데이터 회귀 (2026-2)

const round20262 = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'data', 'rounds', '2026-2.json'), 'utf8')
);
const byNum = new Map(round20262.questions.map((q) => [q.num, q]));

test('실데이터 2026-2: 20문항', () => {
  assert.equal(round20262.round, '2026-2');
  assert.equal(round20262.questions.length, 20);
});

test('실데이터 2026-2: 전 문항 sampleAnswer 로 채점하면 100점', () => {
  const answers = {};
  for (const q of round20262.questions) answers[q.id] = q.fields.map((f) => f.sampleAnswer);
  const r = gradeSet(round20262.questions, answers);
  assert.equal(r.correctCount, 20);
  assert.equal(r.score, 100, `오답 문항: ${r.details.filter((d) => !d.correct).map((d) => d.questionId).join(', ')}`);
});

test('실데이터 2026-2: Q2/Q5/Q6 keepSpace 재분류가 공백 입력을 실제로 거부한다', () => {
  const q2 = byNum.get(2);
  assert.equal(q2.fields[0].normalize, 'keepSpace');
  assert.equal(gradeQuestion(q2, ['10a20b']).correct, true);
  assert.equal(gradeQuestion(q2, ['10 a 20 b']).correct, false);
  assert.equal(gradeQuestion(q2, ['10A20B']).correct, true, 'accept 에 대문자 변형이 나열되어 있다');

  const q5 = byNum.get(5);
  assert.equal(q5.fields[0].normalize, 'keepSpace');
  assert.equal(gradeQuestion(q5, ['CNNLRPYT']).correct, true);
  assert.equal(gradeQuestion(q5, ['C N N L R P Y T']).correct, false);

  const q6 = byNum.get(6);
  assert.equal(q6.fields[0].normalize, 'keepSpace');
  assert.equal(gradeQuestion(q6, ['_THIISING']).correct, true);
  assert.equal(gradeQuestion(q6, ['_ T H I I S I N G']).correct, false);
});

test('실데이터 2026-2: Q10 은 validator 3필드이며 accept 가 비어 있다', () => {
  const q10 = byNum.get(10);
  assert.equal(q10.fields.length, 3);
  for (const f of q10.fields) {
    assert.ok(f.validator, 'validator 필드여야 한다');
    assert.deepEqual(f.accept, [], 'validator 필드는 accept=[]');
    assert.ok(VALIDATOR_TYPES.includes(f.validator.type));
  }
  assert.equal(gradeQuestion(q10, ['192.168.35.72', '129.200.8.249', '192.168.36.249']).correct, true);
  // 각 슬롯의 네트워크 주소를 넣으면 오답
  assert.equal(gradeQuestion(q10, ['192.168.35.0', '129.200.8.249', '192.168.36.249']).correct, false);
});

test('실데이터 2026-2: default 문항은 공백·대소문자·후행 구두점을 흡수한다', () => {
  const q20 = byNum.get(20); // 제3정규형
  assert.equal(gradeQuestion(q20, [' 제 3 정규형. ']).correct, true);
  const q4 = byNum.get(4); // OSPF
  assert.equal(gradeQuestion(q4, ['ospf']).correct, true);
  assert.equal(gradeQuestion(q4, ['Open Shortest Path First']).correct, true);
});

// --------------------------------- Phase 0 게이트: 실제 unordered 표본 (2020-1 Q3)

test('Phase 0 게이트: 2020-1 Q3 형태(프로토콜의 기본 요소 3가지) unordered 표본', () => {
  const q = {
    id: '2020-1#3',
    num: 3,
    prompt: '프로토콜의 기본 요소 3가지를 쓰시오.',
    bodyHtml: '',
    bodyText: '프로토콜의 기본 요소 3가지를 쓰시오.',
    sourceImages: [],
    answerMode: 'unordered',
    fields: [
      { label: '①', accept: ['구문', 'syntax', '구문(syntax)'], normalize: 'default', validator: null, sampleAnswer: '구문' },
      { label: '②', accept: ['의미', 'semantics', '의미(semantics)'], normalize: 'default', validator: null, sampleAnswer: '의미' },
      { label: '③', accept: ['순서', 'timing', '타이밍', '순서(timing)'], normalize: 'default', validator: null, sampleAnswer: '순서' },
    ],
    display: '구문(Syntax), 의미(Semantics), 순서(Timing)',
  };

  // 순서를 섞어도 정답
  for (const input of [
    ['구문', '의미', '순서'],
    ['순서', '구문', '의미'],
    ['의미', '순서', '구문'],
    ['timing', 'syntax', 'semantics'],
    ['타이밍', '구문(Syntax)', '의미'],
  ]) {
    assert.equal(gradeQuestion(q, input).correct, true, `실패: ${JSON.stringify(input)}`);
  }

  // 같은 답을 세 번 치면 오답 (중복 제거 후 입력 1개 < 필드 3개)
  const dup = gradeQuestion(q, ['구문', '구문', '구문']);
  assert.equal(dup.correct, false);
  assert.equal(dup.fieldResults.filter((r) => r.correct).length, 1, '한 칸만 매칭된다');

  // 표기만 다른 동의어 중복도 오답
  assert.equal(gradeQuestion(q, ['구문', 'syntax', '순서']).correct, false, '구문/syntax 는 같은 필드만 채운다');

  // 두 개만 맞고 하나가 틀리면 오답
  assert.equal(gradeQuestion(q, ['구문', '의미', '흐름제어']).correct, false);
});

// ---------------------------------------------------------------- keywords validator (2026-08-29 카탈로그 확장, 원칙 3 절차)

test('keywords: all[] 키워드가 전부 포함되어야 정답 (서술형)', () => {
  const f = { label: '답', accept: [], normalize: 'default',
    validator: { type: 'keywords', all: ['무결성', '제약'] }, sampleAnswer: '무결성 제약조건' };
  assert.equal(fieldAccepts(f, '데이터의 무결성을 보장하는 제약 조건이다'), true);
  assert.equal(fieldAccepts(f, '무결성을 보장한다'), false);          // 제약 누락
  assert.equal(fieldAccepts(f, ''), false);
});

test('keywords: any[] 는 minAny 개 이상 포함되면 정답', () => {
  const f = { label: '답', accept: [], normalize: 'default',
    validator: { type: 'keywords', any: ['구문', '의미', '순서', '타이밍'], minAny: 2 }, sampleAnswer: '구문, 의미' };
  assert.equal(fieldAccepts(f, '구문과 의미'), true);
  assert.equal(fieldAccepts(f, '구문만 있음'), false);
  assert.equal(fieldAccepts(f, '순서(타이밍)'), true);
});

test('keywords: 입력과 키워드에 default 정규화가 동일 적용된다 (대소문자·공백·NFC)', () => {
  const f = { label: '답', accept: [], normalize: 'default',
    validator: { type: 'keywords', all: ['Hash Function'] }, sampleAnswer: 'hashfunction' };
  assert.equal(fieldAccepts(f, '일방향 HASH  FUNCTION 이다'), true);
  const nfd = '해시';   // "해시" NFD
  const g = { ...f, validator: { type: 'keywords', all: ['해시'] } };
  assert.equal(fieldAccepts(g, nfd + ' 함수'), true);
});

test('keywords: all+any 조합, minAny 기본값(any 있으면 1)', () => {
  const f = { label: '답', accept: [], normalize: 'default',
    validator: { type: 'keywords', all: ['삽입'], any: ['이상', '현상'] }, sampleAnswer: '삽입 이상' };
  assert.equal(fieldAccepts(f, '삽입 이상'), true);
  assert.equal(fieldAccepts(f, '삽입'), false);       // any 0개
  assert.equal(fieldAccepts(f, '이상 현상'), false);  // all 누락
});

test('keywords: 무조건 정답이 되는 빈 spec 은 예외', () => {
  assert.throws(() => runValidator({ type: 'keywords' }, 'x'), /all\[\] or any\[\]/);
  assert.throws(() => runValidator({ type: 'keywords', any: ['a'], minAny: 5 }, 'x'), /minAny/);
});

test('keywords: VALIDATOR_TYPES 카탈로그에 등재되어 있다', () => {
  assert.ok(VALIDATOR_TYPES.includes('keywords'));
  assert.ok(VALIDATOR_TYPES.includes('ip-in-subnet'));
});
