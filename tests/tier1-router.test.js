/**
 * Tier 1 — Router Classification Tests.
 *
 * 순수 함수 테스트: 키워드 분류, 버짓 선택, 채널 멘션 감지.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyRequest,
  classifyFunction,
  selectBudgetProfile,
  detectChannelMentions,
} = require('../src/core/router');

describe('classifyFunction — Keyword Classification', () => {
  it('should classify code-related text as "code"', () => {
    assert.equal(classifyFunction('PR 리뷰 부탁합니다'), 'code');
    assert.equal(classifyFunction('코드 리팩토링 해야합니다'), 'code');
    assert.equal(classifyFunction('deploy this branch'), 'code');
  });

  it('should classify ops-related text as "ops"', () => {
    assert.equal(classifyFunction('인시던트 발생했습니다'), 'ops');
    assert.equal(classifyFunction('alert 확인해주세요'), 'ops');
    assert.equal(classifyFunction('작업 할당 필요합니다'), 'ops');
  });

  it('should classify knowledge-related text as "knowledge"', () => {
    assert.equal(classifyFunction('문서 검색해주세요'), 'knowledge');
    assert.equal(classifyFunction('온보딩 위키 어디있어?'), 'knowledge');
    assert.equal(classifyFunction('컨벤션이 뭐였지?'), 'knowledge');
  });

  it('should return "general" for unclassifiable text', () => {
    assert.equal(classifyFunction('안녕하세요'), 'general');
    assert.equal(classifyFunction('좋은 아침입니다'), 'general');
    assert.equal(classifyFunction(''), 'general');
  });

  it('should handle null/undefined text gracefully', () => {
    assert.equal(classifyFunction(null), 'general');
    assert.equal(classifyFunction(undefined), 'general');
  });

  it('should pick highest-score category when multiple keywords match', () => {
    // "배포" matches both code and ops — whichever has more matches wins
    const result = classifyFunction('배포 deploy rollback 장애');
    // ops keywords: 배포, deploy, rollback, 장애 = 4
    // code keywords: deploy, 배포 = 2
    assert.equal(result, 'ops');
  });
});

describe('detectChannelMentions', () => {
  it('should detect Slack-format channel mentions', () => {
    const mentions = detectChannelMentions('참고: <#C01ABCDEF|general> 채널');
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].id, 'C01ABCDEF');
    assert.equal(mentions[0].name, 'general');
  });

  it('should detect multiple channel mentions', () => {
    const mentions = detectChannelMentions('<#C01AAA|eng> <#C02BBB|ops>');
    assert.equal(mentions.length, 2);
  });

  it('should handle channel mention without name', () => {
    const mentions = detectChannelMentions('<#C01ABCDEF>');
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].id, 'C01ABCDEF');
  });

  it('should return empty array when no mentions', () => {
    assert.deepEqual(detectChannelMentions('그냥 텍스트'), []);
  });
});

describe('selectBudgetProfile', () => {
  it('should return LIGHT for thread follow-ups', () => {
    assert.equal(selectBudgetProfile('mention', 'code', [], true), 'LIGHT');
  });

  it('should return LIGHT for commands', () => {
    assert.equal(selectBudgetProfile('command', 'general', [], false), 'LIGHT');
  });

  it('should return DEEP when channel mentions present', () => {
    assert.equal(selectBudgetProfile('mention', 'general', [{ id: 'C1' }], false), 'DEEP');
  });

  it('should return DEEP for code functionType', () => {
    assert.equal(selectBudgetProfile('mention', 'code', [], false), 'DEEP');
  });

  it('should return LIGHT for DM + general', () => {
    assert.equal(selectBudgetProfile('dm', 'general', [], false), 'LIGHT');
  });

  it('should return STANDARD as default', () => {
    assert.equal(selectBudgetProfile('channel', 'knowledge', [], false), 'STANDARD');
  });
});

describe('classifyRequest — Integration', () => {
  it('should return complete classification object', () => {
    const result = classifyRequest(
      { text: '코드 리뷰 해주세요 <#C01AAA|eng>', user: 'U1', channel: 'C2' },
      { isDM: false, isMention: true, isThreadFollowUp: false }
    );
    assert.equal(result.functionType, 'code');
    assert.equal(result.budgetProfile, 'DEEP');
    assert.ok(result.channelMentions.length >= 1);
  });

  it('should handle empty event gracefully', () => {
    const result = classifyRequest({ text: '' }, {});
    assert.equal(result.functionType, 'general');
    assert.ok(['LIGHT', 'STANDARD', 'DEEP'].includes(result.budgetProfile));
    assert.deepEqual(result.channelMentions, []);
  });
});
